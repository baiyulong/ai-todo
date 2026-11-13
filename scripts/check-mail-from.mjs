#!/usr/bin/env node
/**
 * SMTP FROM 解析 + 真实发信验证
 *
 * 1) 直接跑 loadConfig 的 from 解析，覆盖各种写法
 * 2) 起一个本地最小 SMTP 捕获器，用 createMailer 真发一封，
 *    检查 DATA 里的 From: 头是否带显示名
 */
import { loadConfig } from '../dist/src/config.js';
import { createMailer } from '../dist/src/mail/mailer.js';
import net from 'node:net';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ---------- 1. 解析用例（直接改 env 再 loadConfig） ---------- */

const cases = [
  // [env 值, 期望 name, 期望 address]
  ['AI Todo <todo@qq.com>', 'AI Todo', 'todo@qq.com'],
  ['AI Todo<todo@qq.com>', 'AI Todo', 'todo@qq.com'],
  ['"AI Todo" <todo@qq.com>', 'AI Todo', 'todo@qq.com'],
  ['“AI Todo” <todo@qq.com>', 'AI Todo', 'todo@qq.com'],
  ['"AI Todo <todo@qq.com>"', 'AI Todo', 'todo@qq.com'],      // 整串带引号
  ['AI Todo ＜todo@qq.com＞', 'AI Todo', 'todo@qq.com'],       // 全角尖括号
  ['todo@qq.com', '', 'todo@qq.com'],                          // 纯地址
  ['AI Todo 助手', 'AI Todo 助手', 'user@qq.com'],              // 只填显示名 → 地址回落 SMTP_USER
  ['', '', 'user@qq.com'],                                     // 未填 → 回落 SMTP_USER
  ['坏地址 <not-an-email>', '坏地址', 'user@qq.com'],           // 地址非法 → 回落但名字保留
];

for (const [raw, wantName, wantAddr] of cases) {
  process.env.AI_TODO_SMTP_USER = 'user@qq.com';
  process.env.AI_TODO_SMTP_HOST = '127.0.0.1';
  if (raw === '') delete process.env.AI_TODO_SMTP_FROM;
  else process.env.AI_TODO_SMTP_FROM = raw;
  const cfg = loadConfig();
  const got = cfg.mail.from;
  check(
    `FROM=${JSON.stringify(raw)} → ${wantName ? `${wantName} <${wantAddr}>` : wantAddr}`,
    got.name === wantName && got.address === wantAddr,
    `got name=${JSON.stringify(got.name)} addr=${got.address}`,
  );
}

/* ---------- 2. 真实发信：本地 SMTP 捕获器 ---------- */

const captured = { mailFrom: '', data: '' };
const server = net.createServer((socket) => {
  let stage = 0;
  socket.write('220 catcher ready\r\n');
  socket.on('data', (chunk) => {
    const lines = chunk.toString().split('\r\n').filter(Boolean);
    for (const line of lines) {
      if (stage === 0) {
        if (line.startsWith('EHLO') || line.startsWith('HELO')) {
          socket.write('250-catcher\r\n250 OK\r\n');
        } else if (line.startsWith('MAIL FROM:')) {
          captured.mailFrom = line;
          socket.write('250 OK\r\n');
        } else if (line.startsWith('RCPT TO:')) {
          socket.write('250 OK\r\n');
        } else if (line.startsWith('DATA')) {
          socket.write('354 go\r\n');
          stage = 1;
        } else if (line === 'QUIT') {
          socket.write('221 bye\r\n'); socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      } else {
        // DATA 阶段：收到单独的 . 表示结束
        if (line === '.') {
          captured.data += '\r\n';
          socket.write('250 OK\r\n');
          stage = 0;
        } else {
          captured.data += line + '\r\n';
        }
      }
    }
  });
});

await new Promise((r) => server.listen(19245, '127.0.0.1', r));

process.env.AI_TODO_SMTP_HOST = '127.0.0.1';
process.env.AI_TODO_SMTP_PORT = '19245';
process.env.AI_TODO_SMTP_SECURE = 'off';
process.env.AI_TODO_SMTP_USER = 'user@qq.com';
process.env.AI_TODO_SMTP_FROM = 'AI Todo 助手 <todo@qq.com>';
const cfg = loadConfig();
const mailer = createMailer(cfg.mail);
await mailer.send({ to: 'someone@example.com', subject: 'FROM 测试', text: 'hello', html: '<p>hello</p>' });

const fromHeader = captured.data.split('\r\n').find((l) => /^From:/i.test(l)) ?? '';
// nodemailer 会把非 ASCII 显示名编码成 RFC2047（=?UTF-8?Q?...?=），两种形态都算带显示名
const hasName =
  /AI Todo/.test(fromHeader) ||
  (/^From:\s*=\?UTF-8\?/i.test(fromHeader) && /<todo@qq\.com>/.test(fromHeader));
check('真实发信 From: 头带显示名', hasName && /<todo@qq\.com>/.test(fromHeader), `From header: ${JSON.stringify(fromHeader)}`);
console.log(`  From 头原文: ${fromHeader}`);

server.close();
console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
