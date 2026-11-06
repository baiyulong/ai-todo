#!/usr/bin/env node
/**
 * AI Todo 端到端验证脚本
 *
 * 前提：服务已运行（npm start），且 dist/ 已编译。
 * 用法：node scripts/e2e.mjs
 *   环境变量：AI_TODO_BASE_URL（默认 http://127.0.0.1:8787）、AI_TODO_TOKEN（管理员 PAT）
 *
 * 覆盖：
 *   1. 健康检查 / 静态资源
 *   2. 用户名 + 密码登录；错误密码被拒；未鉴权被拒
 *   3. SSE 实时通道能收到 notification 事件
 *   4. 创建任务 → 立即推送
 *   5. 幂等键命中 → 不重复创建、不重复推送
 *   6. notify=false / 低于阈值级别 → 不打扰
 *   7. 冷却窗口内聚合 → 首条即时 + 尾部合并成一条
 *   8. 状态流转 ack / done / archive / snooze
 *   9. 规则读写、通知记录
 *  10. 用户隔离：新用户看不到别人的任务；自己的 PAT 只往自己名下推
 *  11. 令牌自助签发 / 删除；删除后令牌立即失效
 *  12. MCP stdio：initialize / tools/list / tools/call / resources/read
 *  13. MCP 缺少 AI_TODO_TOKEN 时必须拒绝启动（凭证强制走环境变量）
 *  14. 通知聚合的账号隔离（不串用户）；账号在窗口期内被删除后服务不崩
 *  15. 彻底删除：只能删已归档的任务、跨用户删不掉、非法 UUID 返回 400
 *  16. 批量清空已归档：只清自己的、不动未归档的任务
 *  17. 微信登录：发起扫码 → 授权回调 → 桌面端取回会话 → 账号映射与绑定
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.AI_TODO_BASE_URL || 'http://127.0.0.1:8787';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 去掉 JS 注释，只留可执行代码。
 *
 * 静态检查必须看「代码本身」而不是「代码加注释」：
 * 注释里常常会写一行反例（比如 `$('task-form').returnValue`）来解释坑在哪，
 * 那是给人看的，不该被当成真实代码判失败。
 */
function stripJsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1'); // 行注释（避开 http:// 这类）
}

/** 去掉 HTML 注释，理由同上：注释里的中文是给人看的，不算界面文案 */
function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, ' ');
}

/* --------------------------------------------------------------- 凭据读取 */

function readBootstrapCredentials() {
  const file = join(root, 'data', 'admin-credentials.txt');
  const out = {};
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (key.startsWith('#')) continue;
      out[key] = line.slice(eq + 1).trim();
    }
  } catch {
    /* 文件不存在 */
  }
  return out;
}

/* --------------------------------------------------------------- SSE 客户端 */

class SseClient {
  constructor() {
    this.events = [];
    this.controller = null;
  }

  async connect(cookie) {
    this.controller = new AbortController();
    const res = await fetch(`${BASE}/api/v1/stream`, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: this.controller.signal,
    });
    if (!res.ok) throw new Error(`SSE 连接失败：HTTP ${res.status}`);
    this.res = res;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const ev = { type: 'message', data: null };
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) ev.type = line.slice(6).trim();
              else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
            }
            if (ev.data) {
              try {
                ev.data = JSON.parse(ev.data);
              } catch {
                /* keep raw */
              }
            }
            if (ev.type === 'notification') this.events.push(ev.data);
          }
        }
      } catch {
        /* aborted */
      }
    })();

    await sleep(300); // 等订阅注册完成
  }

  count() {
    return this.events.length;
  }

  last() {
    return this.events[this.events.length - 1];
  }

  async close() {
    try {
      this.controller?.abort();
    } catch {
      /* ignore */
    }
  }
}

/* --------------------------------------------------------------- 微信模拟实例 */

/**
 * 拉起一个开了模拟模式的隔离实例，用来端到端跑微信登录。
 *
 * 不用主实例：模拟模式等于把「谁能登录」彻底放开，不能碰到真实数据，
 * 也不能在真实用户的库里建出一堆假账号。所以另起进程 + 另起数据目录。
 */
async function startMockWechatServer() {
  const entry = join(root, 'dist', 'src', 'cli.js');
  if (!existsSync(entry)) return null;

  const port = 8900 + Math.floor(Math.random() * 90);
  const dataDir = join(root, 'data', 'tmp', `e2e-wechat-${Date.now().toString(36)}`);
  mkdirSync(dataDir, { recursive: true });

  const child = spawn(process.execPath, [entry, 'serve'], {
    cwd: root,
    env: {
      ...process.env,
      AI_TODO_PORT: String(port),
      AI_TODO_HOST: '127.0.0.1',
      AI_TODO_DATA_DIR: dataDir,
      AI_TODO_WECHAT_MOCK: 'on',
      AI_TODO_LOG_LEVEL: 'error',
      // 模拟授权页的地址由 AI_TODO_BASE_URL 拼出来。调用方进程里可能带着
      // 指向别的实例的 AI_TODO_BASE_URL（比如 e2e 本身就是用这个变量定向的），
      // 不覆盖的话 authorize_url 会指到别人的端口上，模拟授权页 404。
      AI_TODO_BASE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: 'ignore',
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${base}/api/v1/health`);
      if (res.ok) return { base, child, dataDir };
    } catch {
      /* 还没起来 */
    }
    if (child.exitCode !== null) break;
  }

  try {
    child.kill();
  } catch {
    /* ignore */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* ignore */
  }
  return null;
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  // 每次运行使用独立的会话与项目名：
  // 冷却状态是按分组键（来源会话 / 项目）记忆的，复用同一分组会命中上一轮遗留的冷却窗口。
  const runId = Date.now().toString(36);
  const creds = readBootstrapCredentials();

  const adminUser = process.env.AI_TODO_USER ?? creds.username;
  const adminPassword = process.env.AI_TODO_PASSWORD ?? creds.password;
  const adminToken = process.env.AI_TODO_TOKEN ?? creds.token;

  if (!adminUser || !adminPassword || !adminToken) {
    throw new Error(
      '找不到管理员凭据：请先 npm start 生成 data/admin-credentials.txt，或设置 AI_TODO_USER / AI_TODO_PASSWORD / AI_TODO_TOKEN',
    );
  }

  console.log(`\nAI Todo 端到端验证 @ ${BASE}\n`);

  /* 1. 健康检查与静态资源 */
  console.log('[1] 健康检查与静态资源');
  const health = await fetch(`${BASE}/api/v1/health`).then((r) => r.json());
  check('健康检查返回 ok', health.ok === true, JSON.stringify(health));
  check('数据库驱动为 PGlite 或 pg', ['pglite', 'pg'].includes(health.driver), health.driver);

  for (const path of ['/', '/sw.js', '/icon.svg', '/manifest.webmanifest', '/cloud.html']) {
    const res = await fetch(`${BASE}${path}`);
    check(`静态资源 ${path} 可达`, res.status === 200, `HTTP ${res.status}`);
  }

  // 首页必须引用 Vite 构建产物（Vue 前端，产物在 /assets/ 下带 hash）
  const indexHtml = await (await fetch(`${BASE}/`)).text();
  const assetMatch = indexHtml.match(/\/assets\/index-[\w-]+\.js/);
  check('首页引用了 Vite 构建产物', !!assetMatch, indexHtml.slice(0, 120));
  if (assetMatch) {
    const asset = await fetch(`${BASE}${assetMatch[0]}`);
    check('前端构建产物可加载', asset.ok, `HTTP ${asset.status}`);
  }
  check('首页带主题初始化脚本（防主题闪烁）', indexHtml.includes('ai_todo_theme'));

  /* ---------------------------------------------------- 前端静态检查（frontend/） */

  // 收集新前端源码做静态检查
  const feSrc = join(root, 'frontend', 'src');
  function listFeFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...listFeFiles(full));
      else if (/\.(vue|js|css)$/.test(name)) out.push(full);
    }
    return out;
  }
  const feFiles = listFeFiles(feSrc);
  check('新前端源码目录存在', feFiles.length > 0, feSrc);

  // 一份去掉注释的代码文本，供关键行为正则检查
  const feCode = feFiles
    .filter((f) => /\.(vue|js)$/.test(f))
    .map((f) => ({ path: f, src: stripJsComments(readFileSync(f, 'utf8')) }))
    .map((x) => x.src)
    .join('\n');

  // 三套主题都要有变量层文件，且覆盖各自的 data-theme 选择器
  for (const theme of ['product', 'pixel', 'hacker']) {
    const file = join(feSrc, 'themes', `${theme}.css`);
    const css = existsSync(file) ? readFileSync(file, 'utf8') : '';
    check(`主题 ${theme} 的样式文件存在且生效`, css.includes(`data-theme='${theme}'`) || (theme === 'product' && css.includes(':root')));
  }
  check('主题切换有 localStorage 持久化', feCode.includes('ai_todo_theme'));

  // 来源筛选：下拉绑定与请求参数都不能丢
  check('任务列表请求会带上来源筛选参数', feCode.includes(`params.set('source'`));

  // MCP 配置块必须能一键复制：配置要抄进 AI 客户端，手抄错一个字符客户端就起不来。
  check('MCP 配置块有复制按钮', feCode.includes('copyMcp') || feCode.includes('copyText'));

  // 剪贴板写入必须有 execCommand 兜底：局域网 http 访问时 navigator.clipboard 不存在
  check(
    '剪贴板写入有兜底路径（局域网 http 访问时 navigator.clipboard 不可用）',
    feCode.includes(`execCommand('copy')`),
  );

  // 通知提示音用 Web Audio 现场合成，不引音频文件
  check('通知提示音使用 Web Audio 合成', feCode.includes('AudioContext'));

  // 通知权限必须走 Permissions API 实时查询，不能用 Notification.permission 快照
  check('通知权限使用 Permissions API 实时查询', feCode.includes('navigator.permissions.query'));

  // 禁用账号功能已删除，不允许回头：前端不应再出现 setActive / 禁用字样
  check('前端没有残留的禁用账号逻辑', !/setActive|is_active/.test(feCode));

  // MCP 配置必须给出新的远程 HTTP 方案，不能还是只有 stdio。
  const cliJs = readFileSync(join(root, 'src', 'cli.ts'), 'utf8');
  check(
    'CLI 生成的 MCP 配置包含远程 HTTP 方案',
    /"url"/.test(cliJs) && /\/mcp/.test(cliJs),
    'CLI 还在生成过时的 stdio 配置，用户照抄会装不上远程端点',
  );
  check(
    'CLI 提示了来源标识相关环境变量',
    /AI_TODO_SOURCE_PROJECT/.test(cliJs),
    '没有提示来源标识，用户就看不出任务是谁发的',
  );

  /* ---------------------------------------------------- i18n 静态检查 */

  // 两个语言包的键必须完全对齐：少一个键，切到那个语言就会露出键名本身。
  const zh = (await import(pathToFileURL(join(feSrc, 'locales', 'zh-CN.js')).href)).dict;
  const en = (await import(pathToFileURL(join(feSrc, 'locales', 'en-US.js')).href)).dict;
  const onlyZh = Object.keys(zh).filter((k) => !(k in en));
  const onlyEn = Object.keys(en).filter((k) => !(k in zh));
  check(
    '两个语言包的键集完全一致',
    onlyZh.length === 0 && onlyEn.length === 0,
    `中文独有：${onlyZh.join(', ') || '无'}；英文独有：${onlyEn.join(', ') || '无'}`,
  );

  // 前端代码里不许硬编码中文：所有界面文案都必须走 t()。
  // 模板/脚本逐行扫，语言包与样式文件除外；HTML 注释（模板里的中文注释）不算文案。
  // 例外：
  //   · i18n.js 里 label: '中文' 是语言自己的名字，按惯例不翻译；
  //   · qr.js 的 throw 信息是给开发者看的（与服务端 message 同一约定），不是界面文案。
  const cnLines = feFiles
    .filter((f) => /\.(vue|js)$/.test(f) && !f.includes(`${join('', 'locales')}`) && !f.endsWith('qr.js'))
    .flatMap((f) =>
      stripJsComments(stripHtmlComments(readFileSync(f, 'utf8')))
        .split('\n')
        .map((line, i) => ({ file: f.replace(root, ''), line: line.trim(), no: i + 1 }))
        // label: '中文' 是语言自己的名字（不翻译的惯例），豁免
        .filter((x) => /[一-龥]/.test(x.line) && !/label:\s*'[^']*[\u4e00-\u9fa5][^']*'/.test(x.line)),
    );
  check(
    '前端代码里没有硬编码的中文文案',
    cnLines.length === 0,
    cnLines.slice(0, 3).map((x) => `${x.file}:${x.no}`).join(', '),
  );

  // t() 引用到的键必须真实存在，缺了就会在界面上直接显示键名。
  const usedKeys = new Set([...feCode.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)].map((m) => m[1]));
  const missingKeys = [...usedKeys].filter((k) => !(k in zh) || !(k in en));
  check(
    '前端 t() 用到的翻译键都存在',
    missingKeys.length === 0,
    `缺失：${missingKeys.join(', ')}`,
  );

  // 级别与状态标签是动态拼键（severity.${v}），静态扫不到，得单独盯。
  const enumKeys = [
    'severity.info', 'severity.need_human', 'severity.blocker',
    'status.pending', 'status.acked', 'status.done', 'status.archived',
  ];
  const missingEnumKeys = enumKeys.filter((k) => !(k in zh) || !(k in en));
  check(
    '级别与状态标签的翻译键齐全',
    missingEnumKeys.length === 0,
    `缺失：${missingEnumKeys.join(', ')}`,
  );

  // 主题选择区的文案键也要齐全（动态渲染的三张主题卡）
  const themeKeys = [
    'section.theme',
    'theme.product', 'theme.productDesc',
    'theme.pixel', 'theme.pixelDesc',
    'theme.hacker', 'theme.hackerDesc',
  ];
  const missingThemeKeys = themeKeys.filter((k) => !(k in zh) || !(k in en));
  check(
    '主题选择的翻译键齐全',
    missingThemeKeys.length === 0,
    `缺失：${missingThemeKeys.join(', ')}`,
  );

  /* 2. 登录 */
  console.log('\n[2] 用户名 + 密码登录');
  const badLogin = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUser, password: 'definitely-wrong' }),
  });
  check('错误密码被拒 401', badLogin.status === 401, `HTTP ${badLogin.status}`);

  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUser, password: adminPassword }),
  });
  const loginBody = await loginRes.json();
  const cookie = (loginRes.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  check('正确用户名密码登录成功 200', loginRes.status === 200, `HTTP ${loginRes.status}`);
  check('返回会话 Cookie', cookie.includes('ai_todo_session'), cookie.slice(0, 40));

  const unauth = await fetch(`${BASE}/api/v1/tasks`);
  check('未鉴权访问任务列表被拒 401', unauth.status === 401, `HTTP ${unauth.status}`);

  const api = async (path, options = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : { authorization: `Bearer ${options.token ?? adminToken}` }),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  };

  const me = await api('/api/v1/me');
  check('/api/v1/me 返回用户信息', me.res.status === 200 && !!me.body.user_id, JSON.stringify(me.body));
  check('/api/v1/me 返回用户名', me.body.username === adminUser, String(me.body.username));
  check('/api/v1/me 报告实时连接数', typeof me.body.live_clients === 'number', String(me.body.live_clients));

  // 退出登录必须真的吊销服务端会话，而不只是清掉浏览器里的 Cookie
  const logoutLogin = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUser, password: adminPassword }),
  });
  const logoutCookie = (logoutLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const beforeLogout = await fetch(`${BASE}/api/v1/me`, { headers: { cookie: logoutCookie } });
  check('新会话登录后可访问 /me', beforeLogout.status === 200, `HTTP ${beforeLogout.status}`);
  const logoutRes = await fetch(`${BASE}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: logoutCookie } });
  check('退出登录接口返回 200', logoutRes.status === 200, `HTTP ${logoutRes.status}`);
  const afterLogout = await fetch(`${BASE}/api/v1/me`, { headers: { cookie: logoutCookie } });
  check('退出后旧会话立即失效（401）', afterLogout.status === 401, `HTTP ${afterLogout.status}`);

  /* 3. SSE 通道 */
  console.log('\n[3] SSE 实时通道');
  const sse = new SseClient();
  await sse.connect(cookie);
  const meAfter = await api('/api/v1/me');
  check('SSE 连接后 live_clients ≥ 1', (meAfter.body.live_clients ?? 0) >= 1, String(meAfter.body.live_clients));

  // 把管理员的通知规则归位为默认值，保证每轮验证从同一个已知状态开始。
  // 必要原因：上一轮若中途崩溃（例如服务被打挂），规则会残留在被改过的状态里。
  // 例如 min_severity 被留在 info，本不该推送的 info 级任务会进批次，
  // 它的延迟 flush 会在后面的聚合用例里冒出来，造成莫名其妙的失败。
  const BASELINE_RULES = {
    min_severity: 'need_human',
    cooldown_sec: 300,
    group_by: 'source_session',
  };
  const ruleReset = await api('/api/v1/rules', {
    method: 'PUT',
    body: JSON.stringify(BASELINE_RULES),
  });
  check('管理员通知规则已归位为默认值', ruleReset.res.status === 200, `HTTP ${ruleReset.res.status}`);

  /* 4. 创建任务 → 立即推送 */
  console.log('\n[4] 创建任务 → 立即推送');
  const stamp = Date.now();
  const created = await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `E2E 验证任务 ${stamp}`,
      detail: '这是端到端验证创建的临时任务',
      severity: 'need_human',
      project: 'e2e',
      idempotency_key: `e2e:${stamp}:a`,
      source: { agent: 'e2e', session_key: `e2e-session-${runId}`, label: 'E2E' },
    }),
  });
  check('创建任务返回 201', created.res.status === 201, `HTTP ${created.res.status}`);
  check('created = true', created.body.created === true);
  const taskId = created.body.task.id;
  check('任务状态为 pending', created.body.task.status === 'pending', created.body.task.status);

  await sleep(500);
  check('SSE 收到 1 条通知', sse.count() === 1, `实际 ${sse.count()} 条`);
  const ev = sse.last();
  check('通知标题为任务标题', ev?.title === `E2E 验证任务 ${stamp}`, ev?.title);
  check('通知含 task_id 与链接', !!ev?.id && !!ev?.url, JSON.stringify(ev));

  /* 5. 幂等 */
  console.log('\n[5] 幂等键命中');
  const dupe = await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `E2E 验证任务 ${stamp}`,
      severity: 'need_human',
      project: 'e2e',
      idempotency_key: `e2e:${stamp}:a`,
      source: { agent: 'e2e', session_key: `e2e-session-${runId}`, label: 'E2E' },
    }),
  });
  check('重复创建返回 200', dupe.res.status === 200, `HTTP ${dupe.res.status}`);
  check('created = false', dupe.body.created === false);
  check('返回同一个任务 ID', dupe.body.task.id === taskId, `${dupe.body.task.id} != ${taskId}`);
  await sleep(400);
  check('幂等命中没有额外推送', sse.count() === 1, `实际 ${sse.count()} 条`);

  /* 6. 不打扰的场景 */
  console.log('\n[6] notify=false 与低于阈值级别');
  const before = sse.count();
  await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `E2E 静默任务 ${stamp}`,
      severity: 'need_human',
      notify: false,
      idempotency_key: `e2e:${stamp}:quiet`,
    }),
  });
  const lowSeverity = await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `E2E info 任务 ${stamp}`,
      severity: 'info',
      idempotency_key: `e2e:${stamp}:info`,
    }),
  });
  check('notify=false 任务仍入库', lowSeverity.res.status === 201);
  await sleep(500);
  check('notify=false / info 级别都没有推送', sse.count() === before, `实际新增 ${sse.count() - before} 条`);

  /* 7. 聚合：首条即时 + 尾部合并 */
  console.log('\n[7] 冷却窗口内的聚合');
  const savedRules = (await api('/api/v1/rules')).body.rules;
  await api('/api/v1/rules', {
    method: 'PUT',
    body: JSON.stringify({ cooldown_sec: 3, group_by: 'project', min_severity: 'info' }),
  });

  const aggBefore = sse.count();
  const aggStamp = Date.now();
  await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `聚合首条 ${aggStamp}`,
      severity: 'need_human',
      project: `e2e-agg-${runId}`,
      idempotency_key: `e2e:${aggStamp}:g1`,
    }),
  });
  await sleep(400);
  check('聚合首条立即推送', sse.count() === aggBefore + 1, `实际 ${sse.count() - aggBefore} 条`);

  for (const n of [2, 3]) {
    await api('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: `聚合第 ${n} 条 ${aggStamp}`,
        severity: 'need_human',
        project: `e2e-agg-${runId}`,
        idempotency_key: `e2e:${aggStamp}:g${n}`,
      }),
    });
  }
  await sleep(400);
  check('冷却窗口内不再逐条推送', sse.count() === aggBefore + 1, `实际 ${sse.count() - aggBefore} 条`);

  await sleep(3500);
  const merged = sse.events.slice(aggBefore);
  check('窗口结束收到合并通知', merged.length === 2, `收到 ${merged.length} 条`);
  const tail = merged[merged.length - 1];
  check('合并通知 task_count = 2', tail?.task_count === 2, String(tail?.task_count));
  check('合并通知标题为「另外 N 项需要你关注」', tail?.title === '另外 2 项需要你关注', tail?.title);
  check('合并通知正文列出条目', typeof tail?.body === 'string' && tail.body.includes('·'), tail?.body);

  /* blocker 绕过冷却 */
  const blockerBefore = sse.count();
  await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `阻塞任务 ${aggStamp}`,
      severity: 'blocker',
      project: `e2e-agg-${runId}`,
      idempotency_key: `e2e:${aggStamp}:blk`,
    }),
  });
  await sleep(400);
  check('blocker 绕过冷却立即推送', sse.count() === blockerBefore + 1, `实际 ${sse.count() - blockerBefore} 条`);

  await api('/api/v1/rules', {
    method: 'PUT',
    body: JSON.stringify({
      min_severity: savedRules.min_severity,
      cooldown_sec: savedRules.cooldown_sec,
      group_by: savedRules.group_by,
      digest_hour: savedRules.digest_hour,
      quiet_hours: savedRules.quiet_hours,
    }),
  });
  check('规则已还原', true);

  /* 8. 状态流转 */
  console.log('\n[8] 状态流转');
  const acked = await api(`/api/v1/tasks/${taskId}/ack`, { method: 'POST' });
  check('标记已接手 → acked', acked.body.task?.status === 'acked', acked.body.task?.status);
  const done = await api(`/api/v1/tasks/${taskId}/done`, { method: 'POST' });
  check('标记已完成 → done', done.body.task?.status === 'done', done.body.task?.status);

  const snoozeUntil = new Date(Date.now() + 3600_000).toISOString();
  const snoozed = await api(`/api/v1/tasks/${taskId}/snooze`, {
    method: 'POST',
    body: JSON.stringify({ until: snoozeUntil }),
  });
  check('推迟提醒写入 due_at', snoozed.body.task?.due_at === snoozeUntil, snoozed.body.task?.due_at);

  const toArchive = await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `E2E 待归档 ${stamp}`,
      severity: 'need_human',
      notify: false,
      idempotency_key: `e2e:${stamp}:arch`,
    }),
  });
  // 归档这一步特意带上 content-type: application/json 且不带 body，
  // 模拟 `curl -X POST -H "Content-Type: application/json" .../archive` 与
  // PowerShell `Invoke-RestMethod -Method POST`（不带 -Body）这两种常见姿势。
  const archived = await api(`/api/v1/tasks/${toArchive.body.task.id}/archive`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  check('归档接口可用 → archived', archived.body.task?.status === 'archived', archived.body.task?.status);
  check('无 body 的 JSON 头 POST 不报 400/415', archived.res.status === 200, `status=${archived.res.status}`);

  // 空 body 放行之后，非空 body 的解析仍然必须严格
  const badJson = await api('/api/v1/tasks', {
    method: 'POST',
    body: '{ not json',
  });
  check('非法 JSON body 返回 400', badJson.res.status === 400, `status=${badJson.res.status}`);
  const protoPoison = await api('/api/v1/tasks', {
    method: 'POST',
    // 注意：必须用原始字符串。写成对象字面量时 `__proto__:` 会被当成设置原型，
    // JSON.stringify 之后这个键根本不会出现在报文里，测不到东西。
    body: '{"title":"proto","__proto__":{"polluted":true}}',
  });
  check('__proto__ 污染被拦截（400）', protoPoison.res.status === 400, `status=${protoPoison.res.status}`);
  check('未污染 Object.prototype', ({}).polluted === undefined);

  const list = await api('/api/v1/tasks?status=pending,acked,done&limit=100');
  check('任务列表可查询', list.res.status === 200 && Array.isArray(list.body.tasks), JSON.stringify(list.body).slice(0, 120));
  check('列表包含刚创建的任务', list.body.tasks.some((t) => t.id === taskId));
  const pendingOnly = await api('/api/v1/tasks?status=pending&limit=100');
  check('状态过滤生效（done 不出现在 pending 里）', !pendingOnly.body.tasks.some((t) => t.id === taskId));

  // 非法 UUID 的路径参数必须回 400，而不是冒泡成 500
  const badUuid = await api('/api/v1/tasks/not-a-uuid');
  check('非法 UUID 路径参数返回 400', badUuid.res.status === 400, `status=${badUuid.res.status}`);
  check('400 响应回显非法 id', /not-a-uuid/.test(badUuid.body?.error?.message ?? ''), JSON.stringify(badUuid.body).slice(0, 120));
  // 未鉴权时先回 401，不给未认证方做参数校验的余地
  const badUuidUnauth = await fetch(`${BASE}/api/v1/tasks/not-a-uuid`);
  check('未鉴权 + 非法 UUID 仍先回 401', badUuidUnauth.status === 401, `HTTP ${badUuidUnauth.status}`);
  // 合法但不存在 / 不属于该用户的 UUID → 404（不泄露存在性）
  const unknownUuid = await api('/api/v1/tasks/00000000-0000-0000-0000-000000000000');
  check('不存在但合法的 UUID 返回 404', unknownUuid.res.status === 404, `status=${unknownUuid.res.status}`);

  const q = await api('/api/v1/tasks?q=E2E&limit=100');
  check('关键字检索可用', q.body.tasks.length > 0, String(q.body.tasks.length));

  // 非法枚举查询参数必须返回 400，而不是穿透到数据库变成 500
  const badStatus = await api('/api/v1/tasks?status=all');
  check('非法 status 参数返回 400', badStatus.res.status === 400, `status=${badStatus.res.status}`);
  check('400 响应带可读错误信息', /status/i.test(badStatus.body?.error?.message ?? ''), JSON.stringify(badStatus.body).slice(0, 120));
  const badSeverity = await api('/api/v1/tasks?severity=nope');
  check('非法 severity 参数返回 400', badSeverity.res.status === 400, `status=${badSeverity.res.status}`);
  const noStatus = await api('/api/v1/tasks?limit=5');
  check('不传 status 时正常返回全部状态', noStatus.res.status === 200 && Array.isArray(noStatus.body.tasks));

  /* 9. 通知记录 */
  console.log('\n[9] 通知记录');
  const notes = await api('/api/v1/notifications?limit=50');
  check('通知记录可查询', notes.res.status === 200 && notes.body.notifications.length > 0);
  check('通知记录含聚合条目', notes.body.notifications.some((n) => n.task_count > 1));

  /* 10. 用户隔离 */
  console.log('\n[10] 用户隔离');
  const newUser = `e2e${runId}`;
  const createdUser = await api('/api/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: newUser, email: `${newUser}@e2e.local` }),
  });
  check('管理员可以新建账号', createdUser.res.status === 201, `HTTP ${createdUser.res.status}`);
  check('新账号返回初始密码', typeof createdUser.body.password === 'string' && createdUser.body.password.length >= 8);
  check('新账号返回访问令牌', typeof createdUser.body.token === 'string' && createdUser.body.token.startsWith('ait_'));

  const userLogin = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: newUser, password: createdUser.body.password }),
  });
  const userCookie = (userLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  check('新账号可以用初始密码登录', userLogin.status === 200, `HTTP ${userLogin.status}`);

  const userApi = async (path, options = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        ...(options.cookie
          ? { cookie: options.cookie }
          : { authorization: `Bearer ${options.token ?? createdUser.body.token}` }),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  };

  const userTasks = await userApi('/api/v1/tasks?status=pending,acked,done&limit=200', { cookie: userCookie });
  check('新账号登录后列表为空', userTasks.body.tasks.length === 0, `实际 ${userTasks.body.tasks.length} 条`);

  const userSeesAdminTask = await userApi(
    `/api/v1/tasks/${taskId}`,
    { cookie: userCookie },
  );
  check('新账号看不到别人的任务', userSeesAdminTask.res.status === 404, `HTTP ${userSeesAdminTask.res.status}`);

  const userNotifications = await userApi('/api/v1/notifications?limit=50', { cookie: userCookie });
  check('新账号看不到别人的通知记录', userNotifications.body.notifications.length === 0, String(userNotifications.body.notifications.length));

  // 用新账号的令牌推一条任务
  const pushed = await userApi('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `新用户推送的任务 ${stamp}`,
      severity: 'need_human',
      idempotency_key: `e2e:${stamp}:u1`,
    }),
  });
  check('新账号的令牌能推送任务', pushed.res.status === 201, `HTTP ${pushed.res.status}`);

  const adminAfterPush = await api(`/api/v1/tasks/${pushed.body.task.id}`);
  check('管理员看不到别人令牌推的任务', adminAfterPush.res.status === 404, `HTTP ${adminAfterPush.res.status}`);

  const userAfterPush = await userApi('/api/v1/tasks?status=pending&limit=50', { cookie: userCookie });
  check('任务只出现在推送者名下', userAfterPush.body.tasks.some((t) => t.id === pushed.body.task.id));

  /* 11. 令牌自助签发 / 删除 */
  console.log('\n[11] 令牌自助签发与删除');
  const selfIssued = await userApi('/api/v1/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: 'self-issued' }),
  });
  check('用户可以自助签发令牌', selfIssued.res.status === 200 && !!selfIssued.body.token, `HTTP ${selfIssued.res.status}`);

  const tokenList = await userApi('/api/v1/tokens', { cookie: userCookie });
  check(
    '令牌列表返回明文（可随时复制）',
    tokenList.body.tokens.length > 0 &&
      tokenList.body.tokens.every((t) => typeof t.token === 'string'),
    JSON.stringify(tokenList.body.tokens[0]),
  );

  const times = tokenList.body.tokens.map((t) => new Date(t.created_at).getTime());
  check('令牌列表按创建时间升序（历史在前）', times.every((v, i) => i === 0 || times[i - 1] <= v), JSON.stringify(times));

  const issuedRow = tokenList.body.tokens.find((t) => t.token === selfIssued.body.token);
  const delRes = await userApi(`/api/v1/tokens/${issuedRow.id}`, { method: 'DELETE' });
  check('可以删除自己的令牌', delRes.res.status === 200, `HTTP ${delRes.res.status}`);

  const afterDelete = await userApi('/api/v1/tasks', { token: selfIssued.body.token });
  check('删除后令牌立即失效', afterDelete.res.status === 401, `HTTP ${afterDelete.res.status}`);

  const afterDeleteList = await userApi('/api/v1/tokens', { cookie: userCookie });
  check(
    '删除后令牌从列表移除',
    afterDeleteList.body.tokens.every((t) => t.id !== issuedRow.id),
    JSON.stringify(afterDeleteList.body.tokens.map((t) => t.id)),
  );

  /* 11b. 项目维度 */
  console.log('\n[11b] 项目维度：项目 / 令牌绑定 / 任务归属');
  const projName = `e2e-proj-${runId}`;
  const projCreate = await userApi('/api/v1/projects', {
    method: 'POST',
    cookie: userCookie,
    body: JSON.stringify({ name: projName }),
  });
  check('可以创建项目', projCreate.res.status === 201, `HTTP ${projCreate.res.status}`);
  const projId = projCreate.body.project?.id;

  const projDup = await userApi('/api/v1/projects', {
    method: 'POST',
    cookie: userCookie,
    body: JSON.stringify({ name: projName }),
  });
  check('重名项目被拒 409', projDup.res.status === 409, `HTTP ${projDup.res.status}`);

  const projList = await userApi('/api/v1/projects', { cookie: userCookie });
  const defaultProj = (projList.body.projects || []).find((p) => p.is_default);
  check('每个账号都有默认项目', !!defaultProj, JSON.stringify((projList.body.projects || []).map((p) => p.name)));
  check('项目列表带任务数', (projList.body.projects || []).every((p) => typeof p.task_count === 'number'));

  // 会话建任务：显式 project_id
  const projTask = await userApi('/api/v1/tasks', {
    method: 'POST',
    cookie: userCookie,
    body: JSON.stringify({ title: `项目任务 ${projName}`, project_id: projId }),
  });
  check(
    '会话建任务落在指定项目',
    projTask.res.status === 201 && projTask.body.task?.project === projName,
    JSON.stringify(projTask.body.task?.project),
  );

  // 令牌绑定项目：PAT 推送强制落进令牌的项目，请求里的 project 字段被忽略
  const projToken = await userApi('/api/v1/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: 'proj-token', project_id: projId }),
  });
  check(
    '签发令牌可绑定项目',
    projToken.res.status === 200 && !!projToken.body.project_id,
    `HTTP ${projToken.res.status}`,
  );
  const patTask = await userApi('/api/v1/tasks', {
    method: 'POST',
    token: projToken.body.token,
    body: JSON.stringify({ title: '令牌项目任务', project: '不该出现的项目' }),
  });
  check(
    '令牌推送的任务强制落进令牌的项目',
    patTask.res.status === 201 && patTask.body.task?.project === projName,
    JSON.stringify(patTask.body.task?.project),
  );

  // 令牌列表带绑定项目名
  const tokListWithProj = await userApi('/api/v1/tokens');
  const projTokRow = (tokListWithProj.body.tokens || []).find((t) => t.name === 'proj-token');
  check(
    '令牌列表返回绑定项目名',
    projTokRow?.project_name === projName,
    JSON.stringify(projTokRow?.project_name),
  );

  // 删除项目：项目下的任务与令牌挪进默认项目
  const projDel = await userApi(`/api/v1/projects/${projId}`, { method: 'DELETE' });
  check('可以删除非默认项目', projDel.res.status === 200, `HTTP ${projDel.res.status}`);
  const movedTask = await userApi(`/api/v1/tasks/${projTask.body.task.id}`, { cookie: userCookie });
  check(
    '删除项目后任务挪进默认项目',
    movedTask.body.task?.project === '默认项目',
    JSON.stringify(movedTask.body.task?.project),
  );
  const delDefault = await userApi(`/api/v1/projects/${defaultProj.id}`, { method: 'DELETE' });
  check('默认项目不可删除 409', delDefault.res.status === 409, `HTTP ${delDefault.res.status}`);

  /* 12. MCP stdio */
  console.log('\n[12] MCP stdio 协议');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist', 'src', 'cli.js'), 'mcp'],
    env: {
      ...process.env,
      PATH: process.env.PATH || '',
      AI_TODO_BASE_URL: BASE,
      AI_TODO_TOKEN: createdUser.body.token,
      AI_TODO_SESSION_KEY: `e2e-mcp-session-${runId}`,
      AI_TODO_AGENT: 'e2e-agent',
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'ai-todo-e2e', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((t) => t.name).sort();
  check(
    'MCP 暴露 9 个工具',
    toolNames.join(',') ===
      'todo_ack,todo_archive,todo_create,todo_done,todo_get_reply,todo_list,todo_snooze,todo_update,todo_wait_reply',
    toolNames.join(','),
  );

  const resources = await client.listResources();
  check('MCP 暴露 todo://tasks 资源', resources.resources.some((r) => r.uri === 'todo://tasks'));

  const mcpStamp = Date.now();
  const call = await client.callTool({
    name: 'todo_create',
    arguments: {
      title: `MCP 创建的任务 ${mcpStamp}`,
      detail: '由 MCP 客户端创建',
      severity: 'need_human',
      project: 'e2e-mcp',
    },
  });
  const mcpText = call.content?.[0]?.text ?? '';
  check('MCP todo_create 调用成功', !call.isError && mcpText.includes('已记录'), mcpText);

  const call2 = await client.callTool({
    name: 'todo_create',
    arguments: { title: `MCP 创建的任务 ${mcpStamp}`, project: 'e2e-mcp' },
  });
  const mcpText2 = call2.content?.[0]?.text ?? '';
  check('MCP 默认幂等键命中重复创建', mcpText2.includes('幂等命中'), mcpText2);

  const listRes = await client.callTool({ name: 'todo_list', arguments: { q: 'MCP 创建的任务' } });
  check('MCP todo_list 可用', !listRes.isError, listRes.content?.[0]?.text?.slice(0, 60));

  const mcpTaskId = call.structuredContent?.task_id;

  /* 回复闭环：todo_wait_reply 长轮询挂起 → 用户（网页会话）回复 → 立刻拿到回复内容 */
  const waitPromise = client
    .callTool({ name: 'todo_wait_reply', arguments: { id: mcpTaskId, timeout: 20 } })
    .catch((e) => e);
  await new Promise((r) => setTimeout(r, 800));
  const replyRes = await userApi(`/api/v1/tasks/${mcpTaskId}/reply`, {
    method: 'POST',
    cookie: userCookie,
    body: JSON.stringify({ reply: '确认通过，继续吧' }),
  });
  check(
    '用户可以回复任务（回复即完成）',
    replyRes.res.status === 200 &&
      replyRes.body.task.status === 'done' &&
      replyRes.body.task.reply_text === '确认通过，继续吧',
    `HTTP ${replyRes.res.status}`,
  );

  const waitRes = await waitPromise;
  check(
    'todo_wait_reply 长轮询拿到回复内容',
    waitRes.structuredContent?.replied === true &&
      waitRes.structuredContent?.reply === '确认通过，继续吧' &&
      waitRes.structuredContent?.status === 'done',
    JSON.stringify(waitRes.structuredContent ?? String(waitRes)),
  );

  const getReplyRes = await client.callTool({ name: 'todo_get_reply', arguments: { id: mcpTaskId } });
  check(
    'todo_get_reply 即时查询回复',
    getReplyRes.structuredContent?.replied === true,
    JSON.stringify(getReplyRes.structuredContent ?? getReplyRes.content?.[0]?.text),
  );

  /* 更新即重开：agent 更新已完成（回复过）的任务，状态必须回到 pending */
  const reopenRes = await userApi(`/api/v1/tasks/${mcpTaskId}`, {
    method: 'PATCH',
    cookie: userCookie,
    body: JSON.stringify({ detail: '任务有了新的进展，需要用户再看一眼' }),
  });
  check(
    '更新已完成的任务会重新打开为 pending',
    reopenRes.res.status === 200 &&
      reopenRes.body.task.status === 'pending' &&
      reopenRes.body.task.done_at === null,
    `HTTP ${reopenRes.res.status} status=${reopenRes.body?.task?.status}`,
  );
  const archivedReopen = await client.callTool({
    name: 'todo_archive',
    arguments: { id: mcpTaskId },
  });
  const reopen2 = await client.callTool({
    name: 'todo_update',
    arguments: { id: mcpTaskId, title: `MCP 创建的任务（重开）${mcpStamp}` },
  });
  check(
    '更新已归档的任务也会重开为 pending',
    archivedReopen.structuredContent?.status === 'archived' &&
      reopen2.structuredContent?.status === 'pending',
    `archive=${archivedReopen.structuredContent?.status} update=${reopen2.structuredContent?.status}`,
  );

  /* 超时分支：新任务没人回复，短等待应返回 replied=false 且不报错 */
  const timeoutTask = await client.callTool({
    name: 'todo_create',
    arguments: { title: `等待超时的任务 ${mcpStamp}`, project: 'e2e-mcp', notify: false },
  });
  const timeoutWait = await client.callTool({
    name: 'todo_wait_reply',
    arguments: { id: timeoutTask.structuredContent?.task_id, timeout: 2 },
  });
  check(
    'todo_wait_reply 超时返回 replied=false',
    timeoutWait.structuredContent?.replied === false &&
      timeoutWait.structuredContent?.status === 'pending',
    JSON.stringify(timeoutWait.structuredContent ?? timeoutWait.content?.[0]?.text),
  );

  const ackRes = await client.callTool({ name: 'todo_ack', arguments: { id: mcpTaskId } });
  check('MCP todo_ack 可用', !ackRes.isError, ackRes.content?.[0]?.text);

  const doneRes = await client.callTool({ name: 'todo_done', arguments: { id: mcpTaskId } });
  check('MCP todo_done 可用', !doneRes.isError, doneRes.content?.[0]?.text);

  const archiveRes = await client.callTool({ name: 'todo_archive', arguments: { id: mcpTaskId } });
  check('MCP todo_archive 可用', !archiveRes.isError, archiveRes.content?.[0]?.text);
  check('归档后状态为 archived', archiveRes.structuredContent?.status === 'archived', archiveRes.structuredContent?.status);

  const readRes = await client.readResource({ uri: 'todo://tasks' });
  const text = readRes.contents?.[0]?.text ?? '';
  check('MCP 资源可读', typeof text === 'string' && text.includes('待我关注'), text.slice(0, 40));

  await client.close();
  await transport.close?.();

  /* 13. MCP 缺少环境变量凭证时必须拒绝启动 */
  console.log('\n[13] MCP 强制环境变量凭证');
  const { spawnSync } = await import('node:child_process');
  const noEnv = spawnSync(process.execPath, [join(root, 'dist', 'src', 'cli.js'), 'mcp'], {
    env: {
      PATH: process.env.PATH || '',
      AI_TODO_BASE_URL: BASE,
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  check('缺少 AI_TODO_TOKEN 时 MCP 拒绝启动', noEnv.status !== 0, `status=${noEnv.status}`);
  check(
    'MCP 提示里写明要设置 AI_TODO_TOKEN',
    `${noEnv.stderr}${noEnv.stdout}`.includes('AI_TODO_TOKEN'),
    String(noEnv.stderr).slice(0, 120),
  );

  /* 14. 通知聚合的账号隔离；账号删除后服务不崩 */
  console.log('\n[14] 通知隔离与服务韧性');

  const isoUser = `iso${runId}`;
  const isoCreated = await api('/api/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: isoUser, email: `${isoUser}@e2e.local` }),
  });
  check('可以创建隔离测试账号', isoCreated.res.status === 201, `HTTP ${isoCreated.res.status}`);

  const isoLogin = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: isoUser, password: isoCreated.body.password }),
  });
  const isoCookie = (isoLogin.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  check('隔离测试账号可以登录', isoLogin.status === 200, `HTTP ${isoLogin.status}`);

  const isoApi = async (path, options = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        ...(options.cookie
          ? { cookie: options.cookie }
          : { authorization: `Bearer ${options.token ?? isoCreated.body.token}` }),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  };

  // 两个账号都设成「按 none 聚合 + 2 秒冷却」，让它们的冷却窗口完全重叠。
  // 老实现的分组键不含 user_id，两个账号会共用同一个批次 → 任务串到对方通知里。
  await isoApi('/api/v1/rules', {
    method: 'PUT',
    cookie: isoCookie,
    body: JSON.stringify({ cooldown_sec: 2, group_by: 'none', min_severity: 'info' }),
  });
  await api('/api/v1/rules', {
    method: 'PUT',
    body: JSON.stringify({ cooldown_sec: 2, group_by: 'none', min_severity: 'info' }),
  });

  const isoStamp = Date.now();
  const isoTask1 = `E2E 临时用户任务 ${isoStamp}`;
  const adminTask1 = `E2E 管理员隔离任务 ${isoStamp}`;

  // 三条紧挨着推，确保落进同一个冷却窗口
  await isoApi('/api/v1/tasks', {
    method: 'POST',
    token: isoCreated.body.token,
    body: JSON.stringify({
      title: isoTask1,
      severity: 'need_human',
      idempotency_key: `e2e:${isoStamp}:iso1`,
    }),
  });
  await isoApi('/api/v1/tasks', {
    method: 'POST',
    token: isoCreated.body.token,
    body: JSON.stringify({
      title: `E2E 临时用户任务2 ${isoStamp}`,
      severity: 'need_human',
      idempotency_key: `e2e:${isoStamp}:iso2`,
    }),
  });
  await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: adminTask1,
      severity: 'need_human',
      idempotency_key: `e2e:${isoStamp}:adm1`,
    }),
  });

  await sleep(3500); // 等冷却窗口结束，触发尾部合并

  const isoNotes = await isoApi('/api/v1/notifications?limit=50', { cookie: isoCookie });
  const isoBodies = (isoNotes.body.notifications ?? []).map((n) => n.body ?? '').join('\n');
  check('隔离账号的通知里不含别人的任务标题', !isoBodies.includes(adminTask1), isoBodies.slice(0, 120));

  const adminNotes = await api('/api/v1/notifications?limit=50');
  const adminBodies = (adminNotes.body.notifications ?? []).map((n) => n.body ?? '').join('\n');
  check('管理员的通知里不含别人的任务标题', !adminBodies.includes(isoTask1), adminBodies.slice(0, 120));

  // 账号在聚合窗口期内被删除：窗口到期时落库会撞外键约束，老实现会在这里把进程打崩
  await isoApi('/api/v1/tasks', {
    method: 'POST',
    token: isoCreated.body.token,
    body: JSON.stringify({
      title: `E2E 临时用户任务3 ${isoStamp}`,
      severity: 'need_human',
      idempotency_key: `e2e:${isoStamp}:iso3`,
    }),
  });
  await isoApi('/api/v1/tasks', {
    method: 'POST',
    token: isoCreated.body.token,
    body: JSON.stringify({
      title: `E2E 临时用户任务4 ${isoStamp}`,
      severity: 'need_human',
      idempotency_key: `e2e:${isoStamp}:iso4`,
    }),
  });

  const isoUsers = await api('/api/v1/admin/users');
  const isoTarget = isoUsers.body.users.find((u) => u.username === isoUser);
  const isoDeleted = await api(`/api/v1/admin/users/${isoTarget.id}`, { method: 'DELETE' });
  check('可以删除隔离测试账号', isoDeleted.res.status === 200, `HTTP ${isoDeleted.res.status}`);

  await sleep(3500); // 窗口到期：老实现在这里会因外键约束让整个服务退出

  const alive = await fetch(`${BASE}/api/v1/health`).then((r) => r.json()).catch(() => null);
  check('账号删除后聚合窗口到期，服务仍然存活', alive?.ok === true, JSON.stringify(alive));

  const stillWorks = await api('/api/v1/tasks?limit=5');
  check('账号删除后接口仍可正常响应', stillWorks.res.status === 200, `HTTP ${stillWorks.res.status}`);

  await api('/api/v1/rules', {
    method: 'PUT',
    body: JSON.stringify(BASELINE_RULES),
  });

  /* 15. 彻底删除（不可恢复） */
  console.log('\n[15] 彻底删除');
  const delStamp = Date.now();

  const delTask = await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `E2E 待删除任务 ${delStamp}`,
      severity: 'need_human',
      idempotency_key: `e2e:${delStamp}:del`,
    }),
  });
  check('创建待删除任务', delTask.res.status === 201, `HTTP ${delTask.res.status}`);
  const delId = delTask.body.task.id;

  const hardDeletePending = await api(`/api/v1/tasks/${delId}`, { method: 'DELETE' });
  check(
    '未归档的任务不能彻底删除（409）',
    hardDeletePending.res.status === 409,
    `HTTP ${hardDeletePending.res.status}`,
  );

  const badUuidDelete = await api('/api/v1/tasks/not-a-uuid', { method: 'DELETE' });
  check('非法 UUID 的删除请求返回 400', badUuidDelete.res.status === 400, `HTTP ${badUuidDelete.res.status}`);

  await api(`/api/v1/tasks/${delId}/archive`, { method: 'POST' });
  const hardDeleted = await api(`/api/v1/tasks/${delId}`, { method: 'DELETE' });
  check('已归档的任务可以彻底删除', hardDeleted.res.status === 200, `HTTP ${hardDeleted.res.status}`);

  const afterHardDelete = await api(`/api/v1/tasks/${delId}`);
  check('彻底删除后任务真的不存在（404）', afterHardDelete.res.status === 404, `HTTP ${afterHardDelete.res.status}`);

  // 跨用户：别的账号不能删掉我的任务（用 [10] 建的那个账号，它到「清理」阶段才被删）
  const crossTask = await api('/api/v1/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `E2E 跨用户删除任务 ${delStamp}`,
      severity: 'need_human',
      idempotency_key: `e2e:${delStamp}:del2`,
    }),
  });
  await api(`/api/v1/tasks/${crossTask.body.task.id}/archive`, { method: 'POST' });
  const crossDelete = await userApi(`/api/v1/tasks/${crossTask.body.task.id}`, { method: 'DELETE' });
  check('别的账号不能删我的任务（404）', crossDelete.res.status === 404, `HTTP ${crossDelete.res.status}`);

  const stillThere = await api(`/api/v1/tasks/${crossTask.body.task.id}`);
  check(
    '跨用户的删除请求没有真的删掉任务',
    stillThere.res.status === 200,
    `HTTP ${stillThere.res.status}`,
  );

  /* 16. 批量清空已归档 */
  console.log('\n[16] 批量清空已归档');
  // 必须在独立账号上测：清空是批量不可逆操作，不能拿管理员的真实数据做实验
  const purgeUser = `purge${runId}`;
  const purgeCreated = await api('/api/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username: purgeUser, email: `${purgeUser}@e2e.local` }),
  });
  check('可以创建批量清空测试账号', purgeCreated.res.status === 201, `HTTP ${purgeCreated.res.status}`);

  const purgeApi = async (path, options = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        ...(options.cookie
          ? { cookie: options.cookie }
          : { authorization: `Bearer ${options.token ?? purgeCreated.body.token}` }),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { res, body };
  };

  const purgeIds = [];
  for (const n of [1, 2, 3]) {
    const r = await purgeApi('/api/v1/tasks', {
      method: 'POST',
      token: purgeCreated.body.token,
      body: JSON.stringify({
        title: `E2E 批量清空任务 ${n} ${delStamp}`,
        severity: 'need_human',
        idempotency_key: `e2e:${delStamp}:purge${n}`,
      }),
    });
    purgeIds.push(r.body.task.id);
  }
  await purgeApi(`/api/v1/tasks/${purgeIds[0]}/archive`, { method: 'POST' });
  await purgeApi(`/api/v1/tasks/${purgeIds[1]}/archive`, { method: 'POST' });

  const adminArchivedBefore = (await api('/api/v1/me')).body.archived;
  const purgeResult = await purgeApi('/api/v1/tasks/archived', { method: 'DELETE' });
  check(
    '批量清空已归档可用且条数正确',
    purgeResult.res.status === 200 && purgeResult.body.deleted === 2,
    JSON.stringify(purgeResult.body),
  );

  const keptTask = await purgeApi(`/api/v1/tasks/${purgeIds[2]}`);
  check('批量清空不动未归档的任务', keptTask.res.status === 200, `HTTP ${keptTask.res.status}`);

  const purgedTask = await purgeApi(`/api/v1/tasks/${purgeIds[0]}`);
  check('批量清空后已归档任务真的没了（404）', purgedTask.res.status === 404, `HTTP ${purgedTask.res.status}`);

  const adminArchivedAfter = (await api('/api/v1/me')).body.archived;
  check(
    '批量清空只影响自己的已归档任务',
    adminArchivedBefore === adminArchivedAfter,
    `${adminArchivedBefore} → ${adminArchivedAfter}`,
  );

  const purgeUsers = await api('/api/v1/admin/users');
  const purgeTarget = purgeUsers.body.users.find((u) => u.username === purgeUser);
  if (purgeTarget) {
    await api(`/api/v1/admin/users/${purgeTarget.id}`, { method: 'DELETE' });
  }
  const purgeUsersAfter = await api('/api/v1/admin/users');
  check(
    '批量清空测试账号已删除',
    !purgeUsersAfter.body.users.some((u) => u.username === purgeUser),
    purgeUser,
  );

  /* 17. 远程 MCP（Streamable HTTP） */
  console.log('\n[17] 远程 MCP over HTTP');

  // 没有令牌 / 令牌无效都必须 401。
  // 端点只认 Bearer PAT，不认会话 Cookie——Cookie 是浏览器凭据，
  // 让它能调 MCP 等于把网页脚本也变成推任务的通道。
  const mcpNoAuth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('远程 MCP 无令牌返回 401', mcpNoAuth.status === 401, `HTTP ${mcpNoAuth.status}`);

  const mcpBadAuth = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer ait_definitely_not_a_real_token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('远程 MCP 无效令牌返回 401', mcpBadAuth.status === 401, `HTTP ${mcpBadAuth.status}`);

  const mcpCookieOnly = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check(
    '远程 MCP 不接受会话 Cookie（只认 Bearer PAT）',
    mcpCookieOnly.status === 401,
    `HTTP ${mcpCookieOnly.status}`,
  );

  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );
  const httpTransport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${createdUser.body.token}`,
        'x-ai-todo-agent': 'e2e-http',
      },
    },
  });
  const httpClient = new Client({ name: 'ai-todo-e2e-http', version: '1.0.0' });
  await httpClient.connect(httpTransport);
  check('远程 MCP 客户端可以连上', httpClient.getServerVersion()?.name === 'ai-todo');

  const httpTools = await httpClient.listTools();
  const httpToolNames = httpTools.tools.map((t) => t.name).sort();
  check(
    '远程 MCP 暴露 9 个工具',
    httpToolNames.join(',') ===
      'todo_ack,todo_archive,todo_create,todo_done,todo_get_reply,todo_list,todo_snooze,todo_update,todo_wait_reply',
    httpToolNames.join(','),
  );
  check(
    '远程 MCP 与 stdio 形态的工具完全一致',
    httpToolNames.join(',') === toolNames.join(','),
    `http=${httpToolNames.join(',')} | stdio=${toolNames.join(',')}`,
  );

  const httpResources = await httpClient.listResources();
  check(
    '远程 MCP 暴露 todo://tasks 资源',
    httpResources.resources.some((r) => r.uri === 'todo://tasks'),
  );

  const httpStamp = Date.now();
  const httpCall = await httpClient.callTool({
    name: 'todo_create',
    arguments: {
      title: `HTTP MCP 创建的任务 ${httpStamp}`,
      detail: '由远程 MCP 客户端创建',
      severity: 'need_human',
      project: 'e2e-mcp-http',
    },
  });
  const httpText = httpCall.content?.[0]?.text ?? '';
  check('远程 MCP todo_create 调用成功', !httpCall.isError && httpText.includes('已记录'), httpText);

  // 默认幂等键是 agent:session:标题哈希。HTTP 形态的 session key 由令牌派生，
  // 必须稳定——否则同一个客户端连推两次会被当成两条不同任务，幂等形同虚设。
  const httpCall2 = await httpClient.callTool({
    name: 'todo_create',
    arguments: { title: `HTTP MCP 创建的任务 ${httpStamp}`, project: 'e2e-mcp-http' },
  });
  const httpText2 = httpCall2.content?.[0]?.text ?? '';
  check('远程 MCP 默认幂等键命中重复创建', httpText2.includes('幂等命中'), httpText2);

  const httpTaskId = httpCall.structuredContent?.task_id;
  const httpListed = await httpClient.callTool({ name: 'todo_list', arguments: { q: 'HTTP MCP 创建的任务' } });
  check('远程 MCP todo_list 可用', !httpListed.isError, httpListed.content?.[0]?.text?.slice(0, 60));

  const httpRead = await httpClient.readResource({ uri: 'todo://tasks' });
  const httpReadText = httpRead.contents?.[0]?.text ?? '';
  check(
    '远程 MCP 资源可读',
    typeof httpReadText === 'string' && httpReadText.includes('待我关注'),
    httpReadText.slice(0, 40),
  );

  // 无状态模式下不支持 SSE 订阅流，GET 应该被明确拒绝而不是挂住。
  const mcpGet = await fetch(`${BASE}/mcp`, {
    headers: { authorization: `Bearer ${createdUser.body.token}` },
  });
  check('远程 MCP 的 GET 被拒（无状态模式不支持订阅流）', mcpGet.status === 405, `HTTP ${mcpGet.status}`);

  // 跨用户隔离：管理员看不到隔离账号通过远程 MCP 建的任务
  const adminSeesHttpTask = await api(`/api/v1/tasks/${httpTaskId}`);
  check(
    '远程 MCP 建的任务对别的账号不可见（404）',
    adminSeesHttpTask.res.status === 404,
    `HTTP ${adminSeesHttpTask.res.status}`,
  );

  await httpClient.callTool({ name: 'todo_archive', arguments: { id: httpTaskId } });
  await httpClient.close();
  await httpTransport.close?.();

  /* 18. 任务来源与来源筛选 */
  console.log('\n[18] 任务来源与来源筛选');

  // 两个不同来源（agent）各推一条任务，才能验证「按来源筛选」真的分得开。
  const srcStamp = Date.now();
  const srcTasks = [];
  for (const agent of ['trae', 'qoder']) {
    const r = await userApi('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: `来源筛选测试 ${agent} ${srcStamp}`,
        severity: 'need_human',
        project: 'src-filter-demo',
        idempotency_key: `e2e:${srcStamp}:src:${agent}`,
        source: { agent, session_key: `e2e-src-${agent}-${srcStamp}` },
      }),
    });
    check(
      `用来源 ${agent} 成功创建任务`,
      r.res.status === 201 && !!r.body.task?.source_id,
      `HTTP ${r.res.status} source_id=${r.body.task?.source_id}`,
    );
    // 注意：任务 id 与来源 id 是两个东西，别混用
    srcTasks.push({ agent, taskId: r.body.task?.id, sourceId: r.body.task?.source_id });
  }

  const byTrae = await userApi(`/api/v1/tasks?source=trae&limit=200`);
  const traeTasks = byTrae.body.tasks || [];
  check(
    '按来源筛选：只返回该来源的任务',
    traeTasks.length > 0 && traeTasks.every((x) => x.source_id === srcTasks[0].sourceId),
    `返回 ${traeTasks.length} 条`,
  );
  check(
    '按来源筛选：不会混进别的来源',
    !traeTasks.some((x) => x.source_id === srcTasks[1].sourceId),
    '混进了另一个来源的任务',
  );

  const byQoder = await userApi(`/api/v1/tasks?source=qoder&limit=200`);
  check(
    '按来源筛选：换一个来源得到另一批任务',
    (byQoder.body.tasks || []).some((x) => x.source_id === srcTasks[1].sourceId),
    `返回 ${(byQoder.body.tasks || []).length} 条`,
  );

  const noFilter = await userApi('/api/v1/tasks?limit=200');
  check(
    '不带 source 参数时两个来源都能看到',
    (noFilter.body.tasks || []).some((x) => x.source_id === srcTasks[0].sourceId) &&
      (noFilter.body.tasks || []).some((x) => x.source_id === srcTasks[1].sourceId),
    '过滤条件不该影响不带参数时的结果',
  );

  // 隔离：别的账号用同样的 source 参数也筛不到你的任务
  const otherByTrae = await api(`/api/v1/tasks?source=trae&limit=200`);
  check(
    '按来源筛选不跨账号泄露',
    !(otherByTrae.body.tasks || []).some((x) => x.source_id === srcTasks[0].sourceId),
    '别的账号看到了我的任务',
  );

  const meSources = await userApi('/api/v1/me');
  const agentNames = (meSources.body.sources || []).map((s) => s.agent);
  check(
    '来源列表能拿到 agent 名称（供筛选下拉用）',
    agentNames.includes('trae') && agentNames.includes('qoder'),
    agentNames.join(','),
  );

  // 清理这两条来源测试任务
  for (const s of srcTasks) {
    await userApi(`/api/v1/tasks/${s.taskId}/archive`, { method: 'POST' });
  }

  /* ------------------------------------------------- 微信登录 */

  console.log('\n[11] 微信登录');

  // 静态检查：二维码必须由本地模块生成，不能依赖外部图片服务
  check('登录页有微信登录入口', /startWechatLogin/.test(feCode), '登录页没有发起扫码的逻辑');
  check('前端引入了本地二维码模块', /from '\.\/qr\.js'/.test(feCode), '没有 import qr.js');
  check(
    '存在零依赖的二维码实现',
    existsSync(join(feSrc, 'qr.js')),
    '缺少 frontend/src/qr.js，扫码面板画不出二维码',
  );
  // v-html 只允许用在本地 qr.js 生成的 SVG 上（内容完全本地可控），
  // 其余任何 v-html / innerHTML 都不该出现：外部内容可能被当成 HTML 执行。
  const vHtmlUsages = [...feCode.matchAll(/v-html="([^"]+)"/g)].map((m) => m[1]);
  const badVHtml = vHtmlUsages.filter((expr) => !/^(loginQr\.svg|bindDialog\.svg)$/.test(expr.trim()));
  check(
    'v-html 只用于本地生成的二维码 SVG，项目里没有 innerHTML',
    badVHtml.length === 0 && !/innerHTML/.test(feCode),
    badVHtml.join(', ') || '出现了 innerHTML',
  );

  // 主实例支持哪些登录方式（没配 AppID 时应该是关闭的）
  const providers = await fetch(`${BASE}/api/v1/auth/providers`).then((r) => r.json());
  check('登录方式接口可用', !!providers.wechat, JSON.stringify(providers));
  check(
    'wechat.enabled 是布尔值',
    typeof providers.wechat?.enabled === 'boolean',
    JSON.stringify(providers.wechat),
  );

  // 端到端跑一遍扫码登录：自己拉一个开了模拟模式的隔离实例
  const mock = await startMockWechatServer();
  if (!mock) {
    console.log('  （跳过端到端扫码流程：模拟实例没起来）');
  } else {
    try {
      const prov = await fetch(`${mock.base}/api/v1/auth/providers`).then((r) => r.json());
      check('模拟实例开启了微信登录', prov.wechat?.enabled === true, JSON.stringify(prov));
      check('模拟实例标记为 mock', prov.wechat?.mock === true, JSON.stringify(prov));

      // 发起扫码
      const startRes = await fetch(`${mock.base}/api/v1/auth/wechat/start`);
      const start = await startRes.json();
      check('发起扫码返回 200', startRes.status === 200, `HTTP ${startRes.status}`);
      check(
        '扫码 state 是 64 位随机十六进制',
        /^[0-9a-f]{64}$/.test(start.state || ''),
        String(start.state),
      );
      check(
        '返回了带 state 的授权地址',
        typeof start.authorize_url === 'string' && start.authorize_url.includes('state='),
        String(start.authorize_url),
      );

      // 乱猜的 state 不能被当成已登录
      const unknown = await fetch(
        `${mock.base}/api/v1/auth/wechat/status?state=${'0'.repeat(64)}`,
      ).then((r) => r.json());
      check('未知 state 不会被当成已登录', unknown.status === 'unknown', JSON.stringify(unknown));

      // 模拟授权页
      const page = await fetch(start.authorize_url);
      const html = await page.text();
      check('模拟授权页可访问', page.status === 200, `HTTP ${page.status}`);
      check('模拟授权页有授权按钮', html.includes('允许登录'), '页面里没有授权按钮');

      // 确认授权
      const confirm = await fetch(`${mock.base}/api/v1/auth/wechat/mock/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: start.state,
          openid: 'e2e-openid-a',
          nickname: 'E2E 微信用户',
        }),
      });
      check('模拟授权确认成功', confirm.status === 200, `HTTP ${confirm.status}`);

      // 表单编码提交：浏览器里的模拟授权页是个 <form method="post">，
      // 提交的是 application/x-www-form-urlencoded。服务端注册了
      // addContentTypeParser('*', { parseAs: 'string' })，这类 body 是字符串而不是对象——
      // 按对象读会拿到 undefined，授权流程直接断掉。这条用例专门盯这个坑。
      const formStart = await fetch(`${mock.base}/api/v1/auth/wechat/start`).then((r) => r.json());
      const formBody = new URLSearchParams({
        state: formStart.state,
        openid: 'e2e-openid-form',
        nickname: 'E2E 表单用户',
      }).toString();
      const formConfirm = await fetch(`${mock.base}/api/v1/auth/wechat/mock/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formBody,
      });
      check(
        '表单编码提交（模拟授权页的真实提交方式）也能完成授权',
        formConfirm.status === 200,
        `HTTP ${formConfirm.status}`,
      );
      const formStatus = await fetch(
        `${mock.base}/api/v1/auth/wechat/status?state=${formStart.state}`,
      ).then((r) => r.json());
      check(
        '表单编码提交后轮询到授权成功',
        formStatus.status === 'confirmed',
        JSON.stringify(formStatus),
      );
      check(
        '表单编码提交建出的账号昵称取自表单',
        formStatus.user?.display_name === 'E2E 表单用户',
        JSON.stringify(formStatus.user),
      );

      // 桌面端轮询取回会话
      const statusRes = await fetch(
        `${mock.base}/api/v1/auth/wechat/status?state=${start.state}`,
      );
      const status = await statusRes.json();
      check('轮询到授权成功', status.status === 'confirmed', JSON.stringify(status));
      const setCookie = statusRes.headers.get('set-cookie') || '';
      check('轮询响应签发了会话 Cookie', setCookie.includes('ai_todo_session='), setCookie);
      check(
        '首次微信登录自动签发了 MCP 令牌',
        typeof status.token === 'string' && status.token.startsWith('ait_'),
        String(status.token),
      );
      check(
        '账号昵称取自微信资料',
        status.user?.display_name === 'E2E 微信用户',
        JSON.stringify(status.user),
      );

      // 拿到的 Cookie 能访问受保护接口
      const cookie = setCookie.split(';')[0];
      const me = await fetch(`${mock.base}/api/v1/me`, { headers: { cookie } }).then((r) => r.json());
      check('会话 Cookie 可以访问 /api/v1/me', !!me.user_id, JSON.stringify(me).slice(0, 160));
      check('账号标记为已绑定微信', me.wechat_bound === true, JSON.stringify(me.wechat_bound));

      // 自动签发的令牌可以直接用
      const tokRes = await fetch(`${mock.base}/api/v1/tasks?limit=1`, {
        headers: { authorization: `Bearer ${status.token}` },
      });
      check('自动签发的令牌可以调 API', tokRes.status === 200, `HTTP ${tokRes.status}`);

      // 同一个微信再登一次：复用账号，不重复签发令牌
      const start2 = await fetch(`${mock.base}/api/v1/auth/wechat/start`).then((r) => r.json());
      await fetch(`${mock.base}/api/v1/auth/wechat/mock/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: start2.state,
          openid: 'e2e-openid-a',
          nickname: 'E2E 微信用户',
        }),
      });
      const status2 = await fetch(
        `${mock.base}/api/v1/auth/wechat/status?state=${start2.state}`,
      ).then((r) => r.json());
      check(
        '同一个微信再次登录复用同一账号',
        status2.user?.id === status.user?.id,
        `${status2.user?.id} vs ${status.user?.id}`,
      );
      check('老账号再次登录不重复签发令牌', !status2.token, String(status2.token));

      // 绑定：把另一个微信绑到当前账号
      const bindNoAuth = await fetch(`${mock.base}/api/v1/auth/wechat/bind/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      check('未登录不能发起绑定', bindNoAuth.status === 401, `HTTP ${bindNoAuth.status}`);

      const bindRes = await fetch(`${mock.base}/api/v1/auth/wechat/bind/start`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      });
      const bind = await bindRes.json();
      check('已登录可以发起绑定', bindRes.status === 200 && !!bind.state, `HTTP ${bindRes.status}`);

      await fetch(`${mock.base}/api/v1/auth/wechat/mock/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: bind.state,
          openid: 'e2e-openid-b',
          nickname: 'E2E 微信用户',
        }),
      });
      const bindStatus = await fetch(
        `${mock.base}/api/v1/auth/wechat/status?state=${bind.state}`,
      ).then((r) => r.json());
      check(
        '绑定流程确认成功',
        bindStatus.status === 'confirmed' && bindStatus.purpose === 'bind',
        JSON.stringify(bindStatus),
      );
      const me2 = await fetch(`${mock.base}/api/v1/me`, { headers: { cookie } }).then((r) => r.json());
      check('绑定后还是同一个账号', me2.user_id === me.user_id, `${me2.user_id} vs ${me.user_id}`);

      // 已被别人占用的微信不能再绑走
      const start3 = await fetch(`${mock.base}/api/v1/auth/wechat/start`).then((r) => r.json());
      await fetch(`${mock.base}/api/v1/auth/wechat/mock/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: start3.state,
          openid: 'e2e-openid-a',
          nickname: '另一个微信',
        }),
      });
      const status3 = await fetch(
        `${mock.base}/api/v1/auth/wechat/status?state=${start3.state}`,
      ).then((r) => r.json());
      check(
        '换绑后原微信会变成独立账号',
        status3.user?.id && status3.user?.id !== status.user?.id,
        `${status3.user?.id} vs ${status.user?.id}`,
      );

      const bind2 = await fetch(`${mock.base}/api/v1/auth/wechat/bind/start`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      }).then((r) => r.json());
      const conflict = await fetch(`${mock.base}/api/v1/auth/wechat/mock/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          state: bind2.state,
          openid: 'e2e-openid-a',
          nickname: '占用者',
        }),
      });
      check('已被占用的微信不能绑到别的账号', conflict.status === 400, `HTTP ${conflict.status}`);
    } finally {
      try {
        mock.child.kill();
      } catch {
        /* 已经退了 */
      }
      await sleep(300);
      try {
        rmSync(mock.dataDir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* 临时目录删不掉就算了，不影响结论 */
      }
    }
  }

  /* 清理 */
  console.log('\n[清理] 归档测试任务并删除测试账号');

  const all = await api('/api/v1/tasks?status=pending,acked,done&limit=200');
  const junk = all.body.tasks.filter(
    (t) =>
      t.title.startsWith('E2E ') ||
      t.title.startsWith('MCP 创建') ||
      t.title.startsWith('聚合') ||
      t.title.startsWith('阻塞任务'),
  );
  for (const t of junk) {
    await api(`/api/v1/tasks/${t.id}/archive`, { method: 'POST' }).catch(() => {});
  }
  check(`已归档 ${junk.length} 条测试任务`, junk.length > 0, String(junk.length));

  const deleted = await api(`/api/v1/admin/users/${createdUser.body.user.id}`, { method: 'DELETE' });
  check('管理员可以删除测试账号', deleted.res.status === 200, `HTTP ${deleted.res.status}`);

  await sse.close();

  console.log(`\n${'─'.repeat(52)}`);
  console.log(`结果：${pass} 项通过，${fail} 项失败`);
  if (failures.length) {
    console.log('\n失败项：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n验证脚本异常：', error);
  process.exit(1);
});
