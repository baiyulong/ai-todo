<script setup>
/* 顶部横幅：通知权限提示 + 邮箱未绑定提示 */

import { computed } from 'vue';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { t } from '../../i18n.js';
import { requestNotifyPermission } from '../../composables/notify.js';

const ui = useUiStore();
const session = useSessionStore();

const notifyBanner = computed(() => {
  if (ui.notifyPerm === 'granted') return null;
  if (ui.notifyBannerDismissed) return null;
  if (ui.notifyPerm === 'unsupported') return { kind: 'unsupported', enableBtn: false };
  if (ui.notifyPerm === 'denied') return { kind: 'denied', enableBtn: false };
  return { kind: 'default', enableBtn: true };
});

const notifyText = computed(() => {
  const b = notifyBanner.value;
  if (!b) return '';
  if (b.kind === 'unsupported') return t('banner.unsupported');
  if (b.kind === 'denied') return t('banner.denied');
  return t('banner.enable');
});

const emailBannerVisible = computed(() => !!session.me && !session.me.email);
</script>

<template>
  <!-- 通知权限提示 -->
  <div v-if="notifyBanner" class="banner">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
    <span>{{ notifyText }}</span>
    <button v-if="notifyBanner.enableBtn" class="btn btn-sm btn-primary" type="button" @click="requestNotifyPermission()">
      {{ t('banner.enableBtn') }}
    </button>
    <button class="icon-btn icon-btn-sm" type="button" :aria-label="t('banner.close')" @click="ui.notifyBannerDismissed = true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
    </button>
  </div>

  <!-- 邮箱未绑定提示：任务与转交的邮件通知都发不出去，绑定前一直挂着 -->
  <div v-if="emailBannerVisible" class="banner banner-email">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></svg>
    <span>{{ t('email.bannerText') }}</span>
    <button class="btn btn-sm btn-primary" type="button" @click="ui.openDrawer('settings')">
      {{ t('email.bannerBtn') }}
    </button>
  </div>
</template>
