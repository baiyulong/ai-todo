<script setup>
/* 帮助文档：右上角问号图标打开，内容由 i18n 的 help.doc（Markdown）渲染。
   MarkdownView 输出 VNode 树（非 v-html），文本由 Vue 自动转义。 */
import { useUiStore } from '../../stores/ui.js';
import { useModalDialog } from '../../composables/modalDialog.js';
import MarkdownView from '../MarkdownView.vue';
import { t } from '../../i18n.js';

const ui = useUiStore();
const dlg = useModalDialog(() => ui.helpOpen);

function close() {
  ui.closeHelp();
}
</script>

<template>
  <dialog ref="dlg" class="dialog help-dialog" @cancel.prevent="close">
    <div class="dialog-inner">
      <div class="help-head">
        <h2>{{ t('help.title') }}</h2>
        <button class="icon-btn" type="button" :aria-label="t('help.close')" @click="close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
        </button>
      </div>
      <MarkdownView class="help-body" :src="t('help.doc')" />
    </div>
  </dialog>
</template>
