import type { Db } from '../db/index.js';
import { generatePassword, hashPassword, verifyPassword } from './passwords.js';

export interface User {
  id: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  is_admin: boolean;
  is_active: boolean;
  created_at: string;
}

interface UserRow {
  id: string;
  username: string | null;
  display_name: string | null;
  email: string | null;
  password_hash: string | null;
  is_admin: boolean;
  is_active: boolean;
  created_at: string;
}

const USER_COLUMNS = 'id, username, display_name, email, is_admin, is_active, created_at';

/** 用户名：小写字母、数字、点、下划线、连字符，3–32 位 */
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(normalizeUsername(username));
}

export class UserService {
  constructor(private readonly db: Db) {}

  async countUsers(): Promise<number> {
    const res = await this.db.query<{ n: number }>(`select count(*)::int as n from users`);
    return res.rows[0]?.n ?? 0;
  }

  async findById(id: string): Promise<User | null> {
    const res = await this.db.query<UserRow>(
      `select ${USER_COLUMNS} from users where id = $1`,
      [id],
    );
    return res.rows[0] ?? null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const res = await this.db.query<UserRow>(
      `select ${USER_COLUMNS} from users where username = $1`,
      [normalizeUsername(username)],
    );
    return res.rows[0] ?? null;
  }

  async listUsers(): Promise<User[]> {
    const res = await this.db.query<UserRow>(
      `select ${USER_COLUMNS} from users order by created_at asc`,
    );
    return res.rows;
  }

  /**
   * 新建账号。
   * 密码明文不落库——这里接收的明文立刻哈希后丢弃。
   */
  async createUser(input: {
    username: string;
    password: string;
    displayName?: string | null;
    isAdmin?: boolean;
    email?: string | null;
  }): Promise<User> {
    const username = normalizeUsername(input.username);
    if (!isValidUsername(username)) {
      throw new Error(`用户名不合法：只允许 3–32 位小写字母、数字、. _ -`);
    }
    if (!input.password || input.password.length < 8) {
      throw new Error('密码至少 8 位');
    }

    const existing = await this.findByUsername(username);
    if (existing) throw new Error(`用户名已存在：${username}`);

    const passwordHash = await hashPassword(input.password);
    const res = await this.db.query<UserRow>(
      `insert into users (username, display_name, email, password_hash, is_admin, is_active)
       values ($1,$2,$3,$4,$5,true)
       returning ${USER_COLUMNS}`,
      [
        username,
        input.displayName ?? null,
        input.email ?? null,
        passwordHash,
        input.isAdmin ?? false,
      ],
    );
    return res.rows[0];
  }

  /** 用户名 + 密码校验；账号被禁用或密码为空一律失败 */
  async authenticate(username: string, password: string): Promise<User | null> {
    const res = await this.db.query<UserRow>(
      `select ${USER_COLUMNS}, password_hash from users where username = $1`,
      [normalizeUsername(username)],
    );
    const row = res.rows[0];
    if (!row || !row.password_hash) return null;
    if (!row.is_active) return null;

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) return null;
    return row;
  }

  async setPassword(userId: string, password: string): Promise<void> {
    if (!password || password.length < 8) throw new Error('密码至少 8 位');
    const hash = await hashPassword(password);
    await this.db.query(`update users set password_hash = $2 where id = $1`, [userId, hash]);
  }

  async setActive(userId: string, active: boolean): Promise<void> {
    await this.db.query(`update users set is_active = $2 where id = $1`, [userId, active]);
    // 禁用账号即刻吊销其会话与令牌，避免已登录的浏览器继续访问
    if (!active) {
      await this.db.query(`delete from sessions where user_id = $1`, [userId]);
      await this.db.query(
        `update api_tokens set revoked_at = now() where user_id = $1 and revoked_at is null`,
        [userId],
      );
    }
  }

  async setAdmin(userId: string, isAdmin: boolean): Promise<void> {
    await this.db.query(`update users set is_admin = $2 where id = $1`, [userId, isAdmin]);
  }

  async setDisplayName(userId: string, displayName: string | null): Promise<void> {
    await this.db.query(`update users set display_name = $2 where id = $1`, [
      userId,
      displayName,
    ]);
  }

  /**
   * 引导：库里还没有任何账号时，创建默认管理员。
   * 初始密码随机生成，由调用方负责展示一次（只此一次）。
   *
   * 兼容老库：v1 只有一条没有用户名的 users 记录（display_name='me'）。
   * 那条记录直接「认领」为 admin —— 否则升级后老任务会变成没人能看见的孤儿数据。
   */
  async ensureBootstrapAdmin(input?: {
    username?: string;
    password?: string;
  }): Promise<{ user: User; created: boolean; password: string | null }> {
    const username = normalizeUsername(input?.username ?? 'admin');

    const existing = await this.db.query<UserRow>(
      `select ${USER_COLUMNS}, password_hash from users where username is not null order by created_at limit 1`,
    );
    if (existing.rows[0]) {
      const user = await this.findById(existing.rows[0].id);
      return { user: user!, created: false, password: null };
    }

    const password = input?.password ?? generatePassword(20);

    // 老库迁移：把唯一的无用户名用户认领为管理员
    const legacy = await this.db.query<UserRow>(
      `select ${USER_COLUMNS}, password_hash from users where username is null order by created_at limit 2`,
    );
    if (legacy.rows.length === 1) {
      const row = legacy.rows[0];
      const hash = await hashPassword(password);
      await this.db.query(
        `update users set username = $2, password_hash = $3, is_admin = true, is_active = true where id = $1`,
        [row.id, username, hash],
      );
      const user = await this.findById(row.id);
      return { user: user!, created: true, password };
    }

    const user = await this.createUser({
      username,
      password,
      displayName: '管理员',
      isAdmin: true,
    });
    return { user, created: true, password };
  }
}
