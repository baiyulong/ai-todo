#!/usr/bin/env node
/**
 * SMTP 连通性 / 发信自检脚本（可在服务器或容器里直接跑）
 *
 * 用法（在应用目录下，node_modules 里有 nodemailer 即可）：
 *   node scripts/smtp-test.mjs --to=收件人@lenovo.com
 *
 * 可选覆盖（不传就自动读 AI_TODO_SMTP_* 环境变量，与应用行为完全一致）：
 *   --host=smtpinternal.lenovo.com  --port=25
 *   --secure=off                    （465 隐式 TLS 时为 on，其他端口 off）
 *   --auth=off                      （免认证中继必须 off）
 *   --user=admin@lenovo.com         --pass=xxx
 *   --from=AI Todo <no-reply@lenovo.com>
 *
 * 脚本做三件事并打印完整 SMTP 对话：
 *   1. TCP 连通性（排除网络/防火墙）
 *   2. SMTP 握手 + 认证（verify）
 *   3. 真实发一封测试邮件
 * 每一步给出 成功/失败 与对应的排查提示，把全部输出发回来即可定位问题。
 */
import net from 'node:net';
import util from 'node:util';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/* ---------------- 参数与环境变量 ---------------- */

const argv = Object.fromEntries(
  process.argv.slice(2)
    .map((a) => {
      const eq = a.indexOf('=');
      return eq > 0 ? [a.slice(2, eq), a.slice(eq + 1)] : [a.slice(2), ''];
    })
    .filter(([k]) => k),
);
const env = (k, d = '') => (argv[k.toLowerCase().replace(/^ai_todo_/, '')] ?? process.env[k] ?? d).toString().trim();
const arg = (k, d = '') => (argv[k] ?? d).toString().trim();

const host = arg('host') || env('AI_TODO_SMTP_HOST');
const to = arg('to');
const port = Number(arg('port') || env('AI_TODO_SMTP_PORT', '25'));
const secureRaw = (arg('secure') || env('AI_TODO_SMTP_SECURE') || (port === 465 ? 'on' : 'off')).toLowerCase();
const secure = ['on', 'true', '1', 'yes'].includes(secureRaw);
const user = arg('user') || env('AI_TODO_SMTP_USER');
const pass = arg('pass') || env('AI_TODO_SMTP_AUTH_CODE', '') || env('AI_TODO_SMTP_PASS', '');
const authRaw = (arg('auth') || env('AI_TODO_SMTP_AUTH') || '').toLowerCase();
const auth = authRaw ? ['on', 'true', '1', 'yes'].includes(authRaw) : Boolean(user && pass);
const smtpUserForFrom = user || env('AI_TODO_SMTP_USER');
const fromRaw = arg('from') || env('AI_TODO_SMTP_FROM') || smtpUserForFrom || 'no-reply@localhost';

// FROM 解析与应用 config.ts 一致：剥引号、全角尖括号归一、拆「名字 <地址>」
const strip = (s) => s.trim().replace(/^["'\u201c\u201d]+|["'\u201c\u201d]+$/g, '');
const norm = strip(fromRaw).replace(/＜|＞|《|》/g, (ch) => (ch === '＜' || ch === '《' ? '<' : '>'));
const m = norm.match(/^(.*?)<([^<>]+)>\s*$/);
const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fromAddr = m ? strip(m[2]) : isEmail.test(norm) ? norm : strip(smtpUserForFrom) || 'no-reply@localhost';
const fromName = m ? strip(m[1]) : isEmail.test(norm) ? '' : norm;

/* ---------------- nodemailer 定位 ---------------- */

async function loadNodemailer() {
  const bases = [
    process.cwd(),
    '/data/server/nodejs-app',
    new URL('.', import.meta.url).pathname.replace(/\/$/, ''),
  ];
  for (const base of bases) {
    try {
      if (existsSync(join(base, 'package.json')) || existsSync(join(base, 'node_modules'))) {
        const req = createRequire(join(base, 'package.json'));
        return req('nodemailer');
      }
    } catch { /* 换下一个位置 */ }
  }
  return (await import('nodemailer')).default;
}
let nodemailer;
try {
  nodemailer = await loadNodemailer();
} catch {
  console.error('✗ 找不到 nodemailer。请在应用根目录（有 node_modules 的地方）运行本脚本。');
  process.exit(2);
}

/* ---------------- 输出工具 ---------------- */

let step = 0;
let failed = false;
const ok = (msg) => console.log(`\n[通过] ${msg}`);
const bad = (msg) => { failed = true; console.log(`\n[失败] ${msg}`); };
const hint = (msg) => console.log(`  ↳ 提示：${msg}`);
console.log('════════════════════════════════════════════');
console.log(' AI Todo SMTP 自检');
console.log('════════════════════════════════════════════');
console.log(`  host   = ${host || '(未配置!)'}`);
console.log(`  port   = ${port}`);
console.log(`  secure = ${secure}（${secure ? '隐式 TLS' : '明文/STARTTLS'}）`);
console.log(`  auth   = ${auth ? `on（${user}）` : 'off（免认证）'}`);
console.log(`  from   = ${fromName ? `${fromName} <${fromAddr}>` : fromAddr}`);
console.log(`  to     = ${to || '(未指定!)'}`);
console.log('');

if (!host || !to) {
  bad('缺少 host 或收件人。用法：node scripts/smtp-test.mjs --to=收件人@lenovo.com');
  process.exit(2);
}

const fmt = (d, m, rest) => {
  if (typeof m === 'string' && m) return util.format(m, ...rest);
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') {
    if (typeof d.message === 'string' && d.message) return d.message;
    // 压掉 nodemailer 的内部事件对象，只留有信息量的字段
    const interesting = { ...d };
    for (const k of ['component', 'sid', 'tnx', 'version', 'name']) delete interesting[k];
    return Object.keys(interesting).length ? JSON.stringify(interesting) : '';
  }
  return '';
};
const logger = {
  level: 'debug',
  debug: (d, m, ...rest) => {
    let s = fmt(d, m, rest);
    // AUTH 命令的 base64 里编码着账号密码，脱敏防止日志外泄
    if (/^AUTH PLAIN [A-Za-z0-9+/=]+$/.test(s.trim())) s = 'AUTH PLAIN [凭据已隐藏]';
    else if (/^AUTH LOGIN$/.test(s.trim())) s = s;
    else if (/^[A-Za-z0-9+/=]{20,}$/.test(s.trim())) s = '[凭据已隐藏]';
    if (s) console.log(`  [对话] ${s}`);
  },
  info: (d, m, ...rest) => { const s = fmt(d, m, rest); if (s) console.log(`  [SMTP] ${s}`); },
  warn: (d, m, ...rest) => { const s = fmt(d, m, rest); if (s) console.log(`  [SMTP!] ${s}`); },
  error: (d, m, ...rest) => { const s = fmt(d, m, rest); if (s) console.log(`  [SMTP✗] ${s}`); },
};
const transport = nodemailer.createTransport({
  host, port, secure,
  auth: auth && user ? { user, pass } : undefined,
  debug: true, logger,
  connectionTimeout: 15_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
  tls: { rejectUnauthorized: false },
});

const diagnose = (err) => {
  const code = err?.code ?? '';
  const resp = String(err?.response ?? '');
  if (code === 'ECONNREFUSED') hint(`${host}:${port} 拒绝连接——网络不通或服务没监听该端口（检查防火墙/安全组/服务是否只对内网开放）`);
  else if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') hint(`连接超时——多半是网络隔离，从容器 ping/telnet ${host} ${port} 验证；或端口协议不对（465 是 TLS、25/587 是明文）`);
  else if (code === 'EAUTH' || resp.includes('535')) hint('认证被拒——服务器不该收到 AUTH。确认 --auth=off 或不配 AI_TODO_SMTP_PASS；反之若需要认证则补齐 user+pass');
  else if (resp.includes('550') || resp.includes('553') || resp.includes('554')) hint(`服务器拒收（${resp.slice(0, 80)}）——常见原因：from 地址不被中继信任（改成认证账号/内部域名地址）、收件人被拒、或该服务器要求 from 为特定域`);
  else if (code === 'EENVELOPE') hint('信封错误——检查 from/to 地址格式');
  else if (code === 'ECONNECTION' || code === 'EPROTO') hint('协议错误——secure 开关可能与端口不匹配（465→on，25/587→off）');
  else hint('把上面的完整 SMTP 对话发回来定位');
};

/* ---------------- 1. TCP 连通性 ---------------- */

console.log(`── 1/3 TCP 连通性 ${host}:${port} ──`);
const tcpOk = await new Promise((resolve) => {
  const t0 = Date.now();
  const sock = net.connect({ host, port, timeout: 8000 }, () => {
    console.log(`  连接成功（${Date.now() - t0}ms）`);
    sock.destroy();
    resolve(true);
  });
  sock.on('timeout', () => { sock.destroy(); resolve(false); });
  sock.on('error', (e) => { console.log(`  连接失败：${e.message}`); resolve(false); });
});
if (tcpOk) ok(`TCP ${host}:${port} 可达`);
else {
  bad(`TCP ${host}:${port} 不可达`);
  hint('先解决网络问题：容器内网络能否到达邮件服务器（内网中继需要同 VPC/内网互通）');
  process.exit(1);
}

/* ---------------- 2. SMTP 握手 ---------------- */

console.log('\n── 2/3 SMTP 握手与认证 ──');
let verifyOk = false;
try {
  await transport.verify();
  verifyOk = true;
  ok('SMTP 握手成功' + (auth ? '（含认证）' : '（免认证）'));
} catch (err) {
  bad(`SMTP 握手失败：${err.message}`);
  diagnose(err);
}

/* ---------------- 3. 真实发信 ---------------- */

console.log('\n── 3/3 真实发一封测试邮件 ──');
try {
  const info = await transport.sendMail({
    from: fromName ? { name: fromName, address: fromAddr } : fromAddr,
    to,
    subject: `[AI Todo 自检] ${new Date().toLocaleString('zh-CN')}`,
    text: '这是一封 AI Todo SMTP 自检测试邮件，收到即说明邮件链路正常。',
  });
  ok(`邮件已提交给服务器：messageId=${info.messageId} response=${info.response}`);
  console.log('\n════════════════════════════════════════════');
  console.log(' 结论：链路正常。收件箱没看到的话：');
  console.log(`   1. 检查 ${to} 的垃圾箱/垃圾邮件`);
  console.log('   2. 内网中继常把外域/陌生 from 投为垃圾邮件或直接丢弃');
  console.log(`   3. 找邮件管理员查 ${fromAddr} → ${to} 的投递日志`);
  console.log('════════════════════════════════════════════');
} catch (err) {
  bad(`发信失败：${err.message}`);
  diagnose(err);
  console.log(`\n（握手阶段结果：${verifyOk ? '通过' : '也失败'}）`);
}

console.log(`\n结果：${failed ? '存在问题，把以上全部输出发回来' : '全部通过'}`);
process.exit(failed ? 1 : 0);
