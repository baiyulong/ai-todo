/**
 * 微信登录（OAuth2）客户端封装。
 *
 * 为什么单独一层：微信的授权流程有两套入口（开放平台网站应用 / 公众号网页授权），
 * 但**换 token 与取用户信息的接口完全一样**：
 *
 *   GET https://api.weixin.qq.com/sns/oauth2/access_token
 *       ?appid=&secret=&code=&grant_type=authorization_code
 *   GET https://api.weixin.qq.com/sns/userinfo
 *       ?access_token=&openid=&lang=zh_CN
 *
 * 差别只在授权地址（qrconnect vs oauth2/authorize）与 scope。
 * 所以这里只实现一次换 token，模式由配置切换。
 *
 * 安全约束：
 * - AppID / AppSecret 只从环境变量读（见 src/config.ts），代码里不出现任何字面量。
 * - code 是一次性的、且由服务端去换 token：前端拿到的 code 不能直接当登录凭证。
 * - access_token 是微信侧的用户凭据，拿到后不落库、不回给前端。
 */

import type { WechatMode } from '../config.js';

/** 微信侧的用户身份 */
export interface WechatProfile {
  openid: string;
  unionid: string | null;
  nickname: string | null;
  avatarUrl: string | null;
}

/** 带机器可读错误码的微信异常：界面按 code 翻译，不依赖中文 message */
export class WechatError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'WechatError';
  }
}

export interface WechatClient {
  /** 授权地址：桌面端把它画成二维码，手机微信扫码后打开 */
  authorizeUrl(redirectUri: string, state: string): string;
  /** 用回调里的一次性 code 换取用户身份 */
  exchangeCode(code: string): Promise<WechatProfile>;
  /** 是否为模拟客户端（用于界面提示与测试） */
  readonly mock: boolean;
}

/* --------------------------------------------------------------- 真实客户端 */

interface WechatTokenResponse {
  access_token?: string;
  openid?: string;
  unionid?: string;
  expires_in?: number;
  errcode?: number;
  errmsg?: string;
}

interface WechatUserInfoResponse {
  openid?: string;
  unionid?: string;
  nickname?: string;
  headimgurl?: string;
  errcode?: number;
  errmsg?: string;
}

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * 带超时的 JSON 请求。
 * 不用 AbortSignal.timeout：DOM lib 里的签名与 Node 的略有出入，
 * 这里自己计时，行为在两端一致。
 */
async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new WechatError('wechat_api_error', `微信接口返回 HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof WechatError) throw err;
    // 超时 / DNS 失败 / 网络不可达
    throw new WechatError('wechat_api_error', '连接微信接口失败', String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** 微信的错误码 → 本项目的错误码 */
function mapWechatErrcode(errcode: number, errmsg: string): WechatError {
  // 40029 code 无效；40163 code 已被使用（重复回调）
  if (errcode === 40029 || errcode === 40163) {
    return new WechatError('wechat_code_invalid', `微信 code 无效：${errmsg}`, { errcode });
  }
  // 40001 / 40125 AppSecret 无效；45011 接口调用超过限制
  return new WechatError('wechat_api_error', `微信接口报错：${errmsg}`, { errcode });
}

export class RealWechatClient implements WechatClient {
  readonly mock = false;

  constructor(
    private readonly opts: { appId: string; appSecret: string; mode: WechatMode },
  ) {}

  authorizeUrl(redirectUri: string, state: string): string {
    // qrconnect   = 开放平台「网站应用」扫码登录，scope snsapi_login
    // oauth2/authorize = 公众号网页授权，scope snsapi_userinfo
    const base =
      this.opts.mode === 'official'
        ? 'https://open.weixin.qq.com/connect/oauth2/authorize'
        : 'https://open.weixin.qq.com/connect/qrconnect';
    const scope = this.opts.mode === 'official' ? 'snsapi_userinfo' : 'snsapi_login';
    const query = [
      `appid=${encodeURIComponent(this.opts.appId)}`,
      `redirect_uri=${encodeURIComponent(redirectUri)}`,
      'response_type=code',
      `scope=${scope}`,
      `state=${encodeURIComponent(state)}`,
    ].join('&');
    return `${base}?${query}#wechat_redirect`;
  }

  async exchangeCode(code: string): Promise<WechatProfile> {
    const url =
      'https://api.weixin.qq.com/sns/oauth2/access_token' +
      `?appid=${encodeURIComponent(this.opts.appId)}` +
      `&secret=${encodeURIComponent(this.opts.appSecret)}` +
      `&code=${encodeURIComponent(code)}` +
      '&grant_type=authorization_code';

    const token = (await fetchJson(url)) as WechatTokenResponse;
    if (typeof token.errcode === 'number' && token.errcode !== 0) {
      throw mapWechatErrcode(token.errcode, token.errmsg ?? '未知错误');
    }
    if (!token.access_token || !token.openid) {
      throw new WechatError('wechat_api_error', '微信未返回用户标识');
    }

    const profile: WechatProfile = {
      openid: token.openid,
      unionid: token.unionid ?? null,
      nickname: null,
      avatarUrl: null,
    };

    // 用户信息是锦上添花：拿不到昵称头像不该让整个登录失败。
    try {
      const infoUrl =
        'https://api.weixin.qq.com/sns/userinfo' +
        `?access_token=${encodeURIComponent(token.access_token)}` +
        `&openid=${encodeURIComponent(token.openid)}` +
        '&lang=zh_CN';
      const info = (await fetchJson(infoUrl)) as WechatUserInfoResponse;
      if (typeof info.errcode !== 'number' || info.errcode === 0) {
        profile.nickname = info.nickname ?? null;
        profile.avatarUrl = info.headimgurl ?? null;
        profile.unionid = info.unionid ?? profile.unionid;
      }
    } catch {
      /* 昵称头像拿不到，继续登录 */
    }

    return profile;
  }
}

/* --------------------------------------------------------------- 模拟客户端 */

/**
 * 模拟客户端：不连微信官方接口，用本地假 code 跑通整条链路。
 *
 * 存在的意义有两个：
 * 1. 没有 AppID 时也能把整套扫码 UI 走通、看清交互；
 * 2. 端到端测试可以确定性地跑完「发起 → 授权 → 回调 → 轮询 → 登录」全流程。
 *
 * 假 code 的格式：mock:<openid>|<nickname>。
 * 注意：这只是本地演示用的后门，生产环境务必不要打开 AI_TODO_WECHAT_MOCK。
 */
export class MockWechatClient implements WechatClient {
  readonly mock = true;

  constructor(private readonly opts: { baseUrl: string }) {}

  authorizeUrl(_redirectUri: string, state: string): string {
    // 指向本服务的模拟授权页：手机/桌面点开都能看到「授权」按钮
    return `${this.opts.baseUrl}/api/v1/auth/wechat/mock?state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(code: string): Promise<WechatProfile> {
    const raw = code.startsWith('mock:') ? code.slice(5) : '';
    const sep = raw.indexOf('|');
    const openid = sep >= 0 ? raw.slice(0, sep) : raw;
    const nickname = sep >= 0 ? raw.slice(sep + 1) : '';
    if (!openid) {
      throw new WechatError('wechat_code_invalid', '模拟 code 不合法');
    }
    return { openid, unionid: null, nickname: nickname || null, avatarUrl: null };
  }
}

/** 按配置构造客户端；没配 AppID 又没开模拟模式时返回 null（功能整体关闭） */
export function createWechatClient(opts: {
  enabled: boolean;
  mock: boolean;
  appId: string;
  appSecret: string;
  mode: WechatMode;
  baseUrl: string;
}): WechatClient | null {
  if (!opts.enabled) return null;
  if (opts.mock) return new MockWechatClient({ baseUrl: opts.baseUrl });
  return new RealWechatClient({ appId: opts.appId, appSecret: opts.appSecret, mode: opts.mode });
}
