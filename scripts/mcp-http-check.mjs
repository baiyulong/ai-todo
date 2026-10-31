#!/usr/bin/env node
/**
 * AI Todo · 远程 MCP（Streamable HTTP）连通性自检
 *
 * 用真实的 MCP 客户端协议去连远端端点，走完 initialize → tools/list →
 * tools/call → resources/read 全流程。配置完 AI 客户端后，拿它验证一遍最省事：
 *
 *   node scripts/mcp-http-check.mjs --url http://192.168.1.20:8787/mcp --token ait_xxx
 *
 * 默认地址与令牌都从环境变量读，避免令牌落进命令行历史：
 *   AI_TODO_BASE_URL=http://192.168.1.20:8787/mcp
 *   AI_TODO_TOKEN=ait_xxx
 *   node scripts/mcp-http-check.mjs
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const baseUrl = (arg('url') || process.env.AI_TODO_BASE_URL || 'http://127.0.0.1:8787/mcp').trim();
const token = (arg('token') || process.env.AI_TODO_TOKEN || '').trim();
const agent = (arg('agent') || process.env.AI_TODO_AGENT || 'mcp-http-check').trim();

if (!token) {
  console.error('缺少访问令牌。用 --token 传，或设 AI_TODO_TOKEN 环境变量。');
  console.error('令牌可在 Web 端「设置 → 访问令牌」自助签发。');
  process.exit(2);
}

// 远端端点通常不带路径后缀，补一个 /mcp
const endpoint = baseUrl.endsWith('/mcp') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/mcp`;

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: {
    headers: {
      authorization: `Bearer ${token}`,
      'x-ai-todo-agent': agent,
    },
  },
});

const client = new Client({ name: 'ai-todo-http-check', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log(`✅ 已连接 ${endpoint}`);
  console.log(`   服务端：${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`);

  const { tools } = await client.listTools();
  console.log(`✅ 工具 ${tools.length} 个：`);
  for (const tool of tools) console.log(`   - ${tool.name}`);

  const title = `远程 MCP 自检：${new Date().toISOString()}`;
  const created = await client.callTool({
    name: 'todo_create',
    arguments: { title, severity: 'info', notify: false },
  });
  const taskId = created.structuredContent?.task_id;
  console.log(`✅ todo_create 成功：${created.content?.[0]?.text}`);
  console.log(`   任务 ID：${taskId}`);

  const listed = await client.callTool({ name: 'todo_list', arguments: { limit: 3 } });
  console.log(`✅ todo_list 成功：${String(listed.content?.[0]?.text).split('\n')[0]}`);

  const resource = await client.readResource({ uri: 'todo://tasks' });
  console.log(`✅ resources/read 成功：${String(resource.contents?.[0]?.text).split('\n')[0]}`);

  if (taskId) {
    await client.callTool({ name: 'todo_archive', arguments: { id: taskId } });
    console.log('✅ 清理：自检任务已归档');
  }

  console.log('\n全部通过：远程 MCP 端点可用。');
  await client.close();
} catch (error) {
  console.error('❌ 失败：', error?.message ?? error);
  process.exitCode = 1;
} finally {
  await transport.close?.().catch(() => {});
}
