/**
 * 微信登录相关的 HTTP 路由。
 *
 * 扫码登录要跨两个设备完成，所以中间必须有一步「服务端中转」：
 *
 *   桌面端                        服务端                       手机端（微信）
 *   ─────                        ──────                       ──────────
 *   点「微信登录」
 *   GET /wechat/start  ───────▶  建 state（随机串，5 分钟有效）
 *   ◀─── state + 授权地址
 *   画成二维码
 *                                扫码 ───────────────────────▶  打开授权页
 *                                                                  点「允许」
 *                                ◀─── 回调 ?code=…&state=… ──  微信重定向
 *                                code 换 access_token → openid
 *                                按 openid 找/建账号
 *   GET /wechat/status  ───────▶  已确认？签发会话 + Set-Cookie
 *   ◀─── confirmed + 用户信息
 *
 * 关键设计：
 * - state 是随机串，既是防伪 token 也是桌面端轮询的钥匙，猜不到。
 * - code 是一次性的，且由服务端换 token：前端拿到的 code 不能直接当登录凭证。
 * - 会话 Cookie 只在桌面端签发（手机端拿到的会话在手机上，没有意义）。
 * - 密码登录始终保留：微信侧故障、或管理员账号，都还需要它。
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { UserService } from '../domain/users.js';
import { WechatError, type WechatClient, type WechatProfile } from '../domain/wechat.js';
import { createSession, generateToken, hashToken, type AuthContext } from './auth.js';

/** 二维码有效期：5 分钟。微信的 code 本身也只在这一段时间内有效。 */
const STATE_TTL_MS = 5 * 60 * 1000;

/** 过期记录最多再留 10 分钟，方便排障，然后就删掉 */
const PURGE_AFTER_MS = 10 * 60 * 1000;

export interface PendingRow {
  state: string;
  purpose: string;
  status: string;
  user_id: string | null;
  error_code: string | null;
  session_token: string | null;
  issued_token: string | null;
  expires_at: string;
}

export interface WechatRouteDeps {
  app: FastifyInstance;
  db: Db;
  config: Config;
  users: UserService;
  client: WechatClient;
  /** 复用主鉴权中间件：会话 Cookie / Bearer PAT 都认 */
  authenticate: (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<AuthContext | null>;
}

/* --------------------------------------------------------------- 小工具 */

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 手机端看到的小页面。样式内联，不引外部资源——手机上不一定能连到本服务。 */
function mobilePage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f6f7f9;color:#1f2430;font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .card{background:#fff;border-radius:16px;padding:32px 28px;max-width:420px;text-align:center;
        box-shadow:0 8px 32px rgba(20,25,40,.08)}
  .ok{font-size:44px;line-height:1;margin-bottom:12px}
  h1{font-size:19px;margin:0 0 10px}
  p{margin:6px 0;color:#5b6478;font-size:14px}
  .en{color:#98a0b3;font-size:12px;margin-top:14px}
  code{background:#eef0f4;padding:2px 6px;border-radius:6px;font-size:13px}
  a{color:#2f6fed}
</style>
</head>
<body>
<div class="card">
${bodyHtml}
</div>
</body>
</html>`;
}

function nowPlus(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * 读请求体，兼容 JSON 对象与表单编码字符串。
 *
 * 为什么需要兼容字符串：服务器注册了
 * `addContentTypeParser('*', { parseAs: 'string' })`，
 * 所以 `application/x-www-form-urlencoded` 的 body 进来是**原始字符串**而不是对象。
 * 模拟授权页是个 HTML 表单，浏览器提交的就是表单编码——
 * 按对象读会拿到 undefined，授权流程直接断掉。
 */
function readFormBody(body: unknown): Record<string, string> {
  if (typeof body === 'string') {
    const out: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(body)) out[key] = value;
    return out;
  }
  if (body && typeof body === 'object') return body as Record<string, string>;
  return {};
}

/* --------------------------------------------------------------- 主模块 */

export function registerWechatRoutes(deps: WechatRouteDeps): void {
  const { app, db, config, users, client } = deps;

  /* ---------------------------------------------------- 登录方式查询（公开） */

  // 前端据此决定要不要显示「微信登录」入口。
  // 只暴露「有没有开、什么模式」，不暴露 AppID / Secret。
  app.get('/api/v1/auth/providers', async () => ({
    wechat: {
      enabled: true,
      mode: config.wechat.mode,
      mock: client.mock,
    },
  }));

  /* ---------------------------------------------------- 发起扫码 */

  /**
   * 发起扫码（登录）或绑定。
   *
   * purpose 由路由决定，不从请求体里读：
   * 绑定的语义是「把微信身份挂到当前这个账号上」，必须由服务端认定，
   * 让客户端在 body 里声明就等于让它自选身份——那是越权的口子。
   */
  const startHandler = (purpose: 'login' | 'bind') => async (req: FastifyRequest, reply: FastifyReply) => {
    let bindUserId: string | null = null;
    if (purpose === 'bind') {
      const ctx = (req as FastifyRequest & { auth?: AuthContext }).auth;
      if (!ctx) {
        return reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: '请先登录再绑定微信' } });
      }
      bindUserId = ctx.userId;
    }

    const state = randomBytes(32).toString('hex');
    const expiresAt = nowPlus(STATE_TTL_MS);
    await db.query(
      `insert into auth_pending_logins (state, purpose, status, user_id, expires_at)
       values ($1,$2,'pending',$3,$4)`,
      [state, purpose, bindUserId, expiresAt],
    );

    return {
      state,
      authorize_url: client.authorizeUrl(config.wechat.redirectUri, state),
      expires_at: expiresAt,
      purpose,
    };
  };

  app.get('/api/v1/auth/wechat/start', startHandler('login'));
  app.post('/api/v1/auth/wechat/bind/start', { preHandler: deps.authenticate }, startHandler('bind'));

  /* ---------------------------------------------------- 微信回调 */

  /**
   * 微信重定向到这里（带 code 与 state）。
   * 这条路由由手机端访问，所以只负责把状态确认好，登录结果由桌面端轮询取。
   */
  app.get('/api/v1/auth/wechat/callback', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const code = (query.code ?? '').trim();
    const state = (query.state ?? '').trim();

    if (!state) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          mobilePage(
            'AI Todo',
            `<div class="ok">⚠️</div><h1>参数缺失</h1><p>没有拿到 state，请回到电脑重新扫码。</p>`,
          ),
        );
    }

    try {
      const result = await completeWechatAuth({ db, config, users, client }, state, code);
      if (result.purpose === 'bind') {
        return reply
          .code(200)
          .type('text/html; charset=utf-8')
          .send(
            mobilePage(
              'AI Todo',
              `<div class="ok">✅</div>
               <h1>绑定成功</h1>
               <p>这个微信已经绑定到你的 AI Todo 账号。</p>
               <p>回到电脑即可继续使用。</p>
               <div class="en">Bound successfully. Go back to your computer.</div>`,
            ),
          );
      }
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(
          mobilePage(
            'AI Todo',
            `<div class="ok">✅</div>
             <h1>授权成功</h1>
             <p>请回到电脑，登录会自动完成。</p>
             <div class="en">Signed in. Return to your computer to continue.</div>`,
          ),
        );
    } catch (err) {
      const code2 = err instanceof WechatError ? err.code : 'wechat_login_failed';
      const detail =
        code2 === 'wechat_code_invalid'
          ? '这个二维码已经用过或已过期，请回到电脑重新扫码。'
          : code2 === 'wechat_state_expired'
            ? '二维码已过期，请回到电脑重新扫码。'
            : code2 === 'wechat_already_bound'
              ? '这个微信已经绑到别的账号了。'
              : '微信授权没有成功，请回到电脑重试。';
      app.log.warn(`微信回调失败：${code2}`);
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(
          mobilePage(
            'AI Todo',
            `<div class="ok">⚠️</div><h1>授权失败</h1><p>${escapeHtml(detail)}</p>
             <div class="en">Authorization failed. Please scan again on your computer.</div>`,
          ),
        );
    }
  });

  /* ---------------------------------------------------- 桌面端轮询 */

  app.get('/api/v1/auth/wechat/status', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const state = (query.state ?? '').trim();
    if (!state) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_argument', message: '缺少 state' } });
    }

    // 顺手清掉过期记录：明文会话令牌不该在库里过夜
    await db.query(`delete from auth_pending_logins where expires_at < $1`, [
      new Date(Date.now() - PURGE_AFTER_MS).toISOString(),
    ]);

    const res = await db.query<PendingRow>(
      `select state, purpose, status, user_id, error_code, session_token, issued_token, expires_at
         from auth_pending_logins where state = $1`,
      [state],
    );
    const row = res.rows[0];
    if (!row) return { status: 'unknown' };

    if (new Date(row.expires_at).getTime() < Date.now()) {
      if (row.status === 'pending') {
        await db.query(
          `update auth_pending_logins set status='expired', session_token=null, issued_token=null
            where state=$1`,
          [state],
        );
      }
      return { status: 'expired', purpose: row.purpose };
    }

    if (row.status === 'failed') {
      return { status: 'failed', purpose: row.purpose, error_code: row.error_code };
    }
    if (row.status !== 'confirmed' || !row.user_id) {
      return { status: 'pending', purpose: row.purpose };
    }

    const user = await users.findById(row.user_id);
    if (!user) {
      return { status: 'failed', purpose: row.purpose, error_code: 'wechat_account_disabled' };
    }

    // 绑定流程：账号本来就已登录，这里只回报「已绑定」
    if (row.purpose === 'bind') {
      return {
        status: 'confirmed',
        purpose: 'bind',
        user: {
          id: user.id,
          username: user.username,
          display_name: user.display_name,
          wechat_nickname: user.wechat_nickname,
        },
      };
    }

    // 登录流程：签发浏览器会话。token 缓存在 pending 行里，
    // 这样即使第一次响应丢了、浏览器重试一次，也还能拿到同一个会话。
    let sessionToken = row.session_token;
    if (!sessionToken) {
      const created = await createSession(db, user.id, config.sessionTtlDays);
      sessionToken = created.token;
      await db.query(`update auth_pending_logins set session_token = $2 where state = $1`, [
        state,
        sessionToken,
      ]);
    }
    reply.setCookie(config.cookieName, sessionToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.baseUrl.startsWith('https://'),
      expires: new Date(Date.now() + config.sessionTtlDays * 86_400_000),
    });

    return {
      status: 'confirmed',
      purpose: 'login',
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        wechat_nickname: user.wechat_nickname,
      },
      // 首次自动建号时签发的 MCP 令牌：明文只在这 5 分钟窗口内可见
      token: row.issued_token,
      token_name: row.issued_token ? '微信登录自动签发' : null,
    };
  });

  /* ---------------------------------------------------- 模拟授权页 */

  if (client.mock) {
    // 模拟模式：没有 AppID 时也能把整条链路跑通。
    // 生产环境务必不要开 AI_TODO_WECHAT_MOCK。
    app.get('/api/v1/auth/wechat/mock', async (req, reply) => {
      const query = (req.query ?? {}) as Record<string, string | undefined>;
      const state = (query.state ?? '').trim();
      if (!state) {
        return reply.code(400).type('text/html; charset=utf-8').send(
          mobilePage('AI Todo', `<div class="ok">⚠️</div><h1>参数缺失</h1>`),
        );
      }
      const suggest = `mock-${randomBytes(4).toString('hex')}`;
      const phoneHint = /^(https?:\/\/)(127\.0\.0\.1|localhost|\[::1\])/.test(config.baseUrl)
        ? '<p style="color:#b45309">提示：当前地址是 127.0.0.1，手机扫码会打不开。' +
          '请把 AI_TODO_BASE_URL 设成局域网地址（例如 http://192.168.1.20:8787）后重启服务。</p>'
        : '';
      return reply.code(200).type('text/html; charset=utf-8').send(
        mobilePage(
          'AI Todo · 模拟微信授权',
          `<div class="ok">🧪</div>
           <h1>模拟微信授权</h1>
           <p>这是本地模拟模式，不会真的请求微信。</p>
           ${phoneHint}
           <form method="post" action="/api/v1/auth/wechat/mock/confirm">
             <input type="hidden" name="state" value="${escapeHtml(state)}">
             <p><label>openid<br><input name="openid" value="${escapeHtml(suggest)}"
                 style="width:100%;padding:10px;border:1px solid #d8dce4;border-radius:8px"></label></p>
             <p><label>昵称<br><input name="nickname" value="模拟用户"
                 style="width:100%;padding:10px;border:1px solid #d8dce4;border-radius:8px"></label></p>
             <p><button type="submit"
                 style="width:100%;padding:12px;border:0;border-radius:8px;background:#07c160;color:#fff;font-size:15px">
                 允许登录</button></p>
           </form>
           <div class="en">Local mock mode. No request is sent to WeChat.</div>`,
        ),
      );
    });

    app.post('/api/v1/auth/wechat/mock/confirm', async (req, reply) => {
      // 表单提交是 urlencoded，body 是字符串；JSON 提交是对象——两种都要认
      const body = readFormBody(req.body);
      const state = (body.state ?? '').trim();
      const openid = (body.openid ?? '').trim();
      const nickname = (body.nickname ?? '').trim();
      if (!state || !openid) {
        return reply.code(400).type('text/html; charset=utf-8').send(
          mobilePage('AI Todo', `<div class="ok">⚠️</div><h1>参数缺失</h1>`),
        );
      }
      // 假 code 走的是和真回调完全一样的解析路径
      const code = `mock:${openid}|${nickname}`;
      try {
        const result = await completeWechatAuth({ db, config, users, client }, state, code);
        return reply.code(200).type('text/html; charset=utf-8').send(
          mobilePage(
            'AI Todo',
            `<div class="ok">✅</div><h1>授权成功</h1>
             <p>请回到电脑，登录会自动完成。</p>
             <div class="en">Signed in. Return to your computer to continue.</div>`,
          ),
        );
      } catch (err) {
        const code2 = err instanceof WechatError ? err.code : 'wechat_login_failed';
        app.log.warn(`模拟授权失败：${code2}`);
        return reply.code(400).type('text/html; charset=utf-8').send(
          mobilePage(
            'AI Todo',
            `<div class="ok">⚠️</div><h1>授权失败</h1>
             <p>${escapeHtml(code2)}</p>
             <div class="en">Authorization failed. Please try again.</div>`,
          ),
        );
      }
    });
  }
}

/* --------------------------------------------------------------- 核心逻辑 */

interface CompleteDeps {
  db: Db;
  config: Config;
  users: UserService;
  client: WechatClient;
}

/**
 * 完成一次微信授权：换 token → 找/建账号 → 标记 pending 为已确认。
 * 登录与绑定共用这段逻辑，差别只在 purpose。
 */
async function completeWechatAuth(
  deps: CompleteDeps,
  state: string,
  code: string,
): Promise<{ userId: string; purpose: string }> {
  const { db, config, users, client } = deps;

  const res = await db.query<PendingRow>(
    `select state, purpose, status, user_id, error_code, session_token, issued_token, expires_at
       from auth_pending_logins where state = $1`,
    [state],
  );
  const row = res.rows[0];
  if (!row) throw new WechatError('wechat_state_invalid', '登录请求不存在或已失效');

  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.query(
      `update auth_pending_logins set status='expired', session_token=null, issued_token=null
        where state=$1`,
      [state],
    );
    throw new WechatError('wechat_state_expired', '二维码已过期');
  }

  // 幂等：同一个 state 重复回调不会重复建号
  if (row.status === 'confirmed' && row.user_id) {
    return { userId: row.user_id, purpose: row.purpose };
  }
  if (row.status === 'failed') {
    throw new WechatError(row.error_code ?? 'wechat_login_failed', '登录失败');
  }

  let profile: WechatProfile;
  try {
    profile = await client.exchangeCode(code);
  } catch (err) {
    const errCode = err instanceof WechatError ? err.code : 'wechat_api_error';
    await db.query(
      `update auth_pending_logins set status='failed', error_code=$2 where state=$1`,
      [state, errCode],
    );
    throw err;
  }

  /* ---------------- 绑定：把微信身份挂到当前账号 ---------------- */
  if (row.purpose === 'bind') {
    if (!row.user_id) throw new WechatError('wechat_state_invalid', '绑定请求不完整');
    const owner = await users.findByWechatOpenid(profile.openid);
    if (owner && owner.id !== row.user_id) {
      await db.query(
        `update auth_pending_logins set status='failed', error_code=$2 where state=$1`,
        [state, 'wechat_already_bound'],
      );
      throw new WechatError('wechat_already_bound', '这个微信已经绑到别的账号了');
    }
    try {
      await users.linkWechat(row.user_id, {
        openid: profile.openid,
        unionid: profile.unionid,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
      });
    } catch (err) {
      const errCode = err instanceof WechatError ? err.code : String(err);
      await db.query(
        `update auth_pending_logins set status='failed', error_code=$2 where state=$1`,
        [state, errCode],
      );
      throw err;
    }
    await db.query(
      `update auth_pending_logins set status='confirmed', user_id=$2, session_token=null,
              issued_token=null where state=$1`,
      [state, row.user_id],
    );
    return { userId: row.user_id, purpose: 'bind' };
  }

  /* ---------------- 登录：找账号或自动建号 ---------------- */
  let user = await users.findByWechatOpenid(profile.openid);
  if (!user && profile.unionid) {
    // 同一开放平台下的多个应用：公众号登过、网站应用再登，是同一个人
    user = await users.findByWechatUnionid(profile.unionid);
  }

  let issuedToken: string | null = null;

  if (!user) {
    // 没有任何管理员时，第一个微信登录的人自动成为管理员——否则会锁死。
    const isAdmin =
      config.wechat.adminOpenids.includes(profile.openid) ||
      (await users.countAdmins()) === 0;
    try {
      user = await users.createWechatUser({
        openid: profile.openid,
        unionid: profile.unionid,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
        isAdmin,
      });
    } catch (err) {
      // 并发登录同一个微信号时，第二个请求会撞上 openid 唯一索引。
      // 这时候不是错误——账号已经被第一个请求建出来了，直接用它。
      const existing = await users.findByWechatOpenid(profile.openid);
      if (!existing) throw err;
      user = existing;
    }
    // 微信用户多半是来配 MCP 的：顺手发一枚令牌，省得再去设置里点一次
    if (config.wechat.autoIssueToken && !issuedToken) {
      issuedToken = await issuePat(db, user.id, '微信登录自动签发');
    }
  } else {
    // 刷新昵称头像（同一个微信用过之后改名、改头像都能同步过来）
    try {
      user = await users.linkWechat(user.id, {
        openid: profile.openid,
        unionid: profile.unionid,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
      });
    } catch (err) {
      const errCode = err instanceof WechatError ? err.code : String(err);
      await db.query(
        `update auth_pending_logins set status='failed', error_code=$2 where state=$1`,
        [state, errCode],
      );
      throw err;
    }
    // 白名单里的 openid 立即获得管理员权限：改完环境变量重启就生效
    if (config.wechat.adminOpenids.includes(profile.openid) && !user.is_admin) {
      await users.setAdmin(user.id, true);
      user = { ...user, is_admin: true };
    }
  }

  await db.query(
    `update auth_pending_logins set status='confirmed', user_id=$2, issued_token=$3
      where state=$1`,
    [state, user.id, issuedToken],
  );
  return { userId: user.id, purpose: 'login' };
}

/** 签发一枚访问令牌（PAT），返回明文 */
async function issuePat(db: Db, userId: string, name: string): Promise<string> {
  const token = generateToken('ait');
  await db.query(
    `insert into api_tokens (user_id, name, token, token_hash, scopes) values ($1,$2,$3,$4,$5)`,
    [userId, name, token, hashToken(token), ['tasks:read', 'tasks:write']],
  );
  return token;
}
