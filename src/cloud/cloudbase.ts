/**
 * AI Todo · CloudBase 云端同步（配置 A 扩展）
 *
 * 为什么走 tcb CLI 而不是 @cloudbase/node-sdk：
 * - 本环境是免费体验版，文档型数据库（NoSQL）未开通，node-sdk 的 db API 不可用；
 * - 可用的是环境自带的 PostgreSQL，通过 `tcb db execute --sql` 访问；
 * - CLI 自己管理并刷新临时凭证（~/.config/.cloudbase/auth.json），不用在代码里碰密钥。
 *
 * 每次执行会拉起一个 tcb 子进程（约 2~4 秒），因此写入按块合并成
 * 多值 INSERT，尽量减少进程次数。
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/* ---------------------------------------------------------------- 配置 */

export const CLOUD_TABLE = 'cloud_todos';

/** 环境解析优先级：环境变量 > tcb 全局配置（~/.config/.cloudbase/global.json） */
export function resolveEnvId(): string | null {
  const fromEnv = process.env.CLOUDBASE_ENV_ID?.trim();
  if (fromEnv) return fromEnv;
  const file = join(homedir(), '.config', '.cloudbase', 'global.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed.currentEnvId?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 解析 tcb 调用方式。
 *
 * 首选 `node + cli.js` 直调：execFile 传参数组，SQL 里的引号、括号、百分号
 * 都不会被 shell 二次解释；`.cmd` shim 必须走 shell，Windows 的 cmd 对
 * `%`、`&` 等字符的处理不可控，任务标题很容易踩雷。
 *
 * 优先级：环境变量 CLOUDBASE_CLI（退化到 shell 拼接）→ WorkBuddy 自带
 * standalone cli.js → PATH 上的 tcb。
 */
interface TcbInvocation {
  cmd: string;
  baseArgs: string[];
  useShell: boolean;
}

function resolveTcb(): TcbInvocation {
  const custom = process.env.CLOUDBASE_CLI?.trim();
  if (custom) return { cmd: custom, baseArgs: [], useShell: true };

  const cliJs = join(
    homedir(),
    '.workbuddy',
    'binaries',
    'node',
    'cli-connector-packages',
    'node_modules',
    '@cloudbase',
    'cli',
    'dist',
    'standalone',
    'cli.js',
  );
  if (existsSync(cliJs)) return { cmd: process.execPath, baseArgs: [cliJs], useShell: false };
  return { cmd: process.platform === 'win32' ? 'tcb.cmd' : 'tcb', baseArgs: [], useShell: true };
}

/* ---------------------------------------------------------------- SQL 执行 */

interface CloudExecuteResult {
  rows: any[][];
  affectedRows: number;
}

/** 从混合输出里截出 JSON：CLI 偶尔会在 JSON 前打印进度行 */
function parseJsonPayload(stdout: string): any {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error(`tcb 输出里没有 JSON：${stdout.slice(0, 200)}`);
  return JSON.parse(stdout.slice(start));
}

async function runTcb(args: string[], timeoutMs = 120_000): Promise<string> {
  const inv = resolveTcb();
  // promisify(execFile) 的重载把 shell 收窄成 string，这里显式放宽
  const options = {
    shell: inv.useShell,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  } as any;
  try {
    const { stdout } = await execFileAsync(inv.cmd, [...inv.baseArgs, ...args], options);
    return typeof stdout === 'string' ? stdout : String(stdout);
  } catch (err: any) {
    // shell 兜底路径下错误信息往往为空，补一句调用方式方便排查
    const detail = err?.stderr || err?.message || '未知错误';
    throw new Error(`tcb 调用失败（${inv.cmd}）：${String(detail).slice(0, 400)}`);
  }
}

/** 在云端执行一条 SQL，返回行（每行是列值数组）与受影响行数 */
export async function cloudSql(sql: string): Promise<CloudExecuteResult> {
  const envId = resolveEnvId();
  if (!envId) {
    throw new Error('找不到 CloudBase 环境 ID：请先 tcb login 并 tcb env use，或设置 CLOUDBASE_ENV_ID');
  }
  const stdout = await runTcb(['db', 'execute', '--sql', sql, '--json', '-e', envId]);
  const payload = parseJsonPayload(stdout);
  if (payload.error) {
    const err = payload.error;
    throw new Error(`云端 SQL 执行失败：${err.message || err.code || '未知错误'}`);
  }
  const data = payload.data ?? {};
  const rows: any[][] = (data.Rows ?? [])
    .map((r: unknown) => {
      if (typeof r !== 'string') return Array.isArray(r) ? r : [r];
      try {
        return JSON.parse(r);
      } catch {
        return [r];
      }
    })
    .filter(Boolean);
  return { rows, affectedRows: data.AffectedRows ?? 0 };
}

/* ---------------------------------------------------------------- 值转义 */

/** SQL 字面量转义：单引号翻倍；undefined/null → NULL */
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

function bool(v: unknown): string {
  return v ? 'true' : 'false';
}

/* ---------------------------------------------------------------- 数据结构 */

/** 云端行（列序与 SELECT 显式列一致） */
export interface CloudTask {
  id: string;
  user_id: string;
  title: string;
  detail: string | null;
  status: string;
  severity: string;
  project: string | null;
  links: unknown;
  due_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  synced_at: string;
}

/** 本地任务行（select * from tasks 的子集，字段宽松处理） */
export interface LocalTaskRow {
  id: string;
  user_id: string;
  title: string;
  detail: string | null;
  status: string;
  severity: string;
  project: string | null;
  links: unknown;
  due_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

/* ---------------------------------------------------------------- 表管理 */

const CLOUD_COLUMNS = `(
  id text primary key,
  user_id text not null,
  title text not null,
  detail text,
  status text,
  severity text,
  project text,
  links jsonb not null default '[]'::jsonb,
  due_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  synced_at timestamptz not null default now()
)`;

export async function ensureCloudTable(): Promise<void> {
  await cloudSql(`CREATE TABLE IF NOT EXISTS ${CLOUD_TABLE} ${CLOUD_COLUMNS}`);
}

/* ---------------------------------------------------------------- push / pull */

/** 每条语句最多多少行 / 多少字节：控制子进程参数长度，避免超长 detail 撑爆命令行 */
const CHUNK_ROWS = 40;
const CHUNK_BYTES = 48 * 1024;

/**
 * 把本地任务批量 upsert 到云端。
 * 返回写入的行数（含更新）。
 */
export async function cloudPushTasks(tasks: LocalTaskRow[]): Promise<number> {
  if (tasks.length === 0) return 0;
  await ensureCloudTable();

  const values = tasks.map((t) => {
    const cols = [
      lit(t.id),
      lit(t.user_id),
      lit(t.title),
      lit(t.detail),
      lit(t.status),
      lit(t.severity),
      lit(t.project),
      lit(t.links ?? []),
      lit(t.due_at),
      lit(t.created_at),
      lit(t.updated_at),
    ];
    return `(${cols.join(', ')})`;
  });

  // 按行数 + 估算字节切块
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const v of values) {
    if (current.length >= CHUNK_ROWS || (bytes + v.length > CHUNK_BYTES && current.length > 0)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(v);
    bytes += v.length;
  }
  if (current.length) chunks.push(current);

  let written = 0;
  for (const chunk of chunks) {
    const sql =
      `INSERT INTO ${CLOUD_TABLE} ` +
      `(id, user_id, title, detail, status, severity, project, links, due_at, created_at, updated_at) ` +
      `VALUES ${chunk.join(', ')} ` +
      `ON CONFLICT (id) DO UPDATE SET ` +
      `user_id = EXCLUDED.user_id, title = EXCLUDED.title, detail = EXCLUDED.detail, ` +
      `status = EXCLUDED.status, severity = EXCLUDED.severity, project = EXCLUDED.project, ` +
      `links = EXCLUDED.links, due_at = EXCLUDED.due_at, ` +
      `created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, synced_at = now()`;
    const res = await cloudSql(sql);
    written += res.affectedRows || chunk.length;
  }
  return written;
}

const SELECT_COLUMNS =
  'id, user_id, title, detail, status, severity, project, links, due_at, created_at, updated_at, synced_at';

/** 拉取云端全部任务（按更新时间倒序） */
export async function cloudPullTasks(limit = 500): Promise<CloudTask[]> {
  const res = await cloudSql(
    `SELECT ${SELECT_COLUMNS} FROM ${CLOUD_TABLE} ORDER BY updated_at DESC NULLS LAST LIMIT ${Math.max(1, Math.min(1000, limit | 0))}`,
  );
  return res.rows.map((cols) => ({
    id: cols[0],
    user_id: cols[1],
    title: cols[2],
    detail: cols[3],
    status: cols[4],
    severity: cols[5],
    project: cols[6],
    links: cols[7],
    due_at: cols[8],
    created_at: cols[9],
    updated_at: cols[10],
    synced_at: cols[11],
  }));
}

export async function cloudCount(): Promise<number> {
  const res = await cloudSql(`SELECT count(*)::int FROM ${CLOUD_TABLE}`);
  return Number(res.rows[0]?.[0] ?? 0);
}

export async function cloudLastSyncedAt(): Promise<string | null> {
  const res = await cloudSql(`SELECT max(synced_at)::text FROM ${CLOUD_TABLE}`);
  const v = res.rows[0]?.[0];
  return v && v !== 'NULL' && v !== null ? String(v) : null;
}

/* ---------------------------------------------------------------- 同步编排 */

export interface PushResult {
  pushed: number;
  cloudTotal: number;
}

export interface PullResult {
  inserted: number;
  skippedExisting: number;
  skippedUnknownUser: number;
  cloudTotal: number;
}

/**
 * pull 时把云端行插回本地 tasks 表。
 * - 幂等：ON CONFLICT (id) DO NOTHING，已存在的不动（本地状态优先）；
 * - 不触发通知：notify_requested 固定 false，恢复数据不该把人轰炸一遍；
 * - user_id 在本地 users 表里不存在（比如换了本地库）的行跳过并计数。
 */
/** 云端 jsonb 可能以「JSON 字符串」或已解析对象两种形态返回，统一还原成对象/数组 */
function normalizeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function pullIntoLocalDb(db: {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
}): Promise<PullResult> {
  const cloudTasks = (await cloudPullTasks()).map((t) => ({
    ...t,
    links: normalizeJson(t.links),
  }));

  const usersRes = await db.query<{ id: string }>(`SELECT id FROM users`);
  const knownUsers = new Set(usersRes.rows.map((r) => String(r.id)));

  const localRes = await db.query<{ id: string }>(`SELECT id FROM tasks`);
  const localIds = new Set(localRes.rows.map((r) => String(r.id)));

  let inserted = 0;
  let skippedExisting = 0;
  let skippedUnknownUser = 0;

  const pending = cloudTasks.filter((t) => {
    if (localIds.has(String(t.id))) {
      skippedExisting++;
      return false;
    }
    if (!knownUsers.has(String(t.user_id))) {
      skippedUnknownUser++;
      return false;
    }
    return true;
  });

  // 同 push 一样按块写入
  const chunks: CloudTask[][] = [];
  let current: CloudTask[] = [];
  for (const t of pending) {
    current.push(t);
    if (current.length >= CHUNK_ROWS) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length) chunks.push(current);

  for (const chunk of chunks) {
    const values = chunk.map((t) => {
      const cols = [
        lit(t.id),
        lit(t.user_id),
        lit(t.title),
        lit(t.detail),
        lit(t.status),
        lit(t.severity),
        lit(t.project),
        lit(t.links ?? []),
        'false', // notify_requested：恢复不通知
        lit(t.due_at),
        lit(t.created_at),
        lit(t.updated_at),
      ];
      return `(${cols.join(', ')})`;
    });
    const sql =
      `INSERT INTO tasks ` +
      `(id, user_id, title, detail, status, severity, project, links, notify_requested, due_at, created_at, updated_at) ` +
      `VALUES ${values.join(', ')} ` +
      `ON CONFLICT (id) DO NOTHING`;
    const res = await db.query(sql);
    inserted += res.rowCount || 0;
  }

  return {
    inserted,
    skippedExisting,
    skippedUnknownUser,
    cloudTotal: cloudTasks.length,
  };
}
