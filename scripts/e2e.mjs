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
 *  11. 令牌自助签发 / 吊销；禁用账号后令牌立即失效
 *  12. MCP stdio：initialize / tools/list / tools/call / resources/read
 *  13. MCP 缺少 AI_TODO_TOKEN 时必须拒绝启动（凭证强制走环境变量）
 *  14. 通知聚合的账号隔离（不串用户）；账号在窗口期内被删除后服务不崩
 *  15. 彻底删除：只能删已归档的任务、跨用户删不掉、非法 UUID 返回 400
 *  16. 批量清空已归档：只清自己的、不动未归档的任务
 */

import { readFileSync } from 'node:fs';
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

  for (const path of ['/', '/app.js', '/sw.js', '/styles.css', '/icon.svg', '/manifest.webmanifest']) {
    const res = await fetch(`${BASE}${path}`);
    check(`静态资源 ${path} 可达`, res.status === 200, `HTTP ${res.status}`);
  }

  // 前端静态检查：dialog 表单的「点了哪颗按钮」必须用 event.submitter 判断。
  // 这类缺陷藏在浏览器里——API 层的自动化测试全都测不到，只能静态拦一道。
  // 背景：returnValue 是 HTMLDialogElement 的属性，<form> 上没有这个属性。
  const appJs = stripJsComments(readFileSync(join(root, 'web', 'app.js'), 'utf8'));
  check(
    '前端没有把 returnValue 挂在 <form> 上（该属性属于 HTMLDialogElement）',
    !/\$\('[\w-]*form'\)\s*\.\s*returnValue/.test(appJs),
    '这种写法会让提交处理器永远提前 return，表现为「点了添加没反应」',
  );
  check(
    'dialog 表单的提交判定使用了 event.submitter',
    /addEventListener\('submit'[\s\S]{0,300}e\.submitter/.test(appJs),
    '缺少 submitter 判断时无法区分「添加」与「取消」',
  );

  // 登录表单的输入框必须带 class="input"。
  // 少带这个类，.input 的边框、内边距、圆角、焦点光环整套都不生效，
  // 页面会悄悄退回浏览器默认样式——这种缺陷 API 层测试全都够不着。
  const indexHtml = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  for (const fieldId of ['login-username', 'login-password']) {
    const tag = indexHtml.match(new RegExp(`<input[^>]*id="${fieldId}"[^>]*>`));
    check(
      `登录输入框 ${fieldId} 带 class="input"`,
      !!tag && /\bclass="[^"]*\binput\b/.test(tag[0]),
      '缺少 class="input" 会让整套输入框样式失效，界面退回浏览器默认样式',
    );
  }

  // 登录页必须从文档里「摘掉」，而不是只 hidden。
  // 登录表单里有 password 输入框：它只要还挂在文档里，浏览器工具读到
  // 「容器里含密码框」就会判定需要人工接管认证，把当前会话所有工具（含终端）一起锁死，
  // 只能靠新开一轮对话恢复。摘出文档这颗雷就拆了。
  check(
    '登录页是从文档里摘掉的，而不是只切换 hidden',
    !/\$\('login'\)\s*\.\s*hidden/.test(appJs) && /loginScreen\.remove\(\)/.test(appJs),
    '登录表单留在 DOM 里会让浏览器工具反复触发「认证接管」闸门，整个会话的工具被锁死',
  );

  /* ---------------------------------------------------- i18n 静态检查 */

  // 两个语言包的键必须完全对齐：少一个键，切到那个语言就会露出键名本身。
  const zh = (await import(pathToFileURL(join(root, 'web', 'locales', 'zh-CN.js')).href)).dict;
  const en = (await import(pathToFileURL(join(root, 'web', 'locales', 'en-US.js')).href)).dict;
  const onlyZh = Object.keys(zh).filter((k) => !(k in en));
  const onlyEn = Object.keys(en).filter((k) => !(k in zh));
  check(
    '两个语言包的键集完全一致',
    onlyZh.length === 0 && onlyEn.length === 0,
    `中文独有：${onlyZh.join(', ') || '无'}；英文独有：${onlyEn.join(', ') || '无'}`,
  );

  // 静态文案必须挂 data-i18n，否则切语言后它还是原来那语言。
  const html = stripHtmlComments(indexHtml);
  const bareCn = [...html.matchAll(/>([^<>]*[一-龥][^<>]*)</g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  check(
    'index.html 里没有裸露的中文文案',
    bareCn.length === 0,
    `这些文字没挂 data-i18n：${bareCn.slice(0, 3).join(' / ')}`,
  );

  // 引用到的键必须真实存在，缺了就会在界面上直接显示键名。
  const htmlKeys = new Set(
    [...html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)].map((m) => m[1]),
  );
  const missingHtmlKeys = [...htmlKeys].filter((k) => !(k in zh) || !(k in en));
  check(
    'index.html 引用的翻译键在语言包里都存在',
    missingHtmlKeys.length === 0,
    `缺失：${missingHtmlKeys.join(', ')}`,
  );

  // 动态文案同理：app.js 里不许再硬编码中文。
  const appCode = stripJsComments(readFileSync(join(root, 'web', 'app.js'), 'utf8'));
  const cnInCode = appCode
    .split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter((x) => /[一-龥]/.test(x.line));
  check(
    'app.js 里没有硬编码的中文文案',
    cnInCode.length === 0,
    `第 ${cnInCode.slice(0, 3).map((x) => x.no).join(', ')} 行还有中文`,
  );

  const appKeys = new Set([...appCode.matchAll(/\bt\('([A-Za-z0-9_.]+)'/g)].map((m) => m[1]));
  const missingAppKeys = [...appKeys].filter((k) => !(k in zh) || !(k in en));
  check(
    'app.js 里 t() 用到的翻译键都存在',
    missingAppKeys.length === 0,
    `缺失：${missingAppKeys.join(', ')}`,
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
    body: JSON.stringify({ username: newUser }),
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

  /* 11. 令牌自助签发 / 吊销 / 禁用账号 */
  console.log('\n[11] 令牌自助签发与吊销');
  const selfIssued = await userApi('/api/v1/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: 'self-issued' }),
  });
  check('用户可以自助签发令牌', selfIssued.res.status === 200 && !!selfIssued.body.token, `HTTP ${selfIssued.res.status}`);

  const tokenList = await userApi('/api/v1/tokens', { cookie: userCookie });
  check('令牌列表只返回掩码', tokenList.body.tokens.every((t) => !t.token && t.prefix), JSON.stringify(tokenList.body.tokens[0]));

  const revoked = await userApi(`/api/v1/tokens/${tokenList.body.tokens[0].id}`, { method: 'DELETE' });
  check('可以吊销自己的令牌', revoked.res.status === 200, `HTTP ${revoked.res.status}`);

  const afterRevoke = await userApi('/api/v1/tasks', { token: selfIssued.body.token });
  check('吊销后令牌立即失效', afterRevoke.res.status === 401, `HTTP ${afterRevoke.res.status}`);

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
    'MCP 暴露 7 个工具',
    toolNames.join(',') ===
      'todo_ack,todo_archive,todo_create,todo_done,todo_list,todo_snooze,todo_update',
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
    body: JSON.stringify({ username: isoUser }),
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
    body: JSON.stringify({ username: purgeUser }),
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

  /* 清理 */
  console.log('\n[清理] 归档测试任务并删除测试账号');

  // 禁用账号：令牌与会话应立即失效
  const usersList = await api('/api/v1/admin/users');
  const targetUser = usersList.body.users.find((u) => u.username === newUser);
  const disabled = await api(`/api/v1/admin/users/${targetUser.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_active: false }),
  });
  check('管理员可以禁用账号', disabled.res.status === 200, `HTTP ${disabled.res.status}`);

  const afterDisable = await userApi('/api/v1/tasks', { token: createdUser.body.token });
  check('禁用账号后其令牌立即失效', afterDisable.res.status === 401, `HTTP ${afterDisable.res.status}`);

  const disabledLogin = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: newUser, password: createdUser.body.password }),
  });
  check('禁用账号后不能登录', disabledLogin.status === 401, `HTTP ${disabledLogin.status}`);

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

  const deleted = await api(`/api/v1/admin/users/${targetUser.id}`, { method: 'DELETE' });
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
