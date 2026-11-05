/* 会话与账号状态：当前用户、来源列表、可转交用户、登录方式、视图内一次性凭据 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../api.js';
import { useUiStore } from './ui.js';

export const useSessionStore = defineStore('session', () => {
  const ui = useUiStore();

  /** 是否已登录（决定渲染登录页还是主界面） */
  const authed = ref(false);
  const booted = ref(false);

  /** /api/v1/me 的返回：用户信息 + rules + pending/archived 计数 */
  const me = ref(null);
  const rules = ref(null);

  /** 任务来源（哪些 AI 工具推过任务），来源筛选下拉与卡片 chip 用 */
  const sources = ref(new Map());

  /** 全体有效账号（转交任务时的选人下拉） */
  const users = ref([]);

  /** 服务端支持的登录方式 */
  const wechat = ref({ enabled: false, mode: 'qrconnect', mock: false });

  /** 最近一次拿到的 MCP 明文令牌（设置页 MCP 配置块直接用） */
  const lastToken = ref(null);

  /** 最近一次创建/重置账号拿到的初始凭据，只在当前页面显示一次 */
  const freshUserCredentials = ref(null);

  const loadAuthProviders = async () => {
    try {
      const res = await api.get('/api/v1/auth/providers');
      wechat.value = res.wechat || { enabled: false };
    } catch {
      wechat.value = { enabled: false };
    }
  };

  const loadMe = async () => {
    try {
      me.value = await api.get('/api/v1/me');
      rules.value = me.value.rules;
    } catch { /* 忽略 */ }
  };

  const loadSources = async () => {
    try {
      const { sources: list } = await api.get('/api/v1/me');
      sources.value = new Map((list || []).map((s) => [s.id, s]));
    } catch { /* 忽略 */ }
  };

  /** 拉取可转交的用户列表。失败不致命：下拉为空时转交按钮禁用。 */
  const loadUsers = async () => {
    try {
      const { users: list } = await api.get('/api/v1/users');
      users.value = list || [];
    } catch { /* 忽略 */ }
  };

  /** 登录成功后 / 进入应用前的初始化 */
  const bootstrap = async () => {
    authed.value = true;
    await loadSources();
    await loadMe();
    loadUsers();
  };

  const showLogin = () => {
    authed.value = false;
    ui.setLive('down');
  };

  const doLogout = async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch { /* 忽略：本地照样回到登录页 */ }
    showLogin();
  };

  /** 启动时探测会话：有有效会话直接进主界面 */
  const tryLogin = async () => {
    try {
      await api.get('/api/v1/me');
      await bootstrap();
    } catch {
      /* 401 已在 api 层触发 showLogin */
    }
    booted.value = true;
  };

  return {
    authed,
    booted,
    me,
    rules,
    sources,
    users,
    wechat,
    lastToken,
    freshUserCredentials,
    loadAuthProviders,
    loadMe,
    loadSources,
    loadUsers,
    bootstrap,
    showLogin,
    doLogout,
    tryLogin,
  };
});
