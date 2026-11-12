<script setup>
/* 微信绑定对话框：扫码把微信身份挂到当前账号 */

import { bindDialog, closeBindDialog } from '../../wechat.js';
import { useModalDialog } from '../../composables/modalDialog.js';
import { t } from '../../i18n.js';

/* showModal() 模态：悬浮居中 + 遮罩 */
const dlg = useModalDialog(() => !!bindDialog.value);
</script>

<template>
  <dialog ref="dlg" class="dialog" @cancel.prevent="closeBindDialog()">
    <div class="dialog-inner">
      <h2>{{ t('wechat.bindTitle') }}</h2>
      <p class="dialog-note">{{ t('wechat.bindHint') }}</p>
      <div class="qr-frame">
        <div v-if="bindDialog?.svg" class="qr-svg" v-html="bindDialog.svg"></div>
        <a v-else class="qr-link" :href="bindDialog?.authorizeUrl || '#'" target="_blank" rel="noopener noreferrer">{{ t('login.wechatOpenLink') }}</a>
      </div>
      <p class="qr-tip">{{ bindDialog?.status }}</p>
      <div class="dialog-actions">
        <button class="btn" type="button" @click="closeBindDialog()">{{ t('confirm.cancel') }}</button>
      </div>
    </div>
  </dialog>
</template>
