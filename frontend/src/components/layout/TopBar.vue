<script setup>
/* 顶栏：品牌 + 未读数、实时状态点、用户菜单、语言/规则/设置入口 */

import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { t, getLocale, setLocale } from '../../i18n.js';

const ui = useUiStore();
const session = useSessionStore();

const menuOpen = ref(false);
const userMenuRoot = ref(null);

const name = computed(() => session.me?.username || session.me?.display_name || '');
const avatar = computed(() => name.value.slice(0, 1));
const roleLabel = computed(() =>
  session.me?.is_admin ? t('status.roleAdmin') : t('status.roleUser'),
);

const liveText = computed(() => {
  if (ui.live === 'live') return t('topbar.live');
  if (ui.live === 'down') return t('topbar.offline');
  return t('topbar.connecting');
});

// 标签页标题带未读数，切到别的标签也能瞄一眼还剩几条
watch(
  () => session.me?.pending ?? 0,
  (n) => {
    document.title = n ? `(${n}) AI Todo` : 'AI Todo';
  },
);

function toggleLocale() {
  setLocale(getLocale() === 'zh-CN' ? 'en-US' : 'zh-CN');
}

function onDocClick(e) {
  if (userMenuRoot.value && !userMenuRoot.value.contains(e.target)) menuOpen.value = false;
}

onMounted(() => document.addEventListener('click', onDocClick));
onUnmounted(() => document.removeEventListener('click', onDocClick));

async function logout() {
  menuOpen.value = false;
  await session.doLogout();
}
</script>

<template>
  <header class="topbar">
    <div class="topbar-left">
      <span class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
      </span>
      <span class="brand">AI Todo</span>
      <span class="pending-pill" :hidden="!session.me?.pending">{{ session.me?.pending ?? 0 }}</span>
    </div>
    <div class="topbar-right">
      <span class="live-dot" :data-state="ui.live" :title="t('topbar.liveStatus')">
        <i></i><span>{{ liveText }}</span>
      </span>

      <!-- 当前用户：点开可看账号信息、令牌/用户入口、退出登录 -->
      <div ref="userMenuRoot" class="user-menu">
        <button
          v-if="name"
          class="user-chip"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="String(menuOpen)"
          :title="t('topbar.currentAccount')"
          @click.stop="menuOpen = !menuOpen"
        >
          <span class="avatar" aria-hidden="true">{{ avatar }}</span>
          <span class="user-name">{{ name }}</span>
          <svg class="user-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div v-if="name" class="user-dropdown" role="menu" :hidden="!menuOpen">
          <div class="user-dropdown-head">
            <div class="user-dropdown-name">{{ name }}</div>
            <div class="user-dropdown-role">{{ roleLabel }}</div>
          </div>
          <!-- 设置走顶栏齿轮按钮的单一入口；这里只放独立界面与退出 -->
          <button class="user-menu-item" type="button" role="menuitem" @click="menuOpen = false; ui.setView('tokens')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></svg>
            <span>{{ t('topbar.tokens') }}</span>
          </button>
          <!-- 用户管理是管理员专属入口：不是管理员直接藏起来 -->
          <button v-if="session.me?.is_admin" class="user-menu-item" type="button" role="menuitem" @click="menuOpen = false; ui.setView('users')">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
            <span>{{ t('topbar.users') }}</span>
          </button>
          <button class="user-menu-item is-danger" type="button" role="menuitem" @click="logout">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
            <span>{{ t('topbar.logout') }}</span>
          </button>
        </div>
      </div>

      <button class="icon-btn" type="button" :title="t('topbar.language')" @click="toggleLocale">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" /></svg>
      </button>
      <button class="icon-btn" type="button" :title="t('topbar.rules')" @click="ui.openDrawer('rules')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>
      <button class="icon-btn" type="button" :title="t('topbar.settings')" @click="ui.openDrawer('settings')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></svg>
      </button>
    </div>
  </header>
</template>
