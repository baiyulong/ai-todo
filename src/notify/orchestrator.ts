import type { TaskService } from '../domain/tasks.js';
import type { NotificationRecord, Task, TaskSeverity } from '../domain/types.js';
import { groupKey, isQuietNow, quietEndsAt, severityAtLeast } from '../domain/rules.js';
import type { NotificationBus } from './bus.js';

interface BatchState {
  lastEmitAt: number;
  pending: Task[];
  timer?: NodeJS.Timeout;
}

export interface EmittedNotification {
  id: string;
  kind: 'task' | 'digest';
  title: string;
  body: string;
  severity: TaskSeverity;
  task_count: number;
  url: string | null;
  created_at: string;
}

/**
 * 通知编排（配置 A）
 *
 * 职责边界：
 * - 本类只决定「推什么、推几条」，不关心推送到哪个外部服务——配置 A 没有外部通道。
 * - 实时出口是 SSE：编排结果通过 NotificationBus 广播给浏览器，由浏览器弹系统横幅。
 *
 * 节流策略（首条即时 + 尾部合并）：
 * - 首条符合条件的任务立即推送，用户能第一时间知道 AI 干完了。
 * - 冷却窗口内的后续任务进入待发批次，窗口结束时合并成一条「另外 N 项需要你关注」。
 * - blocker 级任务绕过冷却与聚合，立即单独推送。
 */
export class NotificationOrchestrator {
  private readonly batches = new Map<string, BatchState>();

  constructor(
    private readonly tasks: TaskService,
    private readonly bus: NotificationBus,
    private readonly baseUrl: string,
  ) {}

  async onTaskCreated(task: Task): Promise<void> {
    const rules = await this.tasks.getRules(task.user_id);

    if (!task.notify_requested) return;
    if (!severityAtLeast(task.severity, rules.min_severity)) return;

    const now = new Date();
    const quiet = rules.quiet_hours;
    if (isQuietNow(quiet, now)) {
      const endAt = quietEndsAt(quiet, now);
      if (endAt) {
        const delay = Math.max(1000, endAt.getTime() - now.getTime());
        const timer = setTimeout(() => {
          this.emit([task], 'task', task.severity).catch((err) => {
            console.error('[notify] 静默时段结束后的推送失败', err);
          });
        }, delay);
        timer.unref?.();
        return;
      }
    }

    if (task.severity === 'blocker') {
      await this.emit([task], 'task', task.severity);
      return;
    }

    await this.throttle(task, rules.cooldown_sec, rules.group_by);
  }

  private async throttle(task: Task, cooldownSec: number, groupBy: 'source_session' | 'project' | 'none'): Promise<void> {
    const key = groupKey(task, groupBy);
    const cooldown = Math.max(0, cooldownSec) * 1000;
    const now = Date.now();
    const state = this.batches.get(key);

    if (!state || now - state.lastEmitAt >= cooldown) {
      this.batches.set(key, { lastEmitAt: now, pending: [] });
      await this.emit([task], 'task', task.severity);
      return;
    }

    state.pending.push(task);
    if (!state.timer) {
      const wait = Math.max(1000, cooldown - (now - state.lastEmitAt));
      state.timer = setTimeout(() => {
        // 注意：这里必须兜住异常。定时器回调里的未捕获 Promise 拒绝
        // 会让 Node 直接退出进程——一条通知写不进去不该让整个服务消失。
        this.flush(key).catch((err) => {
          console.error('[notify] 合并通知失败', err);
        });
      }, wait);
      state.timer.unref?.();
    }
  }

  private async flush(key: string): Promise<void> {
    const state = this.batches.get(key);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const pending = state.pending;
    state.pending = [];
    if (pending.length > 0) {
      await this.emit(pending, 'task', pending[0].severity);
    }
  }

  /**
   * 推送一条（或一批）通知：落库 + SSE 广播
   *
   * 本方法**永不抛错**：通知是尽力而为的附加动作，
   * 写库失败不应把创建任务的请求变成 500，更不该让服务进程退出。
   */
  async emit(
    tasks: Task[],
    kind: 'task' | 'digest',
    severity: TaskSeverity,
    override?: { title: string; body: string },
  ): Promise<EmittedNotification | null> {
    if (tasks.length === 0) return null;
    const first = tasks[0];

    // 兜底：一条通知只能属于一个用户。分组键已含 user_id，这里再挡一道，
    // 防止任何未来的改动把不同用户的任务并进同一条通知。
    const userIds = new Set(tasks.map((t) => t.user_id));
    if (userIds.size > 1) {
      console.error('[notify] 拒绝合并跨用户任务', [...userIds]);
      return null;
    }

    const title =
      override?.title ?? (tasks.length === 1 ? first.title : `另外 ${tasks.length} 项需要你关注`);
    const body =
      override?.body ??
      (tasks.length === 1
        ? (first.detail ?? '')
        : tasks
            .slice(0, 3)
            .map((t) => `· ${t.title}`)
            .join('\n') + (tasks.length > 3 ? `\n…还有 ${tasks.length - 3} 项` : ''));
    const url = `${this.baseUrl}/t/${first.id}`;

    let record: NotificationRecord | null = null;
    try {
      record = await this.tasks.insertNotification({
        userId: first.user_id,
        taskId: first.id,
        kind,
        title,
        body,
        severity,
        taskCount: tasks.length,
        url,
      });
    } catch (err) {
      console.error('[notify] 写入通知记录失败', err);
      return null;
    }

    if (!record) {
      // 目标账号已被删除：没有接收方，写库也会撞外键约束，直接丢弃。
      console.warn(`[notify] 用户 ${first.user_id} 已不存在，跳过该条通知`);
      return null;
    }

    const payload: EmittedNotification = {
      id: record.id,
      kind: record.kind,
      title: record.title,
      body: record.body,
      severity: record.severity,
      task_count: record.task_count,
      url: record.url,
      created_at: record.created_at,
    };

    this.bus.publish(first.user_id, { type: 'notification', data: payload });
    return payload;
  }
}
