import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 解析包根目录：从当前模块向上找到 package.json。
 * 编译产物位于 dist/src/**，因此固定向上三级再兜底。
 */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export const packageRoot = findPackageRoot();

export function loadDotEnv(): void {
  const file = join(packageRoot, '.env');
  if (!existsSync(file)) return;
  // 极简解析：KEY=VALUE，支持 # 注释与成对引号
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export interface Config {
  port: number;
  host: string;
  baseUrl: string;
  databaseUrl?: string;
  pgliteDir: string;
  dataDir: string;
  webDir: string;
  cookieName: string;
  sessionTtlDays: number;
  logLevel: string;
  /** 远程 MCP 端点（/mcp）是否开启 */
  mcpHttpEnabled: boolean;
  /** 保留给未来的外部通道（配置 B）；配置 A 下始终为空 */
  externalChannels: string[];
}

export function loadConfig(): Config {
  loadDotEnv();

  const port = Number(process.env.AI_TODO_PORT ?? 8787);
  const host = process.env.AI_TODO_HOST ?? '127.0.0.1';
  const dataDir = resolve(packageRoot, process.env.AI_TODO_DATA_DIR ?? 'data');
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;

  return {
    port,
    host,
    baseUrl: process.env.AI_TODO_BASE_URL ?? `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    databaseUrl,
    pgliteDir: resolve(dataDir, 'pgdata'),
    dataDir,
    webDir: resolve(packageRoot, process.env.AI_TODO_WEB_DIR ?? 'web'),
    cookieName: 'ai_todo_session',
    sessionTtlDays: Number(process.env.AI_TODO_SESSION_TTL_DAYS ?? 30),
    logLevel: process.env.AI_TODO_LOG_LEVEL ?? 'info',
    mcpHttpEnabled: (process.env.AI_TODO_MCP_HTTP ?? 'on').trim().toLowerCase() !== 'off',
    externalChannels: [],
  };
}
