import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { TaskSeverity } from '../domain/types.js';
import { TodoApiClient } from './client.js';

export interface McpServerOptions {
  baseUrl: string;
  token: string;
  sessionKey: string;
  agent: string;
  sourceLabel?: string;
  /**
   * 来源项目。AI 没在工具参数里指定 project 时用它兜底——
   * 否则「哪个工具发的哪个项目的任务」就永远缺一半。
   */
  sourceProject?: string;
}

/** stdout 只能承载协议消息，所有日志一律走 stderr */
function log(message: string): void {
  process.stderr.write(`[ai-todo-mcp] ${message}\n`);
}

const SEVERITIES = ['info', 'need_human', 'blocker'] as const;

export function createMcpServer(opts: McpServerOptions): McpServer {
  const api = new TodoApiClient(opts.baseUrl, opts.token);
  const server = new McpServer(
    { name: 'ai-todo', version: '0.1.0' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'AI Todo：把需要用户关注的事项推进待办列表。AI 完成一个任务后，用 todo_create 告知用户接下来需要人工确认、决策或验收的部分。' +
        '只推真正需要人介入的事；纯进度更新不要调用。notify=false 表示只记录不打扰用户。',
    },
  );

  const source = () => ({
    agent: opts.agent,
    session_key: opts.sessionKey,
    label: opts.sourceLabel,
  });

  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `失败：${message}` }],
    };
  };

  server.registerTool(
    'todo_create',
    {
      title: '创建待办事项',
      description:
        '把一条需要用户关注的事项推进到 Todo 列表。AI 完成一个任务后，用它告知用户接下来需要人工确认、决策或验收的部分。' +
        '只推真正需要人介入的事；纯进度更新不要调用。',
      inputSchema: {
        title: z.string().min(1).max(200).describe('一句话说明需要用户做什么，20 字以内，尽量带动作动词'),
        detail: z.string().max(8000).optional().describe('补充上下文：做了什么、为什么需要人介入、验证方式'),
        severity: z
          .enum(SEVERITIES)
          .optional()
          .describe('info=仅记录不打扰；need_human=需要用户处理(默认)；blocker=阻塞中，立即提醒'),
        project: z.string().max(120).optional().describe('所属项目/模块，用于分组与聚合'),
        links: z
          .array(z.object({ label: z.string().optional(), url: z.string() }))
          .max(20)
          .optional()
          .describe('相关产物链接：文件、PR、页面、日志'),
        due_at: z.string().optional().describe('可选，到点再提醒（ISO 8601）'),
        notify: z.boolean().optional().describe('false=只入库不打扰用户（默认 true）'),
        idempotency_key: z
          .string()
          .optional()
          .describe('可选，客户端生成的唯一键；不传则由服务端按会话+内容生成'),
      },
    },
    async (args) => {
      try {
        const idempotencyKey =
          args.idempotency_key ?? `${opts.agent}:${opts.sessionKey}:${hash(args.title)}`;

        const { task, created } = await api.createTask({
          title: args.title,
          detail: args.detail,
          severity: args.severity as TaskSeverity | undefined,
          // AI 没给项目就用客户端声明的来源项目兜底，
          // 这样「哪个工具发的哪个项目的任务」永远查得到
          project: args.project ?? opts.sourceProject,
          links: args.links,
          due_at: args.due_at,
          notify: args.notify,
          idempotency_key: idempotencyKey,
          source: source(),
        });

        const prefix = created ? '已记录' : '已存在（幂等命中，未重复提醒）';
        return {
          content: [
            {
              type: 'text' as const,
              text: `${prefix} #${task.id.slice(0, 8)}：${task.title}`,
            },
          ],
          structuredContent: {
            task_id: task.id,
            status: task.status,
            created,
            notified: task.notify_requested,
            url: `${opts.baseUrl}/t/${task.id}`,
          },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'todo_list',
    {
      title: '查询待办列表',
      description: '按状态、级别、项目或关键字查询任务。',
      inputSchema: {
        status: z
          .array(z.enum(['pending', 'acked', 'done', 'archived']))
          .optional()
          .describe('默认只查 pending'),
        severity: z.array(z.enum(SEVERITIES)).optional(),
        project: z.string().optional(),
        source: z.string().optional().describe('按来源（AI 工具名）过滤，例如 trae'),
        q: z.string().optional().describe('标题或正文关键字'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      try {
        const { tasks } = await api.listTasks({
          status: args.status ?? ['pending'],
          severity: args.severity as TaskSeverity[] | undefined,
          project: args.project,
          source: args.source,
          q: args.q,
          limit: args.limit ?? 50,
        });
        if (tasks.length === 0) {
          return { content: [{ type: 'text' as const, text: '没有符合条件的任务。' }] };
        }
        const lines = tasks.map(
          (t) =>
            `- [${t.severity}] ${t.title}${t.project ? `（${t.project}）` : ''}${t.detail ? ` — ${t.detail.slice(0, 120)}` : ''}`,
        );
        return {
          content: [{ type: 'text' as const, text: `共 ${tasks.length} 条：\n${lines.join('\n')}` }],
          structuredContent: { count: tasks.length, tasks },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'todo_update',
    {
      title: '修改待办事项',
      description: '修改任务的标题、详情、级别或项目。',
      inputSchema: {
        id: z.string().min(1).describe('任务 ID'),
        title: z.string().min(1).max(200).optional(),
        detail: z.string().max(8000).optional(),
        severity: z.enum(SEVERITIES).optional(),
        project: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const { task } = await api.updateTask(args.id, {
          title: args.title,
          detail: args.detail,
          severity: args.severity as TaskSeverity | undefined,
          project: args.project,
        });
        return {
          content: [{ type: 'text' as const, text: `已更新 #${task.id.slice(0, 8)}：${task.title}` }],
          structuredContent: { task_id: task.id, status: task.status },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'todo_ack',
    {
      title: '标记为已接手',
      description: '把任务标记为「我已接手」，停止重复提醒。',
      inputSchema: { id: z.string().min(1).describe('任务 ID') },
    },
    async (args) => {
      try {
        const { task } = await api.setStatus(args.id, 'acked');
        return {
          content: [{ type: 'text' as const, text: `已接手 #${task.id.slice(0, 8)}：${task.title}` }],
          structuredContent: { task_id: task.id, status: task.status },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'todo_done',
    {
      title: '标记为已完成',
      description: '把任务标记为已完成。',
      inputSchema: { id: z.string().min(1).describe('任务 ID') },
    },
    async (args) => {
      try {
        const { task } = await api.setStatus(args.id, 'done');
        return {
          content: [{ type: 'text' as const, text: `已完成 #${task.id.slice(0, 8)}：${task.title}` }],
          structuredContent: { task_id: task.id, status: task.status },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'todo_archive',
    {
      title: '归档待办事项',
      description: '把任务归档（忽略掉，不再出现在待处理列表里）。',
      inputSchema: { id: z.string().min(1).describe('任务 ID') },
    },
    async (args) => {
      try {
        const { task } = await api.setStatus(args.id, 'archived');
        return {
          content: [{ type: 'text' as const, text: `已归档 #${task.id.slice(0, 8)}：${task.title}` }],
          structuredContent: { task_id: task.id, status: task.status },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'todo_snooze',
    {
      title: '推迟提醒',
      description: '把任务的提醒时间推迟到指定时刻。',
      inputSchema: {
        id: z.string().min(1).describe('任务 ID'),
        until: z.string().min(4).describe('ISO 8601 时间'),
      },
    },
    async (args) => {
      try {
        const { task } = await api.snooze(args.id, args.until);
        return {
          content: [{ type: 'text' as const, text: `已推迟到 ${task.due_at}` }],
          structuredContent: { task_id: task.id, due_at: task.due_at },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerResource(
    'tasks',
    'todo://tasks',
    {
      title: '待我关注的任务',
      description: '当前处于待处理状态的任务列表（Markdown）',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const { tasks } = await api.listTasks({ status: ['pending'], limit: 100 });
      const text =
        tasks.length === 0
          ? '# 待我关注\n\n暂无待处理任务。'
          : `# 待我关注（${tasks.length}）\n\n` +
            tasks
              .map((t) => `- **${t.title}**${t.project ? ` _(${t.project})_` : ''}\n  ${t.detail ?? ''}`)
              .join('\n');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] };
    },
  );

  return server;
}

export async function runStdioServer(opts: McpServerOptions): Promise<void> {
  const server = createMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`已启动，base=${opts.baseUrl} session=${opts.sessionKey}`);

  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function hash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

export function defaultSessionKey(): string {
  return randomUUID();
}
