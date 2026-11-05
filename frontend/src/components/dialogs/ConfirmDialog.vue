<script setup>
/* 通用确认框：不可逆动作的二次确认。
   不用原生 confirm()：它在部分 WebView / PWA / 自动化环境里会被直接吞掉。 */

import { useUiStore } from '../../stores/ui.js';
import { t } from '../../i18n.js';

const ui = useUiStore();
</script>

<template>
  <dialog :open="!!ui.confirmState" class="dialog" @cancel.prevent="ui.resolveConfirm(false)">
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
