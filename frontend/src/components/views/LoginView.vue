<script setup>
/* 登录页：账号密码 + 微信扫码（服务端没配 AppID 时微信入口隐藏） */

import { reactive, ref } from 'vue';
import { api, translateError } from '../../api.js';
import { t, getLocale, setLocale } from '../../i18n.js';
import { useSessionStore } from '../../stores/session.js';
import {
  loginError,
  loginQr,
  startWechatLogin,
  cancelWechatLogin,
} from '../../wechat.js';

const session = useSessionStore();

const username = ref('');
const password = ref('');
const showPassword = ref(false);
const submitting = ref(false);
const formError = ref('');

function toggleLocale() {
  setLocale(getLocale() === 'zh-CN' ? 'en-US' : 'zh-CN');
}

async function submit() {
  formError.value = '';
  // 提交期间锁住按钮：避免重复点击打多次登录请求
  submitting.value = true;
  try {
    await api.post('/api/v1/auth/login', {
      username: username.value.trim(),
      password: password.value,
    });
    password.value = '';
    showPassword.value = false;
    await session.bootstrap();
  } catch (err) {
    const msg =
      err.code === 'unauthorized' || err.code === 'invalid_credentials'
        ? t('login.invalidCredentials')
        : translateError(err);
    // 登录失败显示在表单下方；登录成功后的初始化出错则弹全局提示
    formError.value = msg;
  } finally {
    submitting.value = false;
  }
}

/** 服务端支持微信登录时才显示入口 */
function wechatEnabled() {
  return !!session.wechat.enabled;
}
</script>

<template>
  <div class="login-screen">
    <form class="login-card" @submit.prevent="submit">
      <!-- 登录页也要能切语言：不然英文系统环境的人连登录都进不去 -->
      <button class="login-locale" type="button" :title="t('topbar.language')" :aria-label="t('topbar.language')" @click="toggleLocale">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" /></svg>
      </button>
      <div class="login-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>
      </div>
      <h1>{{ t('login.title') }}</h1>
      <p class="login-hint"><span>{{ t('login.hint') }}</span> <code>{{ t('login.hintFile') }}</code></p>

      <div class="field">
        <label class="field-label" for="login-username">{{ t('login.username') }}</label>
        <div class="field-box">
          <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
          <input
            id="login-username"
            v-model="username"
            class="input"
            type="text"
            autocomplete="username"
            spellcheck="false"
            autocapitalize="off"
            required
            :placeholder="t('login.usernamePlaceholder')"
          >
        </div>
      </div>

      <div class="field">
        <label class="field-label" for="login-password">{{ t('login.password') }}</label>
        <div class="field-box">
          <svg class="field-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          <input
            id="login-password"
            v-model="password"
            class="input"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="current-password"
            required
            :placeholder="t('login.passwordPlaceholder')"
          >
          <button
            class="field-toggle"
            type="button"
            :aria-pressed="String(showPassword)"
            :aria-label="showPassword ? t('login.hidePassword') : t('login.showPassword')"
            :title="showPassword ? t('login.hidePassword') : t('login.showPassword')"
            @click="showPassword = !showPassword"
          >
            <svg v-if="!showPassword" class="eye-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
            <svg v-else class="eye-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" /><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="2" x2="22" y1="2" y2="22" /></svg>
          </button>
        </div>
      </div>

      <button class="btn btn-primary btn-block login-submit" type="submit" :disabled="submitting" :class="{ 'is-loading': submitting }">
        <span class="spinner" aria-hidden="true"></span>
        <span class="btn-label">{{ t('login.submit') }}</span>
      </button>
      <p v-if="formError || loginError" class="login-error">{{ formError || loginError }}</p>

      <!-- 微信扫码登录：服务端没配 AppID 时整个入口隐藏 -->
      <div v-if="wechatEnabled()" class="login-sep">
        <span>{{ t('login.or') }}</span>
      </div>
      <button v-if="wechatEnabled()" class="btn btn-wechat btn-block" type="button" @click="startWechatLogin()">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.7 3C4.9 3 1.8 5.6 1.8 8.8c0 1.8 1 3.4 2.6 4.5l-.7 2 2.4-1.2c.7.2 1.5.3 2.3.3h.6a5 5 0 0 1-.1-1c0-3 3-5.5 6.7-5.5h.6C16.2 4.8 12.7 3 8.7 3Zm-2.4 3.4a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm4.8 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z" /><path d="M22.2 14.4c0-2.4-2.4-4.4-5.3-4.4s-5.3 2-5.3 4.4 2.4 4.4 5.3 4.4c.6 0 1.2-.1 1.8-.2l2 1-.5-1.7c1.2-.8 2-2 2-3.5Zm-7-.7a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm3.4 0a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z" /></svg>
        <span>{{ t('login.wechatLogin') }}</span>
      </button>

      <!-- 扫码面板：点了「微信登录」才出现 -->
      <div v-if="loginQr.panel" class="qr-panel">
        <div class="qr-frame">
          <!-- 二维码由本地 qr.js 生成，内容本地可控 -->
          <div v-if="loginQr.svg" class="qr-svg" v-html="loginQr.svg"></div>
          <a class="qr-link" :href="loginQr.authorizeUrl || '#'" target="_blank" rel="noopener noreferrer">{{ loginQr.ok ? t('login.wechatOpenLink') : t('login.wechatQrFailed') }}</a>
        </div>
        <p class="qr-tip">{{ loginQr.tip }}</p>
        <button class="btn btn-sm btn-quiet" type="button" @click="cancelWechatLogin()">{{ t('login.wechatCancel') }}</button>
      </div>
    </form>
  </div>
</template>
