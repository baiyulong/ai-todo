import type { Db } from '../db/index.js';
import { ensureDefaultProject, ensureProjectByName } from './projects.js';
import type {
  GroupBy,
  Link,
  NotificationRecord,
  QuietHours,
  Rules,
  Task,
  TaskSeverity,
  TaskSource,
  TaskStatus,
} from './types.js';

/** 追加更新的时间戳标记：YYYY-MM-DD HH:mm（服务器本地时区） */
function stampNow(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface CreateTaskInput {
  userId: string;
  title: string;
  detail?: string | null;
  severity?: TaskSeverity;
  /** 项目 id（权威关联）；与 project 二选一，都没有时落到默认项目 */
  projectId?: string | null;
  /** 项目名（兼容旧调用/按名字自动建项目） */
  project?: string | null;
  links?: Link[];
  sourceId?: string | null;
  idempotencyKey?: string | null;
  notifyRequested?: boolean;
  dueAt?: string | null;
}

export interface CreateTaskResult {
  task: Task;
  /** false 表示命中幂等键，未产生新任务，也未触发通知 */
  created: boolean;
}

export interface ListTasksFilter {
  status?: TaskStatus[];
  severity?: TaskSeverity[];
  project?: string;
  /** 按 AI 来源（ai_sources.agent）过滤，例如 'trae' / 'qoder' */
  source?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class TaskService {
  constructor(private readonly db: Db) {}

  /** 按 (user_id, session_key) 幂等地登记 AI 来源 */
  async ensureSource(
    userId: string,
    agent: string,
    sessionKey: string,
    label?: string | null,
  ): Promise<TaskSource> {
    const upsert = await this.db.query<TaskSource>(
      `insert into ai_sources (user_id, agent, session_key, label)
       values ($1, $2, $3, $4)
       on conflict (user_id, session_key) do update
         set label = coalesce(excluded.label, ai_sources.label)
       returning *`,
      [userId, agent, sessionKey, label ?? null],
    );
    return upsert.rows[0];
  }

  async createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
    const severity = input.severity ?? 'need_human';
    const links = JSON.stringify(input.links ?? []);

    // 项目归属解析：显式 id → 项目名 → 默认项目。
    // 任务永远挂在一个真实存在的项目下（没有项目不允许创建任务）。
    let projectId = input.projectId ?? null;
    let projectName = input.project ?? null;
    if (projectId) {
      const owned = await this.db.query<{ name: string }>(
        `select name from projects where id = $1 and user_id = $2`,
        [projectId, input.userId],
      );
      if (!owned.rows[0]) throw new Error('项目不存在');
      projectName = owned.rows[0].name;
    } else if (projectName) {
      const ensured = await ensureProjectByName(this.db, input.userId, projectName);
      projectId = ensured.id;
      projectName = ensured.name;
    } else {
      const fallback = await ensureDefaultProject(this.db, input.userId);
      projectId = fallback.id;
      projectName = fallback.name;
    }

    const inserted = await this.db.query<Task>(
      `insert into tasks
         (user_id, title, detail, severity, project, project_id, links, source_id,
          idempotency_key, notify_requested, due_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
       on conflict (user_id, idempotency_key) where idempotency_key is not null
       do nothing
       returning *`,
      [
        input.userId,
        input.title,
        input.detail ?? null,
        severity,
        projectName,
        projectId,
        links,
        input.sourceId ?? null,
        input.idempotencyKey ?? null,
        input.notifyRequested ?? true,
        input.dueAt ?? null,
      ],
    );

    if (inserted.rows[0]) {
      const task = inserted.rows[0];
      await this.recordEvent(task.user_id, task.id, 'task.created', {
        severity: task.severity,
        source_id: task.source_id,
      });
      return { task, created: true };
    }

    // 幂等命中：返回既有任务，不产生新事件、不重复通知
    const existing = await this.db.query<Task>(
      `select * from tasks where user_id = $1 and idempotency_key = $2 limit 1`,
      [input.userId, input.idempotencyKey],
    );
    if (!existing.rows[0]) {
      throw new Error('幂等冲突但未找到既有任务');
    }
    return { task: existing.rows[0], created: false };
  }

  async getTask(userId: string, id: string): Promise<Task | null> {
    const res = await this.db.query<Task>(
      `select * from tasks where user_id = $1 and id = $2`,
      [userId, id],
    );
    return res.rows[0] ?? null;
  }

  async listTasks(userId: string, filter: ListTasksFilter = {}): Promise<Task[]> {
    const where: string[] = ['user_id = $1'];
    const params: unknown[] = [userId];

    // 注意：不要用 `= any($n::enum[])` 传 JS 数组作为参数。
    // pg 驱动会正确序列化成 Postgres 数组字面量，但 PGlite 会序列化成逗号拼接的字符串，
    // 导致 "malformed array literal"。展开成独立占位符在两种驱动下行为一致。
    const inClause = (column: string, values: string[]) => {
      const placeholders = values.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      where.push(`${column} in (${placeholders.join(',')})`);
    };

    if (filter.status?.length) inClause('status', filter.status);
    if (filter.severity?.length) inClause('severity', filter.severity);
    if (filter.project) {
      params.push(filter.project);
      where.push(`project = $${params.length}`);
    }
    // 按来源过滤：来源记在 ai_sources 表（一个 agent 可能有多个会话），
    // 所以要用子查询按 agent 匹配，而不是直接比 tasks.source_id。
    if (filter.source) {
      params.push(filter.source);
      where.push(
        `source_id in (select id from ai_sources where user_id = $1 and agent = $${params.length})`,
      );
    }
    if (filter.q) {
      params.push(`%${filter.q}%`);
      where.push(`(title ilike $${params.length} or coalesce(detail,'') ilike $${params.length})`);
    }

    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(filter.offset ?? 0, 0);
    params.push(limit, offset);

    const res = await this.db.query<Task>(
      `select * from tasks
       where ${where.join(' and ')}
       order by
         case status when 'pending' then 0 when 'acked' then 1 else 2 end,
         case severity when 'blocker' then 0 when 'need_human' then 1 else 2 end,
         created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return res.rows;
  }

  async setStatus(userId: string, id: string, status: TaskStatus): Promise<Task | null> {
    const stamp =
      status === 'acked' ? 'acked_at = now()' : status === 'done' ? 'done_at = now()' : 'acked_at = null, done_at = null';
    const res = await this.db.query<Task>(
      `update tasks
       set status = $3::task_status, ${stamp}, updated_at = now()
       where user_id = $1 and id = $2
       returning *`,
      [userId, id, status],
    );
    const task = res.rows[0] ?? null;
    if (task) {
      await this.recordEvent(userId, task.id, `task.${status}`, { severity: task.severity });
    }
    return task;
  }

  /**
   * 把任务转交给其他用户：改归属、记事件。
   * 只有当前归属人能转（where user_id = $1 天然限制了越权）。
   * 返回转交前的任务快照（供通知文案用），任务不存在或不属于该用户时为 null。
   */
  async transferTask(
    userId: string,
    id: string,
    toUserId: string,
  ): Promise<{ from: Task; to: Task } | null> {
    const current = await this.getTask(userId, id);
    if (!current) return null;
    if (toUserId === userId) return null;

    const res = await this.db.query<Task>(
      `update tasks
          set user_id = $3,
              -- 归属都换了，处理状态重新开始：接手 / 完成的时间戳跟着作废
              status = 'pending'::task_status,
              acked_at = null,
              done_at = null,
              updated_at = now()
        where id = $2 and user_id = $1
        returning *`,
      [userId, id, toUserId],
    );
    const transferred = res.rows[0];
    if (!transferred) return null;

    await this.recordEvent(userId, id, 'task.transferred', { to_user_id: toUserId });
    return { from: current, to: transferred };
  }

  /** 已归档任务数：用来判断「清空已归档」按钮该不该出现 */
  async countArchived(userId: string): Promise<number> {
    const res = await this.db.query<{ n: string }>(
      `select count(*)::text as n from tasks where user_id = $1 and status = 'archived'`,
      [userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** 清空当前用户所有已归档的任务（永久删除，不可恢复）；返回删除条数 */
  async purgeArchived(userId: string): Promise<number> {
    const res = await this.db.query<{ n: string }>(
      `with gone as (
         delete from tasks where user_id = $1 and status = 'archived' returning id
       )
       select count(*)::text as n from gone`,
      [userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * 彻底删除一条任务（不可恢复）。
   *
   * 只允许删「已归档」的任务：归档是软删除的第一步，硬删除是第二步。
   * 两步分开是为了避免「手滑点一下，正在处理的任务就永久消失」。
   *
   * 关联的 notifications / task_events 都是 on delete cascade，会一并清掉。
   */
  async hardDelete(userId: string, id: string): Promise<Task | null> {
    const res = await this.db.query<Task>(
      `delete from tasks
       where user_id = $1 and id = $2 and status = 'archived'
       returning *`,
      [userId, id],
    );
    return res.rows[0] ?? null;
  }

  async updateTask(
    userId: string,
    id: string,
    patch: Partial<{
      title: string;
      detail: string | null;
      severity: TaskSeverity;
      /** 直接换项目（权威） */
      projectId: string | null;
      /** 按项目名换项目：找不到同名项目会自动创建 */
      project: string | null;
      links: Link[];
      notifyRequested: boolean;
      dueAt: string | null;
      /** true=detail 追加而不是覆盖：新内容带时间分隔线接在原文后面，保留历史 */
      appendDetail: boolean;
    }>,
  ): Promise<Task | null> {
    const sets: string[] = [];
    const params: unknown[] = [userId, id];

    const push = (sql: string, value: unknown) => {
      params.push(value);
      sets.push(`${sql} = $${params.length}`);
    };

    if (patch.title !== undefined) push('title', patch.title);
    if (patch.detail !== undefined) {
      if (patch.appendDetail && typeof patch.detail === 'string' && patch.detail.trim()) {
        const existing = await this.getTask(userId, id);
        if (existing?.detail?.trim()) {
          push('detail', `${existing.detail}\n\n—— ${stampNow()} 更新 ——\n${patch.detail}`);
        } else {
          push('detail', patch.detail);
        }
      } else {
        push('detail', patch.detail);
      }
    }
    if (patch.severity !== undefined) push('severity', patch.severity);
    if (patch.projectId !== undefined) {
      if (patch.projectId === null) {
        const fallback = await ensureDefaultProject(this.db, userId);
        push('project_id', fallback.id);
        push('project', fallback.name);
      } else {
        const owned = await this.db.query<{ name: string }>(
          `select name from projects where id = $1 and user_id = $2`,
          [patch.projectId, userId],
        );
        if (!owned.rows[0]) throw new Error('项目不存在');
        push('project_id', patch.projectId);
        push('project', owned.rows[0].name);
      }
    } else if (patch.project !== undefined) {
      if (patch.project === null) {
        const fallback = await ensureDefaultProject(this.db, userId);
        push('project_id', fallback.id);
        push('project', fallback.name);
      } else {
        const ensured = await ensureProjectByName(this.db, userId, patch.project);
        push('project_id', ensured.id);
        push('project', ensured.name);
      }
    }
    if (patch.links !== undefined) {
      params.push(JSON.stringify(patch.links));
      sets.push(`links = $${params.length}::jsonb`);
    }
    if (patch.notifyRequested !== undefined) push('notify_requested', patch.notifyRequested);
    if (patch.dueAt !== undefined) {
      push('due_at', patch.dueAt);
      sets.push('due_notified_at = null');
    }

    if (sets.length === 0) return this.getTask(userId, id);

    // 内容更新（覆盖或追加）一律不动状态：状态只由用户主动操作（回复=完成、接手、归档）。
    // agent 汇报进展不应把用户已完成/已归档的任务重新拉回待处理列表。
    const res = await this.db.query<Task>(
      `update tasks set ${sets.join(', ')}, updated_at = now()
       where user_id = $1 and id = $2
       returning *`,
      params,
    );
    const task = res.rows[0] ?? null;
    if (task) {
      await this.recordEvent(userId, task.id, 'task.updated', { severity: task.severity });
    }
    return task;
  }

  /**
   * 用户回复任务：写入回复内容并标记完成。
   * 回复即完成——正在 todo_wait_reply 长轮询里的 AI 会立刻拿到这条回复。
   * 已完成的任务再次回复 = 补充/修改答复，直接覆盖。
   */
  async replyTask(userId: string, id: string, replyText: string): Promise<Task | null> {
    const res = await this.db.query<Task>(
      `update tasks
       set status = 'done'::task_status,
           done_at = coalesce(done_at, now()),
           reply_text = $3,
           replied_at = now(),
           updated_at = now()
       where user_id = $1 and id = $2
       returning *`,
      [userId, id, replyText],
    );
    const task = res.rows[0] ?? null;
    if (task) {
      await this.recordEvent(userId, task.id, 'task.replied', { severity: task.severity });
    }
    return task;
  }

  async snooze(userId: string, id: string, until: string): Promise<Task | null> {
    const res = await this.db.query<Task>(
      `update tasks
       set due_at = $3, due_notified_at = null, updated_at = now()
       where user_id = $1 and id = $2
       returning *`,
      [userId, id, until],
    );
    const task = res.rows[0] ?? null;
    if (task) {
      await this.recordEvent(userId, task.id, 'task.snoozed', { until });
    }
    return task;
  }

  /** 到点提醒的候选任务 */
  async listDueTasks(userId: string, now: string): Promise<Task[]> {
    const res = await this.db.query<Task>(
      `select * from tasks
       where user_id = $1
         and status = 'pending'
         and due_at is not null
         and due_at <= $2
         and due_notified_at is null
       order by due_at asc
       limit 50`,
      [userId, now],
    );
    return res.rows;
  }

  async markDueNotified(id: string): Promise<void> {
    await this.db.query(`update tasks set due_notified_at = now() where id = $1`, [id]);
  }

  async countPending(userId: string): Promise<number> {
    const res = await this.db.query<{ n: string }>(
      `select count(*)::text as n from tasks where user_id = $1 and status = 'pending'`,
      [userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** 每日摘要候选：指定时间之后创建、仍待处理、级别达标的任务 */
  async listDigestTasks(userId: string, sinceIso: string): Promise<Task[]> {
    const res = await this.db.query<Task>(
      `select * from tasks
       where user_id = $1
         and status = 'pending'
         and created_at >= $2::timestamptz
       order by
         case severity when 'blocker' then 0 when 'need_human' then 1 else 2 end,
         created_at desc
       limit 100`,
      [userId, sinceIso],
    );
    return res.rows;
  }

  async listSources(userId: string): Promise<TaskSource[]> {
    const res = await this.db.query<TaskSource>(
      `select * from ai_sources where user_id = $1 order by created_at desc limit 100`,
      [userId],
    );
    return res.rows;
  }

  async listUsers(): Promise<string[]> {
    const res = await this.db.query<{ id: string }>(`select id from users`);
    return res.rows.map((r) => r.id);
  }

  // ---------- 通知记录 ----------

  /**
   * 写入一条通知记录。
   *
   * 用 CTE 把「目标用户仍存在」和「插入」合成一条原子语句：
   * 用户在聚合窗口期内被删除时（账号删除会级联清掉他的任务与通知），
   * 这里返回 null 而不是抛出外键错误——通知写不进去不该拖垮整个服务。
   */
  async insertNotification(input: {
    userId: string;
    taskId: string | null;
    kind: 'task' | 'digest';
    title: string;
    body: string;
    severity: TaskSeverity;
    taskCount: number;
    url: string | null;
  }): Promise<NotificationRecord | null> {
    const res = await this.db.query<NotificationRecord>(
      `with target as (
         select id from users where id = $1
       )
       insert into notifications (user_id, task_id, kind, title, body, severity, task_count, url)
       select $1,$2,$3::notif_kind,$4,$5,$6::task_severity,$7,$8
       from target
       returning *`,
      [
        input.userId,
        input.taskId,
        input.kind,
        input.title,
        input.body,
        input.severity,
        input.taskCount,
        input.url,
      ],
    );
    return res.rows[0] ?? null;
  }

  async listNotifications(userId: string, limit = 50): Promise<NotificationRecord[]> {
    const res = await this.db.query<NotificationRecord>(
      `select * from notifications where user_id = $1 order by created_at desc limit $2`,
      [userId, Math.min(Math.max(limit, 1), 200)],
    );
    return res.rows;
  }

  async markNotificationRead(userId: string, id: string): Promise<void> {
    await this.db.query(
      `update notifications set read_at = now() where user_id = $1 and id = $2 and read_at is null`,
      [userId, id],
    );
  }

  async recordEvent(
    userId: string,
    taskId: string | null,
    type: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.query(
      `insert into task_events (user_id, task_id, type, payload) values ($1,$2,$3,$4::jsonb)`,
      [userId, taskId, type, JSON.stringify(payload)],
    );
  }

  // ---------- 通知规则 ----------

  async getRules(userId: string): Promise<Rules> {
    const res = await this.db.query<{
      min_severity: TaskSeverity;
      quiet_hours: QuietHours | null;
      cooldown_sec: number;
      group_by: GroupBy;
      digest_hour: number | null;
      last_digest_date: string | null;
    }>(`select * from notification_rules where user_id = $1`, [userId]);

    const row = res.rows[0];
    if (row) {
      return {
        min_severity: row.min_severity,
        quiet_hours: row.quiet_hours,
        cooldown_sec: row.cooldown_sec,
        group_by: row.group_by,
        digest_hour: row.digest_hour,
        last_digest_date: row.last_digest_date,
      };
    }

    await this.db.query(
      `insert into notification_rules (user_id) values ($1) on conflict (user_id) do nothing`,
      [userId],
    );
    return {
      min_severity: 'need_human',
      quiet_hours: null,
      cooldown_sec: 300,
      group_by: 'source_session',
      digest_hour: null,
      last_digest_date: null,
    };
  }

  async updateRules(
    userId: string,
    patch: Partial<{
      min_severity: TaskSeverity;
      quiet_hours: QuietHours | null;
      cooldown_sec: number;
      group_by: GroupBy;
      digest_hour: number | null;
    }>,
  ): Promise<Rules> {
    await this.getRules(userId); // 确保行存在

    const sets: string[] = [];
    const params: unknown[] = [userId];
    const push = (sql: string, value: unknown) => {
      params.push(value);
      sets.push(`${sql} = $${params.length}`);
    };

    if (patch.min_severity !== undefined) push('min_severity', patch.min_severity);
    if (patch.quiet_hours !== undefined) {
      params.push(patch.quiet_hours === null ? null : JSON.stringify(patch.quiet_hours));
      sets.push(`quiet_hours = $${params.length}::jsonb`);
    }
    if (patch.cooldown_sec !== undefined) push('cooldown_sec', patch.cooldown_sec);
    if (patch.group_by !== undefined) push('group_by', patch.group_by);
    if (patch.digest_hour !== undefined) push('digest_hour', patch.digest_hour);

    if (sets.length) {
      await this.db.query(
        `update notification_rules set ${sets.join(', ')}, updated_at = now() where user_id = $1`,
        params,
      );
    }
    return this.getRules(userId);
  }

  async setLastDigestDate(userId: string, date: string): Promise<void> {
    await this.db.query(
      `update notification_rules set last_digest_date = $2::date, updated_at = now() where user_id = $1`,
      [userId, date],
    );
  }
}
