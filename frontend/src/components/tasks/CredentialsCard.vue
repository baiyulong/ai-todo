<script setup>
/* 一次性凭据卡：新建账号 / 重置密码后显示的初始密码与 MCP 令牌 */

import { t } from '../../i18n.js';

defineProps({
  creds: { type: Object, required: true },
});
defineEmits(['copy', 'dismiss']);
</script>

<template>
  <div class="mgmt-card token-secret credentials-card">
    <div class="token-secret-label">
      <!-- 建号与重置密码共用这张一次性凭据卡，标题按来源区分 -->
      {{ creds.kind === 'reset'
        ? t('user.resetFor', { username: creds.username })
        : t('user.createdFor', { username: creds.username }) }}
    </div>

    <div class="cred-label">{{ t('user.createdPassword') }}</div>
    <div class="qr-token-row">
      <code>{{ creds.password }}</code>
      <button class="btn btn-sm" type="button" @click="$emit('copy', creds.password)">{{ t('token.copy') }}</button>
    </div>

    <template v-if="creds.token">
      <div class="cred-label">{{ t('user.createdTokenLabel') }}</div>
      <div class="qr-token-row">
        <code>{{ creds.token }}</code>
        <button class="btn btn-sm" type="button" @click="$emit('copy', creds.token)">{{ t('token.copy') }}</button>
      </div>
    </template>

    <button class="btn btn-sm btn-quiet" type="button" style="margin-top: 4px" @click="$emit('dismiss')">
      {{ t('user.credentialDismiss') }}
    </button>
  </div>
</template>
