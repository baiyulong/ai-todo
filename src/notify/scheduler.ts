import { localDateKey, severityAtLeast } from '../domain/rules.js';
import type { TaskService } from '../domain/tasks.js';
import type { NotificationOrchestrator } from './orchestrator.js';

const TICK_MS = 30_000;

/**
 * 定时任务：
 * 1. 到点提醒（due_at 到期）
 * 2. 每日摘要（rules.digest_hour）
 *
 * 配置 A 中这两者都通过同一条 SSE 出口推给浏览器。
 */
export class NotificationScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly tasks: TaskService,
    private readonly orchestrator: NotificationOrchestrator,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[scheduler] tick 未捕获异常', err);
      });
    }, TICK_MS);
    this.timer.unref?.();
    this.tick().catch((err) => {
      console.error('[scheduler] 首次 tick 未捕获异常', err);
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const users = await this.tasks.listUsers();
      for (const userId of users) {
        await this.checkDueTasks(userId);
        await this.checkDailyDigest(userId);
      }
    } catch (err) {
      console.error('[scheduler] tick 失败:', err);
    } finally {
      this.running = false;
    }
  }

  private async checkDueTasks(userId: string): Promise<void> {
    const now = new Date().toISOString();
    const due = await this.tasks.listDueTasks(userId, now);
    if (due.length === 0) return;

    for (const task of due) {
      await this.orchestrator.emit([task], 'task', task.severity);
      await this.tasks.markDueNotified(task.id);
    }
  }

  private async checkDailyDigest(userId: string): Promise<void> {
    const rules = await this.tasks.getRules(userId);
    if (rules.digest_hour === null || rules.digest_hour === undefined) return;

    const now = new Date();
    const tz = rules.quiet_hours?.tz;
    if (now.getHours() !== rules.digest_hour) {
      if (tz) {
        // 带时区时按该时区判断当前小时
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz,
          hour: '2-digit',
          hour12: false,
        }).formatToParts(now);
        const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
        if (hour !== rules.digest_hour) return;
      } else {
        return;
      }
    }

    const today = localDateKey(now, tz);
    if (rules.last_digest_date === today) return;

    const since = new Date(now);
    since.setHours(0, 0, 0, 0);
    const candidates = (await this.tasks.listDigestTasks(userId, since.toISOString())).filter(
      (t) => severityAtLeast(t.severity, rules.min_severity),
    );

    await this.tasks.setLastDigestDate(userId, today);
    if (candidates.length === 0) return;

    const body = candidates
      .slice(0, 8)
      .map((t) => `· ${t.title}`)
      .join('\n');
    const title = `今日 ${candidates.length} 项待处理`;

    await this.orchestrator.emit(candidates, 'digest', candidates[0].severity, { title, body });
  }
}
