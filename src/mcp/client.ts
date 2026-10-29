import type { Link, Task, TaskSeverity, TaskStatus } from '../domain/types.js';

export interface ApiError extends Error {
  code?: string;
  status?: number;
}

export class TodoApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let payload: any = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }

    if (!res.ok) {
      const err = new Error(
        payload?.error?.message ?? `请求失败：HTTP ${res.status}`,
      ) as ApiError;
      err.code = payload?.error?.code;
      err.status = res.status;
      throw err;
    }
    return payload as T;
  }

  createTask(input: {
    title: string;
    detail?: string;
    severity?: TaskSeverity;
    project?: string;
    links?: Link[];
    idempotency_key?: string;
    notify?: boolean;
    due_at?: string;
    source?: { agent: string; session_key: string; label?: string };
  }): Promise<{ task: Task; created: boolean }> {
    return this.request('POST', '/api/v1/tasks', input);
  }

  listTasks(params: {
    status?: TaskStatus[];
    severity?: TaskSeverity[];
    project?: string;
    q?: string;
    limit?: number;
  }): Promise<{ tasks: Task[] }> {
    const query = new URLSearchParams();
    if (params.status?.length) query.set('status', params.status.join(','));
    if (params.severity?.length) query.set('severity', params.severity.join(','));
    if (params.project) query.set('project', params.project);
    if (params.q) query.set('q', params.q);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return this.request('GET', `/api/v1/tasks${qs ? `?${qs}` : ''}`);
  }

  updateTask(
    id: string,
    patch: Partial<{
      title: string;
      detail: string | null;
      severity: TaskSeverity;
      project: string | null;
      notify: boolean;
      due_at: string | null;
    }>,
  ): Promise<{ task: Task }> {
    return this.request('PATCH', `/api/v1/tasks/${id}`, patch);
  }

  setStatus(id: string, status: TaskStatus): Promise<{ task: Task }> {
    const action = status === 'acked' ? 'ack' : status === 'archived' ? 'archive' : 'done';
    return this.request('POST', `/api/v1/tasks/${id}/${action}`);
  }

  snooze(id: string, until: string): Promise<{ task: Task }> {
    return this.request('POST', `/api/v1/tasks/${id}/snooze`, { until });
  }

  getRules(): Promise<{ rules: Record<string, unknown> }> {
    return this.request('GET', '/api/v1/rules');
  }
}
