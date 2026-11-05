<script setup>
/* 首次微信登录自动签发的 MCP 令牌：明文只此一次，弹窗是唯一能可靠看到它的时机 */

import { useUiStore } from '../../stores/ui.js';
import { tokenDialogToken, stopWechatPoll } from '../../wechat.js';
import { copyText } from '../../composables/clipboard.js';
import { t } from '../../i18n.js';

const ui = useUiStore();

function close() {
  tokenDialogToken.value = '';
}

async function copy() {
  const ok = await copyText(tokenDialogToken.value);
  ui.toast(ok ? t('wechat.tokenCopied') : t('wechat.tokenCopyFailed'), !ok);
}
</script>

<template>
  <dialog :open="!!tokenDialogToken" class="dialog" @cancel.prevent="close">
    <div class="dialog-inner">
      <h2>{{ t('wechat.tokenTitle') }}</h2>
      <p class="dialog-note">{{ t('wechat.tokenHint') }}</p>
      <div class="qr-token-row">
        <code>{{ tokenDialogToken }}</code>
        <button class="btn btn-sm" type="button" @click="copy">{{ t('wechat.tokenCopy') }}</button>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-primary" type="button" @click="close">{{ t('confirm.ok') }}</button>
      </div>
    </div>
  </dialog>
</template>
