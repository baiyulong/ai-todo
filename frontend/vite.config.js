import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 后端地址：本地起后端（npm run dev，默认 8787）时用环境变量 AI_TODO_PORT 覆盖
const backend = `http://127.0.0.1:${process.env.BACKEND_PORT || 8787}`;

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // REST API 与 MCP 都转发给后端；SSE 走 /api/v1/stream，不能缓冲
      '/api': { target: backend, changeOrigin: true, proxyTimeout: 0 },
      '/mcp': { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
