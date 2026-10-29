export type TaskStatus = 'pending' | 'acked' | 'done' | 'archived';
export type TaskSeverity = 'info' | 'need_human' | 'blocker';
export type GroupBy = 'source_session' | 'project' | 'none';

export interface Link {
  label?: string;
  url: string;
}

export interface Task {
  id: string;
  user_id: string;
  title: string;
  detail: string | null;
  status: TaskStatus;
  severity: TaskSeverity;
  project: string | null;
  links: Link[];
  source_id: string | null;
  idempotency_key: string | null;
  notify_requested: boolean;
  due_at: string | null;
  due_notified_at: string | null;
  created_at: string;
  updated_at: string;
  acked_at: string | null;
  done_at: string | null;
}

export interface TaskSource {
  id: string;
  user_id: string;
  agent: string;
  session_key: string;
  label: string | null;
  created_at: string;
}

export interface QuietHours {
  /** "23:00" */
  start: string;
  /** "08:00" */
  end: string;
  /** 可选 IANA 时区，缺省用服务器本地时区 */
  tz?: string;
}

export interface Rules {
  min_severity: TaskSeverity;
  quiet_hours: QuietHours | null;
  cooldown_sec: number;
  group_by: GroupBy;
  digest_hour: number | null;
  last_digest_date: string | null;
}

export interface NotificationRecord {
  id: string;
  user_id: string;
  task_id: string | null;
  kind: 'task' | 'digest';
  title: string;
  body: string;
  severity: TaskSeverity;
  task_count: number;
  url: string | null;
  created_at: string;
  read_at: string | null;
}

export const SEVERITY_RANK: Record<TaskSeverity, number> = {
  info: 0,
  need_human: 1,
  blocker: 2,
};

export const SEVERITY_LABEL: Record<TaskSeverity, string> = {
  info: '记录',
  need_human: '需处理',
  blocker: '阻塞',
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '待处理',
  acked: '已接手',
  done: '已完成',
  archived: '已归档',
};
