#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, packageRoot, type Config } from './config.js';
import { openDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { TaskService } from './domain/tasks.js';
import { UserService } from './domain/users.js';
import { generatePassword } from './domain/passwords.js';
import { buildServer, ensureBootstrapCredentials } from './http/server.js';
import { NotificationBus } from './notify/bus.js';
import { NotificationOrchestrator } from './notify/orchestrator.js';
import { NotificationScheduler } from './notify/scheduler.js';
import { defaultSessionKey, runStdioServer } from './mcp/server.js';
import {
  cloudCount,
  cloudLastSyncedAt,
  cloudPushTasks,
  pullIntoLocalDb,
  resolveEnvId,
  type LocalTaskRow,
} from './cloud/cloudbase.js';

const USAGE = `AI Todo

用法：
  ai-todo serve      启动 Web 服务与通知编排（默认命令）
  ai-todo mcp        以 stdio 方式运行 MCP Server（供 AI 客户端拉起）
  ai-todo user       用户管理：add / list / passwd / token
  ai-todo token      签发一个新的访问令牌
  ai-todo reset-admin 直接改库重置管理员密码（容器内逃生用，不依赖令牌/HTTP）
  ai-todo migrate    仅执行数据库迁移
  ai-todo cloud      CloudBase 云端同步：push / pull / status

示例：
  ai-todo user add alice --email=alice@x.com   建号并打印初始密码与访问令牌
  ai-todo user list                   列出所有账号
  ai-todo user passwd alice           重置 alice 的密码（打印一次新密码）
  ai-todo user token alice --name=claude  为 alice 签发一枚 MCP 用的令牌
  ai-todo cloud push                  把本地全部任务备份到 CloudBase PostgreSQL
  ai-todo cloud pull                  从云端恢复本地缺失的任务（不触发通知）
  ai-todo cloud status                查看云端环境与本/云两侧的任务数
`;

/* ---------------------------------------------------------------- 小工具 */

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function positional(index: number): string | undefined {
  return process.argv.slice(3).filter((a) => !a.startsWith('--'))[index];
}

/** 读取本地引导凭据文件（data/admin-credentials.txt） */
function readBootstrapFile(config: Config): Record<string, string> {
  const file = join(config.dataDir, 'admin-credentials.txt');
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.startsWith('#')) continue;
    out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

/** 管理员凭据：优先环境变量，其次本地引导文件 */
function adminToken(config: Config): string | null {
  return process.env.AI_TODO_TOKEN?.trim() || readBootstrapFile(config).token || null;
}

function apiBaseUrl(config: Config): string {
  return (
    process.env.AI_TODO_BASE_URL?.trim() || `http://127.0.0.1:${config.port}`
  ).replace(/\/$/, '');
}

async function callApi(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!res.ok) {
    throw new Error(payload?.error?.message ?? `HTTP ${res.status}`);
  }
  return payload;
}

/* ---------------------------------------------------------------- serve */

async function serve(): Promise<void> {
  // 进程级兜底：任何漏网的异步异常都不允许让服务静默退出。
  // Node 默认把未处理的 Promise 拒绝变成进程崩溃，而本地服务一旦崩掉
  // 用户只会看到「页面打不开」，没有任何线索。这里改成记录并继续运行。
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] 未处理的 Promise 拒绝（已记录，服务继续运行）', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[fatal] 未捕获异常（已记录，服务继续运行）', err);
  });

  const config = loadConfig();
  const db = await openDb(config);
  await migrate(db);

  const tasks = new TaskService(db);
  const users = new UserService(db);
  const bootstrap = await ensureBootstrapCredentials(db, config, users);

  const bus = new NotificationBus();
  const orchestrator = new NotificationOrchestrator(tasks, bus, config.baseUrl);
  const scheduler = new NotificationScheduler(tasks, orchestrator);
  scheduler.start();

  const app = await buildServer({ config, db, tasks, users, orchestrator, bus });

  await app.listen({ port: config.port, host: config.host });

  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log('');
  console.log('  AI Todo 已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  监听       ${config.host}:${config.port}${config.host === '0.0.0.0' ? '（全网卡）' : ''}`);
  console.log(`  Web 界面   ${url}`);
  console.log(`  数据库     ${db.driver === 'pg' ? 'PostgreSQL (DATABASE_URL)' : `PGlite (${config.pgliteDir})`}`);
  if (config.mail.enabled) {
    const from = config.mail.from;
    console.log(
      `  发件人     ${from.name ? `${from.name} <${from.address}>` : from.address}`,
    );
    console.log(
      `  SMTP       ${config.mail.host}:${config.mail.port} 认证${
        config.mail.auth ? `开（${config.mail.user}）` : '关（免认证）'
      }`,
    );
  } else {
    console.log('  发件人     （SMTP 未配置，邮件通知已降级为日志模式）');
  }
  console.log(`  管理员     ${bootstrap.adminUser.username ?? 'admin'}`);
  console.log(`  凭据文件   ${join(config.dataDir, 'admin-credentials.txt')}`);
  console.log('');

  if (bootstrap.created && bootstrap.password) {
    console.log('  首次启动，已创建管理员账号：');
    console.log(`    用户名   ${bootstrap.adminUser.username}`);
    console.log(`    初始密码 ${bootstrap.password}`);
    console.log('    （只显示这一次，请立即保存；也可随时查看 data/admin-credentials.txt）');
    console.log('');
  }

  console.log('  浏览器登录：打开上面的地址，用上面的用户名与密码登录。');
  console.log('  建号：npm run user -- add <用户名>');
  console.log('  MCP 接入：在 AI 客户端的 env 里设置 AI_TODO_TOKEN=<访问令牌>');
  console.log('');

  const shutdown = async () => {
    scheduler.stop();
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/* ---------------------------------------------------------------- mcp */

async function runMcp(): Promise<void> {
  const config = loadConfig();

  // 凭证必须由环境变量显式提供：MCP Server 被 AI 客户端拉起，
  // 凭据走环境变量才能保证「谁配的客户端就推给谁」，也不会误写到配置文件里。
  const token = process.env.AI_TODO_TOKEN?.trim();
  if (!token) {
    process.stderr.write(
      '[ai-todo-mcp] 缺少 AI_TODO_TOKEN 环境变量。\n' +
        '           AI 客户端配置必须显式带上凭证，例如：\n' +
        '           {\n' +
        '             "mcpServers": {\n' +
        '               "ai-todo": {\n' +
        '                 "command": "node",\n' +
        '                 "args": ["' +
        join(packageRoot, 'dist', 'src', 'cli.js') +
        '", "mcp"],\n' +
        '                 "env": { "AI_TODO_TOKEN": "ait_xxxxxxxx" }\n' +
        '               }\n' +
        '             }\n' +
        '           }\n' +
        '           令牌可在 Web 端「设置 → 访问令牌」自助签发。\n' +
        '           想让任务标出「哪个工具发的哪个项目」，再加：\n' +
        '             AI_TODO_AGENT=trae            来源标识\n' +
        '             AI_TODO_SOURCE_PROJECT=my-app 来源项目\n',
    );
    process.exit(1);
  }

  const baseUrl =
    process.env.AI_TODO_BASE_URL?.trim() || `http://127.0.0.1:${config.port}`;

  const sessionKey = process.env.AI_TODO_SESSION_KEY?.trim() || defaultSessionKey();
  const agent = process.env.AI_TODO_AGENT?.trim() || 'mcp-client';
  const sourceLabel = process.env.AI_TODO_SOURCE_LABEL?.trim() || undefined;
  const sourceProject = process.env.AI_TODO_SOURCE_PROJECT?.trim() || undefined;

  await runStdioServer({ baseUrl, token, sessionKey, agent, sourceLabel, sourceProject });
}

/* ---------------------------------------------------------------- 用户管理 */

async function userCommand(): Promise<void> {
  const config = loadConfig();
  const sub = (process.argv[3] ?? 'list').toLowerCase();

  const token = adminToken(config);
  if (!token) {
    console.error(
      '找不到管理员凭据。请先运行 npm start 生成 data/admin-credentials.txt，或设置环境变量 AI_TODO_TOKEN。',
    );
    process.exit(1);
  }
  const base = apiBaseUrl(config);

  const call = (method: string, path: string, body?: unknown) =>
    callApi(base, token, method, path, body);

  if (sub === 'list') {
    const { users } = await call('GET', '/api/v1/admin/users');
    console.log('');
    console.log('  用户列表');
    console.log('  ─────────────────────────────────────────');
    for (const u of users) {
      const flags = [u.is_admin ? '管理员' : null].filter(Boolean);
      console.log(
        `  ${(u.username ?? '(无用户名)').padEnd(16)} ${u.display_name ?? ''}${
          flags.length ? `  [${flags.join(' / ')}]` : ''
        }`,
      );
    }
    console.log('');
    return;
  }

  if (sub === 'add') {
    const username = positional(1) ?? argValue('username');
    const email = argValue('email');
    if (!username || !email) {
      console.error(
        '用法：ai-todo user add <用户名> --email=<邮箱> [--password=xxx] [--display-name=xx] [--admin]',
      );
      console.error('账号必须绑定邮箱：任务邮件与转交通知都发到这个地址。');
      process.exit(1);
    }
    const payload = await call('POST', '/api/v1/admin/users', {
      username,
      email,
      password: argValue('password'),
      display_name: argValue('display-name'),
      is_admin: hasFlag('admin') || undefined,
    });
    console.log('');
    console.log('  账号已创建');
    console.log('  ─────────────────────────────────────────');
    console.log(`  用户名   ${payload.user.username}`);
    console.log(`  邮箱     ${payload.user.email ?? '-'}`);
    console.log(`  初始密码 ${payload.password}`);
    console.log(`  访问令牌 ${payload.token}`);
    console.log('');
    console.log('  初始密码与访问令牌只显示这一次，请立即保存。');
    console.log('  MCP 客户端请把访问令牌放进 AI_TODO_TOKEN 环境变量。');
    console.log('');
    return;
  }

  const target = positional(1);
  if (!target) {
    console.error('用法：ai-todo user <passwd|delete|token> <用户名>');
    process.exit(1);
  }

  const { users } = await call('GET', '/api/v1/admin/users');
  const user = users.find((u: any) => u.username === target.toLowerCase());
  if (!user) {
    console.error(`找不到用户：${target}`);
    process.exit(1);
  }

  if (sub === 'passwd') {
    // 不指定就随机生成一个，只显示这一次
    const password = argValue('password') ?? generatePassword(20);
    const payload = await call('PATCH', `/api/v1/admin/users/${user.id}`, { password });
    console.log('');
    console.log(`  ${user.username} 的密码已重置`);
    console.log('  ─────────────────────────────────────────');
    console.log(`  新密码 ${payload.password}`);
    console.log('');
    console.log('  只显示这一次，请立即保存。');
    console.log('');
    return;
  }

  if (sub === 'delete') {
    await call('DELETE', `/api/v1/admin/users/${user.id}`);
    console.log(`  ${user.username} 已删除（其任务、会话与令牌一并清除）`);
    console.log('');
    return;
  }

  if (sub === 'token') {
    const payload = await call('POST', `/api/v1/admin/users/${user.id}/tokens`, {
      name: argValue('name') ?? 'mcp-client',
    });
    console.log('');
    console.log(`  已为 ${user.username} 签发访问令牌`);
    console.log('  ─────────────────────────────────────────');
    console.log(`  ${payload.token}`);
    console.log('');
    console.log('  只显示这一次。放进 AI 客户端的 MCP 配置：');
    console.log('');
    printMcpConfig(base, payload.token);
    return;
  }

  console.error(`未知子命令：user ${sub}`);
  console.log(USAGE);
  process.exit(1);
}

/**
 * 打印 MCP 客户端配置示例。
 *
 * 两种传输都给出来：
 * - **远程 HTTP（推荐）**：客户端机器什么都不用装，只要一个 URL + 令牌
 * - **stdio**：客户端与服务端在同一台机器时用
 *
 * 顺带提示来源标识相关的环境变量——用户真正缺的往往不是配置本身，
 * 而是「推过来的任务看不出是哪个工具发的」。
 */
function printMcpConfig(base: string, token: string): void {
  const httpUrl = `${base.replace(/\/$/, '')}/mcp`;
  console.log('  ── 方案一：远程 HTTP（推荐，客户端机器什么都不用装）──');
  console.log('  {');
  console.log('    "mcpServers": {');
  console.log('      "ai-todo": {');
  console.log(`        "url": "${httpUrl}",`);
  console.log('        "headers": {');
  console.log(`          "Authorization": "Bearer ${token}"`);
  console.log('        }');
  console.log('      }');
  console.log('    }');
  console.log('  }');
  console.log('');
  console.log('  ── 方案二：stdio（客户端与服务端在同一台机器时）──');
  console.log('  {');
  console.log('    "mcpServers": {');
  console.log('      "ai-todo": {');
  console.log('        "command": "node",');
  console.log(`        "args": ["${join(packageRoot, 'dist', 'src', 'cli.js')}", "mcp"],`);
  console.log('        "env": {');
  console.log(`          "AI_TODO_BASE_URL": "${base}",`);
  console.log(`          "AI_TODO_TOKEN": "${token}"`);
  console.log('        }');
  console.log('      }');
  console.log('    }');
  console.log('  }');
  console.log('');
  console.log('  令牌决定任务推给哪个账号。想在任务上标出「哪个工具发的哪个项目」，');
  console.log('  远程 HTTP 方式加请求头，stdio 方式加环境变量：');
  console.log('');
  console.log('    AI_TODO_AGENT=trae             来源标识（工具名，显示在任务卡片上）');
  console.log('    AI_TODO_SOURCE_PROJECT=my-app  来源项目（AI 没指定 project 时用它兜底）');
  console.log('');
}

/* ---------------------------------------------------------------- token */

async function mintToken(): Promise<void> {
  const config = loadConfig();
  const token = adminToken(config);
  if (!token) {
    console.error(
      '找不到管理员凭据。请先运行 npm start 生成 data/admin-credentials.txt，或设置环境变量 AI_TODO_TOKEN。',
    );
    process.exit(1);
  }

  const name = argValue('name') ?? 'mcp-client';
  const base = apiBaseUrl(config);

  const payload = await callApi(base, token, 'POST', '/api/v1/tokens', { name });

  console.log('');
  console.log('  令牌已生成（只显示这一次，请立即保存）');
  console.log('  ─────────────────────────────────────────');
  console.log(`  ${payload.token}`);
  console.log('');
  console.log('  MCP 客户端配置示例：');
  printMcpConfig(base, payload.token);
}

/* ------------------------------------------------- reset-admin（改库逃生） */

/**
 * 绕过 HTTP 与访问令牌，直接在数据库里重置账号密码。
 * 用途：管理员密码彻底丢失且环境变量通道也没生效时的最后手段，
 * 进容器执行：
 *   node dist/src/cli.js reset-admin --password=<至少 8 位>
 */
async function resetAdminCommand(): Promise<void> {
  const config = loadConfig();
  const username = (argValue('username') ?? 'admin').trim().toLowerCase();
  const password = argValue('password') ?? generatePassword(20);
  if (password.length < 8) {
    console.error('密码至少 8 位。用法：reset-admin --username=admin --password=xxxxxxxx');
    process.exit(1);
  }

  const db = await openDb(config);
  try {
    await migrate(db);
    const users = new UserService(db);
    let target = await users.findByUsername(username);
    if (!target) {
      // 兜底：指定用户名不存在时，取库里最早的一个有用户名的账号
      const res = await db.query<{ id: string }>(
        `select id from users where username is not null order by created_at limit 1`,
      );
      if (res.rows[0]) target = await users.findById(res.rows[0].id);
    }
    if (!target) {
      console.error('数据库里还没有任何账号。请先正常启动一次服务以创建管理员，再执行本命令。');
      process.exit(1);
    }

    await users.setPassword(target.id, password);

    // 同步更新凭据文件，保证 data/admin-credentials.txt 里的密码始终可用
    try {
      const credFile = join(config.dataDir, 'admin-credentials.txt');
      let lines: string[] = [];
      if (existsSync(credFile)) {
        lines = readFileSync(credFile, 'utf8').split(/\r?\n/).filter(Boolean);
      }
      const kept = lines.filter(
        (l) => !l.startsWith('#') && !l.startsWith('password=') && !l.startsWith('username='),
      );
      const header = lines.filter((l) => l.startsWith('#'));
      const body = [
        ...header,
        `username=${target.username}`,
        `password=${password}`,
        ...kept,
      ];
      mkdirSync(config.dataDir, { recursive: true });
      writeFileSync(credFile, `${body.join('\n')}\n`, 'utf8');
    } catch (err) {
      console.error(`凭据文件更新失败（不影响密码本身）：${err instanceof Error ? err.message : err}`);
    }

    console.log('');
    console.log('  密码已直接写入数据库（不经过 HTTP 与访问令牌）');
    console.log('  ─────────────────────────────────────────');
    console.log(`  账号     ${target.username}`);
    console.log(`  新密码   ${password}`);
    console.log('');
    console.log('  请立即用该密码登录，并在「设置」中改成自己的密码。');
    console.log('');
  } finally {
    await db.close();
  }
}

/* ---------------------------------------------------------------- cloud */

async function cloudCommand(): Promise<void> {
  const sub = (process.argv[3] ?? 'status').toLowerCase();
  const envId = resolveEnvId();
  if (!envId) {
    console.error(
      '找不到 CloudBase 环境 ID。请先 tcb login && tcb env use <envId>，或设置环境变量 CLOUDBASE_ENV_ID。',
    );
    process.exit(1);
  }

  if (sub === 'push' || sub === 'pull') {
    const config = loadConfig();
    const db = await openDb(config);
    try {
      if (sub === 'push') {
        const res = await db.query<LocalTaskRow>(
          `SELECT id, user_id, title, detail, status, severity, project, links, due_at, created_at, updated_at FROM tasks`,
        );
        console.log(`本地任务 ${res.rows.length} 条，开始推送到云端 ${envId} ...`);
        const pushed = await cloudPushTasks(res.rows);
        const total = await cloudCount();
        console.log('');
        console.log(`  ✔ 已同步 ${pushed} 条，云端现共 ${total} 条（表 ${'cloud_todos'}）`);
        console.log('');
      } else {
        console.log(`从云端 ${envId} 拉取任务 ...`);
        const result = await pullIntoLocalDb(db);
        console.log('');
        console.log('  恢复完成');
        console.log('  ─────────────────────────────────────────');
        console.log(`  云端任务总数        ${result.cloudTotal}`);
        console.log(`  新恢复到本地        ${result.inserted}`);
        console.log(`  本地已存在（跳过）  ${result.skippedExisting}`);
        if (result.skippedUnknownUser > 0) {
          console.log(`  用户不存在（跳过）  ${result.skippedUnknownUser}`);
        }
        console.log('');
        console.log('  说明：恢复的任务不会触发通知。');
        console.log('');
      }
    } finally {
      await db.close();
    }
    return;
  }

  if (sub === 'status') {
    console.log('');
    console.log('  CloudBase 云端同步状态');
    console.log('  ─────────────────────────────────────────');
    console.log(`  环境     ${envId}`);
    try {
      const [total, lastSync] = await Promise.all([cloudCount(), cloudLastSyncedAt()]);
      const config = loadConfig();
      const db = await openDb(config);
      let localCount = '?';
      try {
        const res = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM tasks`);
        localCount = res.rows[0]?.n ?? '0';
      } finally {
        await db.close();
      }
      console.log(`  本地任务 ${localCount}`);
      console.log(`  云端任务 ${total}`);
      console.log(`  最近同步 ${lastSync ?? '从未'}`);
    } catch (err) {
      console.log(`  云端状态获取失败：${err instanceof Error ? err.message : err}`);
      console.log('  提示：凭证过期时重新运行 tcb login 即可。');
    }
    console.log('');
    return;
  }

  console.error(`未知子命令：cloud ${sub}（可用：push / pull / status）`);
  console.log(USAGE);
  process.exit(1);
}

/* ---------------------------------------------------------------- main */

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  switch (command) {
    case 'serve':
      return serve();
    case 'mcp':
      return runMcp();
    case 'user':
      return userCommand();
    case 'token':
      return mintToken();
    case 'reset-admin':
      return resetAdminCommand();
    case 'migrate':
      return migrateOnly();
    case 'cloud':
      return cloudCommand();
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      console.error(`未知命令：${command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

async function migrateOnly(): Promise<void> {
  const config = loadConfig();
  const db = await openDb(config);
  await migrate(db);
  console.log('迁移完成。');
  await db.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
