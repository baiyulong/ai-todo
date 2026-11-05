/* 项目维度：项目是任务的一等归属。
 *
 * 规则：
 * - 每个用户至多一枚「默认项目」，惰性补种——查不到就建，永远拿得到；
 * - 任务必须挂在某个项目下（没有项目不允许创建任务）；
 * - 令牌签发时绑定项目，通过令牌推送的任务一律落进令牌的项目；
 * - 删除项目时，项目下的任务与令牌全部挪到默认项目，默认项目本身不可删。
 */

import type { Db } from '../db/index.js';

export const DEFAULT_PROJECT_NAME = '默认项目';

export interface Project {
  id: string;
  user_id: string;
  name: string;
  is_default: boolean;
  created_at: string;
}

export interface ProjectWithCount extends Project {
  task_count: number;
}

export class ProjectError extends Error {
  constructor(
    public readonly code: 'not_found' | 'name_taken' | 'default_undeletable' | 'name_invalid',
    message: string,
  ) {
    super(message);
  }
}

/** 拿到用户的默认项目（没有就当场建一枚，并发安全靠唯一索引兜底） */
export async function ensureDefaultProject(db: Db, userId: string): Promise<Project> {
  const found = await db.query<Project>(
    `select * from projects where user_id = $1 and is_default limit 1`,
    [userId],
  );
  if (found.rows[0]) return found.rows[0];

  await db.query(
    `insert into projects (user_id, name, is_default) values ($1, $2, true)
     on conflict do nothing`,
    [userId, DEFAULT_PROJECT_NAME],
  );
  const again = await db.query<Project>(
    `select * from projects where user_id = $1 and is_default limit 1`,
    [userId],
  );
  if (!again.rows[0]) throw new Error('默认项目创建失败');
  return again.rows[0];
}

/** 列出用户的项目，附带未归档任务数（默认项目排最前，其余按创建时间） */
export async function listProjects(db: Db, userId: string): Promise<ProjectWithCount[]> {
  const res = await db.query<ProjectWithCount>(
    `select p.*,
            (select count(*) from tasks t
              where t.project_id = p.id and t.status <> 'archived')::int as task_count
     from projects p
     where p.user_id = $1
     order by p.is_default desc, p.created_at asc`,
    [userId],
  );
  return res.rows;
}

/** 按 id 取一个属于自己的项目；不存在或不是自己的返回 null */
export async function getProject(db: Db, userId: string, id: string): Promise<Project | null> {
  const res = await db.query<Project>(
    `select * from projects where id = $1 and user_id = $2`,
    [id, userId],
  );
  return res.rows[0] ?? null;
}

/** 按名字取项目；找不到返回 null（供幂等创建/校验用） */
export async function getProjectByName(
  db: Db,
  userId: string,
  name: string,
): Promise<Project | null> {
  const res = await db.query<Project>(
    `select * from projects where user_id = $1 and name = $2`,
    [userId, name],
  );
  return res.rows[0] ?? null;
}

/** 新建项目；重名抛 name_taken */
export async function createProject(db: Db, userId: string, rawName: string): Promise<Project> {
  const name = rawName.trim();
  if (!name || name.length > 120) {
    throw new ProjectError('name_invalid', '项目名需为 1~120 个字符');
  }
  try {
    const res = await db.query<Project>(
      `insert into projects (user_id, name) values ($1, $2) returning *`,
      [userId, name],
    );
    return res.rows[0];
  } catch {
    throw new ProjectError('name_taken', `项目「${name}」已存在`);
  }
}

/** 删除项目：任务与令牌挪到默认项目；默认项目不可删 */
export async function deleteProject(db: Db, userId: string, id: string): Promise<void> {
  const project = await getProject(db, userId, id);
  if (!project) throw new ProjectError('not_found', '项目不存在');
  if (project.is_default) {
    throw new ProjectError('default_undeletable', '默认项目不能删除');
  }
  const fallback = await ensureDefaultProject(db, userId);

  await db.query(
    `update tasks set project_id = $3, project = $4
     where user_id = $1 and project_id = $2`,
    [userId, id, fallback.id, fallback.name],
  );
  await db.query(
    `update api_tokens set project_id = $3 where user_id = $1 and project_id = $2`,
    [userId, id, fallback.id],
  );
  await db.query(`delete from projects where id = $1 and user_id = $2`, [id, userId]);
}

/** 确保某个名字的项目存在（找不到就建），返回项目行 */
export async function ensureProjectByName(
  db: Db,
  userId: string,
  rawName: string,
): Promise<Project> {
  const name = rawName.trim();
  if (!name || name.length > 120) {
    throw new ProjectError('name_invalid', '项目名需为 1~120 个字符');
  }
  const existing = await getProjectByName(db, userId, name);
  if (existing) return existing;
  try {
    return await createProject(db, userId, name);
  } catch (err) {
    // 并发下可能撞唯一索引：再查一次
    const retry = await getProjectByName(db, userId, name);
    if (retry) return retry;
    throw err;
  }
}
