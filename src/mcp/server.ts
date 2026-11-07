import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { TaskSeverity, TaskStatus } from '../domain/types.js';
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
        '只推真正需要人介入的事；纯进度更新不要调用。notify=false 表示只记录不打扰用户。' +
        '如果需要用户的答复才能继续：todo_create 会返回 task_id（完整 UUID），后续 todo_wait_reply / todo_get_reply 等工具必须传这个完整 task_id，' +
        '不要截短；文本输出里的 task_id=xxx 就是完整值。询问用户后调用 todo_wait_reply 挂起等待；' +
        '用户在网页上回复后任务完成，回复内容随工具结果返回，据此继续完成任务。',
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
        const hint = created
          ? '。如需等待用户答复后继续，可调用 todo_wait_reply 传入这个 task_id'
          : '';
        // 完整 task_id 必须出现在文本里：不少客户端只把 text 给模型看，
        // 短号会让模型拿去调 todo_wait_reply 然后被 UUID 校验打回
        return {
          content: [
            {
              type: 'text' as const,
              text: `${prefix} task_id=${task.id}：${task.title}${hint}`,
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
      description:
        '按状态、级别、项目或关键字查询任务。默认查 pending/acked/done（不含已归档），' +
        '返回的每条任务都带完整 task_id（UUID），后续操作传这个完整值。',
      inputSchema: {
        status: z
          .union([z.enum(['pending', 'acked', 'done', 'archived']), z.array(z.enum(['pending', 'acked', 'done', 'archived']))])
          .optional()
          .describe('默认 pending,acked,done；传单个字符串或数组都可以'),
        severity: z.union([z.enum(SEVERITIES), z.array(z.enum(SEVERITIES))]).optional(),
        project: z.string().optional(),
        source: z.string().optional().describe('按来源（AI 工具名）过滤，例如 trae'),
        q: z.string().optional().describe('标题或正文关键字'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      try {
        const asArray = (v: string | string[] | undefined): string[] | undefined =>
          v === undefined ? undefined : Array.isArray(v) ? v : [v];
        const { tasks } = await api.listTasks({
          status: (asArray(args.status) ?? ['pending', 'acked', 'done']) as TaskStatus[],
          severity: asArray(args.severity) as TaskSeverity[] | undefined,
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
            `- task_id=${t.id} [${t.status}] [${t.severity}] ${t.title}${t.project ? `（${t.project}）` : ''}${t.detail ? ` — ${t.detail.slice(0, 120)}` : ''}`,
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
      description:
        '修改任务的标题、详情、级别或项目。注意：更新已完成（done）或已归档（archived）的任务会把它重新打开为 pending，' +
        '用户会再次看到并需要处理它；如果这是一件全新的事项，请改用 todo_create 新建，不要复用旧任务。' +
        '汇报进展等需要保留上下文的更新，用 append=true 把新内容追加到详情末尾而不是覆盖。',
      inputSchema: {
        id: z.string().min(1).describe('完整任务 ID（UUID），来自 todo_create 返回的 task_id，不要截短'),
        title: z.string().min(1).max(200).optional(),
        detail: z.string().max(8000).optional(),
        append: z
          .boolean()
          .optional()
          .describe('true=把 detail 追加到现有详情后面（自动带时间分隔线），保留历史内容；默认 false=直接覆盖 detail'),
        severity: z.enum(SEVERITIES).optional(),
        project: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const { task } = await api.updateTask(args.id, {
          title: args.title,
          detail: args.detail,
          append: args.append === true,
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
        id: z.string().min(1).describe('完整任务 ID（UUID），来自 todo_create 返回的 task_id，不要截短'),
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

  server.registerTool(
    'todo_get_reply',
    {
      title: '查询任务回复',
      description: '即时查询用户对某个任务的回复（不等待）。回复后任务状态为 done。适合不想挂起的客户端低频轮询。',
      inputSchema: {
        id: z.string().min(1).describe('完整任务 ID（UUID），来自 todo_create 返回的 task_id，不要截短'),
      },
    },
    async (args) => {
      try {
        const { task, replied } = await api.getReply(args.id);
        if (replied) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `用户已回复 #${task.id.slice(0, 8)}：${task.reply_text}`,
              },
            ],
            structuredContent: {
              task_id: task.id,
              status: task.status,
              replied: true,
              reply: task.reply_text,
              replied_at: task.replied_at,
            },
          };
        }
        const note =
          task.status === 'done'
            ? '任务已完成，但没有留下文字回复。'
            : task.status === 'archived'
              ? '任务已被归档，不会有回复了。'
              : '用户尚未回复。';
        return {
          content: [{ type: 'text' as const, text: `#${task.id.slice(0, 8)} ${note}` }],
          structuredContent: { task_id: task.id, status: task.status, replied: false },
        };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    'todo_wait_reply',
    {
      title: '等待任务回复',
      description:
        '挂起等待用户在网页上回复指定任务，用户一回复立刻返回回复内容。' +
        '超时未回复返回 replied=false，可再次调用继续等待（推荐循环调用直到拿到回复或任务被归档）。' +
        '上限 25 秒是为了避开 MCP 客户端默认的工具调用超时（通常约 60 秒）。',
      inputSchema: {
        id: z.string().min(1).describe('完整任务 ID（UUID），来自 todo_create 返回的 task_id，不要截短'),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe('最长等待秒数，默认 20，上限 25'),
      },
    },
    async (args) => {
      try {
        const { task, replied } = await api.getReply(args.id, args.timeout ?? 20);
        if (replied) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `用户已回复 #${task.id.slice(0, 8)}：${task.reply_text}`,
              },
            ],
            structuredContent: {
              task_id: task.id,
              status: task.status,
              replied: true,
              reply: task.reply_text,
              replied_at: task.replied_at,
            },
          };
        }
        const note =
          task.status === 'archived'
            ? '任务已被归档，停止等待。'
            : task.status === 'done'
              ? '任务已标记完成，但没有留下文字回复。'
              : '等待超时，用户尚未回复；如需继续等待可再次调用本工具。';
        return {
          content: [{ type: 'text' as const, text: `#${task.id.slice(0, 8)} ${note}` }],
          structuredContent: { task_id: task.id, status: task.status, replied: false },
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
