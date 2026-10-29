import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';

export interface AuthContext {
  userId: string;
  scopes: string[];
  via: 'pat' | 'session';
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('base64url')}`;
}

export function newSessionToken(): string {
  return `ais_${randomBytes(32).toString('base64url')}`;
}

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  scopes: string[];
  revoked_at: string | null;
  is_active: boolean;
}

interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  is_active: boolean;
  is_admin: boolean;
}

/**
 * 鉴权：
 * - Web 端用会话 Cookie（HttpOnly）
 * - MCP / 脚本用 Authorization: Bearer <PAT>
 *
 * PAT 与会话 token 均只存哈希，明文只在签发时出现一次。
 * 两种方式都绑定到具体 user_id——所有任务查询再按 user_id 过滤，
 * 因此用户之间天然互相看不到对方的数据。
 */
export function createAuthenticator(db: Db, cookieName: string) {
  const resolvePat = async (token: string): Promise<AuthContext | null> => {
    const res = await db.query<TokenRow>(
      `select t.id, t.user_id, t.name, t.scopes, t.revoked_at, u.is_active
       from api_tokens t join users u on u.id = t.user_id
       where t.token_hash = $1`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    if (!row || row.revoked_at) return null;
    // 账号被禁用后，其令牌立即失效
    if (!row.is_active) return null;
    await db.query(`update api_tokens set last_used_at = now() where id = $1`, [row.id]);
    return { userId: row.user_id, scopes: row.scopes, via: 'pat' };
  };

  const resolveSession = async (token: string): Promise<AuthContext | null> => {
    const res = await db.query<SessionRow>(
      `select s.id, s.user_id, s.expires_at, u.is_active, u.is_admin
       from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) return null;
    if (!row.is_active) return null;
    await db.query(`update sessions set last_seen_at = now() where id = $1`, [row.id]);
    const scopes = ['tasks:read', 'tasks:write'];
    if (row.is_admin) scopes.push('admin');
    return { userId: row.user_id, scopes, via: 'session' };
  };

  return async function authenticate(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthContext | null> {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const ctx = await resolvePat(header.slice(7).trim());
      if (ctx) {
        (req as FastifyRequest & { auth?: AuthContext }).auth = ctx;
        return ctx;
      }
    }

    const cookie = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[cookieName];
    if (cookie) {
      const ctx = await resolveSession(cookie);
      if (ctx) {
        (req as FastifyRequest & { auth?: AuthContext }).auth = ctx;
        return ctx;
      }
    }

    reply
      .code(401)
      .send({ error: { code: 'unauthorized', message: '需要有效的访问令牌' } });
    return null;
  };
}

export function currentAuth(req: FastifyRequest): AuthContext {
  const ctx = (req as FastifyRequest & { auth?: AuthContext }).auth;
  if (!ctx) throw new Error('路由缺少鉴权中间件');
  return ctx;
}

export function hasScope(ctx: AuthContext, scope: string): boolean {
  return ctx.scopes.includes(scope) || ctx.scopes.includes('admin');
}

/** 创建一个浏览器会话并返回明文 token（只此一次） */
export async function createSession(
  db: Db,
  userId: string,
  ttlDays: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  await db.query(
    `insert into sessions (user_id, token_hash, expires_at) values ($1,$2,$3)`,
    [userId, hashToken(token), expiresAt.toISOString()],
  );
  return { token, expiresAt };
}
