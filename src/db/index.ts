import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  readonly driver: 'pglite' | 'pg';
}

/**
 * PGlite 驱动：编译为 WASM 的 PostgreSQL，零安装、文件持久化。
 * PGlite 是单连接实现，这里串行化所有查询以避免并发冲突。
 */
async function createPgliteDb(dir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  mkdirSync(dirname(dir), { recursive: true });

  const pg = new PGlite(dir);
  await pg.waitReady;

  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    driver: 'pglite',
    async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      return serialize(async () => {
        const res = await pg.query(sql, params as any[]);
        return {
          rows: (res.rows ?? []) as T[],
          rowCount: res.affectedRows ?? res.rows?.length ?? 0,
        };
      });
    },
    async exec(sql: string): Promise<void> {
      await serialize(() => pg.exec(sql));
    },
    async close(): Promise<void> {
      await pg.close();
    },
  };
}

/** 标准 PostgreSQL 驱动（设置 DATABASE_URL 时启用） */
async function createPgDb(url: string): Promise<Db> {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url, max: 10 });
  await pool.query('select 1');

  return {
    driver: 'pg',
    async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const res = await pool.query(sql, params as any[]);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export interface OpenDbOptions {
  databaseUrl?: string;
  pgliteDir: string;
}

export async function openDb(opts: OpenDbOptions): Promise<Db> {
  if (opts.databaseUrl) {
    return createPgDb(opts.databaseUrl);
  }
  return createPgliteDb(opts.pgliteDir);
}
