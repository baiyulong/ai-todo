#!/usr/bin/env node
/**
 * SMTP 认证开关验证
 *
 * 用本地最小 SMTP 捕获器记录客户端发来的全部命令，跑三种配置：
 *   1. 只配 user（不配 pass）→ 自动免认证，对话里不得出现 AUTH
 *   2. user + pass 都配      → 自动走认证，对话里必须出现 AUTH
 *   3. AI_TODO_SMTP_AUTH=off（user+pass 都配）→ 显式关掉，不得出现 AUTH
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

let lastDialogue = '';
function startCatcher(port) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let stage = 0;
      socket.write('220 catcher ready\r\n');
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
          lastDialogue += line + '\n';
          if (stage === 0) {
            if (line.startsWith('EHLO') || line.startsWith('HELO')) {
              socket.write('250-catcher\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
            } else if (line.startsWith('AUTH')) {
              socket.write('235 ok\r\n'); // 认证成功，便于跑完
            } else if (line.startsWith('DATA')) {
              socket.write('354 go\r\n');
              stage = 1;
            } else if (line === 'QUIT') {
              socket.write('221 bye\r\n'); socket.end();
            } else {
              socket.write('250 OK\r\n');
            }
          } else if (line === '.') {
            socket.write('250 OK\r\n');
            stage = 0;
          }
        }
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const server = await startCatcher(19246);
const PORT = String(19246);

async function runCase(name, env, expectAuth) {
  lastDialogue = '';
  delete process.env.AI_TODO_SMTP_USER;
  delete process.env.AI_TODO_SMTP_PASS;
  delete process.env.AI_TODO_SMTP_AUTH_CODE;
  delete process.env.AI_TODO_SMTP_AUTH;
  Object.assign(process.env, {
    AI_TODO_SMTP_HOST: '127.0.0.1',
    AI_TODO_SMTP_PORT: PORT,
    AI_TODO_SMTP_SECURE: 'off',
    ...env,
  });
  const cfg = loadConfig();
  const mailer = createMailer(cfg.mail);
  await mailer.send({ to: 'x@example.com', subject: 'auth test', text: 'hi' });
  const authed = /^AUTH /m.test(lastDialogue);
  check(`${name} → ${expectAuth ? '发 AUTH' : '不发 AUTH'}`, authed === expectAuth, authed ? '发了 AUTH' : '没发 AUTH');
}

await runCase('只配 user=admin@lenovo.com（免认证中继场景）', { AI_TODO_SMTP_USER: 'admin@lenovo.com' }, false);
await runCase('user + pass 都配', { AI_TODO_SMTP_USER: 'u@qq.com', AI_TODO_SMTP_PASS: 'secret123' }, true);
await runCase('user + pass 都配但 AUTH=off', { AI_TODO_SMTP_USER: 'u@qq.com', AI_TODO_SMTP_PASS: 'secret123', AI_TODO_SMTP_AUTH: 'off' }, false);
await runCase('user + 授权码 AUTH_CODE', { AI_TODO_SMTP_USER: 'u@qq.com', AI_TODO_SMTP_AUTH_CODE: 'authcode' }, true);

// 配置对象本身也要带对 auth 标志
process.env.AI_TODO_SMTP_USER = 'admin@lenovo.com';
delete process.env.AI_TODO_SMTP_PASS;
delete process.env.AI_TODO_SMTP_AUTH_CODE;
delete process.env.AI_TODO_SMTP_AUTH;
const cfg = loadConfig();
check('loadConfig: 只配 user 时 mail.auth=false', cfg.mail.auth === false, `auth=${cfg.mail.auth}`);

server.close();
console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail > 0 ? 1 : 0);
