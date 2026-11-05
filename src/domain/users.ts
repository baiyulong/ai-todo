import { createHash, randomBytes } from 'node:crypto';
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
  /** 登录方式：password | wechat | both */
  auth_provider: string;
  /** 已绑定的微信 openid（未绑定为 null） */
  wechat_openid: string | null;
  wechat_nickname: string | null;
  avatar_url: string | null;
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
  auth_provider: string;
  wechat_openid: string | null;
  wechat_nickname: string | null;
  avatar_url: string | null;
}

const USER_COLUMNS =
  'id, username, display_name, email, is_admin, is_active, created_at, ' +
  'auth_provider, wechat_openid, wechat_nickname, avatar_url';

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

  /* --------------------------------------------------- 微信身份映射 */

  /** 按 openid 找账号（微信身份的主键） */
  async findByWechatOpenid(openid: string): Promise<User | null> {
    const res = await this.db.query<UserRow>(
      `select ${USER_COLUMNS} from users where wechat_openid = $1`,
      [openid],
    );
    return res.rows[0] ?? null;
  }

  /**
   * 按 unionid 找账号。
   * 同一开放平台账号下的多个应用（公众号 + 网站应用）共用同一个 unionid，
   * 用户在两边是同一个人——用它兜底能避免重复建号。
   */
  async findByWechatUnionid(unionid: string): Promise<User | null> {
    const res = await this.db.query<UserRow>(
      `select ${USER_COLUMNS} from users where wechat_unionid = $1 and wechat_unionid is not null`,
      [unionid],
    );
    return res.rows[0] ?? null;
  }

  async countAdmins(): Promise<number> {
    const res = await this.db.query<{ n: number }>(
      `select count(*)::int as n from users where is_admin`,
    );
    return res.rows[0]?.n ?? 0;
  }

  /**
   * 微信首次登录时自动建号。
   *
   * 用户名取 openid 的哈希前 16 位：唯一、稳定、且不泄露 openid 本身
   * （openid 是微信侧的用户标识，不该出现在可见的用户名里）。
   * 显示名用微信昵称，昵称拿不到时用「微信用户」。
   *
   * 用户名可能已经被占用了：同一个 openid 换绑到别的微信之后，
   * 老账号还留着按旧 openid 派生的用户名。新账号这时要另起一个名字，
   * 否则会撞上 users_username_uq 直接建不出来。
   */
  async createWechatUser(input: {
    openid: string;
    unionid?: string | null;
    nickname?: string | null;
    avatarUrl?: string | null;
    isAdmin?: boolean;
  }): Promise<User> {
    const suffix = createHash('sha256').update(input.openid).digest('hex').slice(0, 16);
    const base = `wx_${suffix}`;
    let username = base;
    for (let i = 0; i < 6; i++) {
      const taken = await this.findByUsername(username);
      if (!taken) break;
      username = `${base.slice(0, 27)}_${randomBytes(2).toString('hex')}`;
    }
    const displayName = (input.nickname ?? '').trim() || '微信用户';

    const res = await this.db.query<UserRow>(
      `insert into users
         (username, display_name, email, password_hash, is_admin, is_active,
          wechat_openid, wechat_unionid, wechat_nickname, avatar_url, auth_provider)
       values ($1,$2,null,null,$3,true,$4,$5,$6,$7,'wechat')
       returning ${USER_COLUMNS}`,
      [
        username,
        displayName,
        input.isAdmin ?? false,
        input.openid,
        input.unionid ?? null,
        (input.nickname ?? '').trim() || null,
        input.avatarUrl ?? null,
      ],
    );
    return res.rows[0];
  }

  /**
   * 把微信身份绑到已有账号。
   * 已经绑到别的账号上时抛错——一个微信身份只能对应一个账号，
   * 否则会出现「用同一个微信号登进两个账号」的越权口子。
   */
  async linkWechat(
    userId: string,
    input: {
      openid: string;
      unionid?: string | null;
      nickname?: string | null;
      avatarUrl?: string | null;
    },
  ): Promise<User> {
    const owner = await this.findByWechatOpenid(input.openid);
    if (owner && owner.id !== userId) {
      throw new Error('wechat_already_bound');
    }
    // auth_provider 变成 both：绑了微信之后原来的密码依然能登录
    await this.db.query(
      `update users
          set wechat_openid = $2,
              wechat_unionid = coalesce($3, wechat_unionid),
              wechat_nickname = coalesce($4, wechat_nickname),
              avatar_url = coalesce($5, avatar_url),
              auth_provider = case when password_hash is null then 'wechat' else 'both' end
        where id = $1`,
      [
        userId,
        input.openid,
        input.unionid ?? null,
        (input.nickname ?? '').trim() || null,
        input.avatarUrl ?? null,
      ],
    );
    const user = await this.findById(userId);
    return user!;
  }

  /**
   * 解绑微信：账号退回纯密码登录。
   * 注意：本来就没有密码的账号解绑后会登不进来，管理员得先给它设个密码。
   */
  async unlinkWechat(userId: string): Promise<void> {
    await this.db.query(
      `update users
          set wechat_openid = null, wechat_unionid = null, wechat_nickname = null,
              auth_provider = 'password'
        where id = $1`,
      [userId],
    );
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

  /**
   * 校验某个用户当前的密码（自助改密用：改前必须验旧密码）。
   * 没设过密码的账号（微信-only）一律返回 false。
   */
  async verifyPasswordById(userId: string, password: string): Promise<boolean> {
    const res = await this.db.query<{ password_hash: string | null }>(
      `select password_hash from users where id = $1`,
      [userId],
    );
    const hash = res.rows[0]?.password_hash;
    if (!hash) return false;
    return verifyPassword(password, hash);
  }

  /** 账号是否设有密码。微信-only 账号首次设置密码时不用验旧密码。 */
  async hasPassword(userId: string): Promise<boolean> {
    const res = await this.db.query<{ password_hash: string | null }>(
      `select password_hash from users where id = $1`,
      [userId],
    );
    return !!res.rows[0]?.password_hash;
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
