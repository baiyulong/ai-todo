<script setup>
/* 通用确认框：不可逆动作的二次确认。
   不用原生 confirm()：它在部分 WebView / PWA / 自动化环境里会被直接吞掉。 */

import { useUiStore } from '../../stores/ui.js';
import { t } from '../../i18n.js';
import { useModalDialog } from '../../composables/modalDialog.js';

const ui = useUiStore();
/* showModal() 模态：悬浮居中 + 遮罩；:open 绑定只会排在文档流里 */
const dlg = useModalDialog(() => !!ui.confirmState);
</script>

<template>
  <dialog ref="dlg" class="dialog" @cancel.prevent="ui.resolveConfirm(false)">
    <div class="dialog-inner">
      <h2>{{ ui.confirmState?.title || t('confirm.title') }}</h2>
      <p class="dialog-note">{{ ui.confirmState?.text }}</p>
      <div class="dialog-actions">
        <button class="btn" type="button" @click="ui.resolveConfirm(false)">{{ t('confirm.cancel') }}</button>
        <button class="btn btn-danger-solid" type="button" @click="ui.resolveConfirm(true)">
          {{ ui.confirmState?.okLabel || t('confirm.ok') }}
        </button>
      </div>
    </div>
  </dialog>
</template>
