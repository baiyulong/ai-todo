import type { GroupBy, QuietHours, Task, TaskSeverity } from './types.js';
import { SEVERITY_RANK } from './types.js';

export function severityAtLeast(value: TaskSeverity, min: TaskSeverity): boolean {
  return SEVERITY_RANK[value] >= SEVERITY_RANK[min];
}

export function parseHhMm(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`时间格式无效：${value}，应为 HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`时间超出范围：${value}`);
  return h * 60 + min;
}

/** 取指定时区下的「当天第几分钟」，缺省用服务器本地时区 */
export function localMinutes(date: Date, tz?: string): number {
  if (!tz) return date.getHours() * 60 + date.getMinutes();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

/** 当前是否处于静默时段 */
export function isQuietNow(quiet: QuietHours | null, now: Date): boolean {
  if (!quiet) return false;
  const start = parseHhMm(quiet.start);
  const end = parseHhMm(quiet.end);
  if (start === end) return false;
  const cur = localMinutes(now, quiet.tz);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * 静默时段的结束时刻。跨零点时正确处理。
 * 说明：按固定分钟数推算，未考虑夏令时切换带来的 1 小时误差——对个人工具可接受。
 */
export function quietEndsAt(quiet: QuietHours | null, now: Date): Date | null {
  if (!quiet) return null;
  if (!isQuietNow(quiet, now)) return null;
  const end = parseHhMm(quiet.end);
  const cur = localMinutes(now, quiet.tz);
  let delta = (end - cur + 1440) % 1440;
  if (delta === 0) delta = 1440;
  return new Date(now.getTime() + delta * 60_000);
}

/**
 * 聚合分组键：决定哪些任务会被合并成一条通知。
 *
 * 分组键必须以 user_id 为作用域。原因有二：
 * 1. 串数据：key 不含用户时，不同用户的任务会并进同一条通知，
 *    正文里会列出别人的任务标题。
 * 2. 写库失败：批次里若混入了已被删除账号的任务，窗口到期时
 *    落库会撞外键约束（notifications_user_id_fkey）。
 * 所以这里一律加 `u:<user_id>` 前缀。
 */
export function groupKey(task: Task, groupBy: GroupBy): string {
  const scope = `u:${task.user_id}`;
  switch (groupBy) {
    case 'source_session':
      return `${scope}|src:${task.source_id ?? 'none'}`;
    case 'project':
      return `${scope}|prj:${task.project ?? 'none'}`;
    default:
      return `${scope}|all`;
  }
}

/** 本地日期（YYYY-MM-DD），用于每日摘要去重 */
export function localDateKey(date: Date, tz?: string): string {
  if (!tz) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
