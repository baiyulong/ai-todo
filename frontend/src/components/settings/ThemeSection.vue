<script setup>
/* 主题选择区：产品（Apple 风）/ 像素 / 黑客 */

import { useUiStore } from '../../stores/ui.js';
import { t } from '../../i18n.js';

const ui = useUiStore();

const THEMES = [
  { id: 'product', label: () => t('theme.product'), desc: () => t('theme.productDesc') },
  { id: 'pixel', label: () => t('theme.pixel'), desc: () => t('theme.pixelDesc') },
  { id: 'hacker', label: () => t('theme.hacker'), desc: () => t('theme.hackerDesc') },
];
</script>

<template>
  <div class="drawer-section">
    <h3>{{ t('section.theme') }}</h3>
    <div class="theme-options">
      <button
        v-for="th in THEMES"
        :key="th.id"
        class="theme-option"
        :class="{ 'is-active': ui.theme === th.id }"
        type="button"
        :data-theme-preview="th.id"
        @click="ui.setTheme(th.id)"
      >
        <span class="theme-option-name">{{ th.label() }}</span>
        <span class="theme-option-desc">{{ th.desc() }}</span>
      </button>
    </div>
  </div>
</template>
