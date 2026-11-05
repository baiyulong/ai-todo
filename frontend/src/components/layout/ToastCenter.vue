<script setup>
/* 全局 toast 出口 */

import { useUiStore } from '../../stores/ui.js';
</script>

<template>
  <div class="toast-wrap">
    <div
      v-for="item in useUiStore().toasts"
      :key="item.id"
      class="toast"
      :class="{ err: item.isError, leaving: item.leaving }"
    >
      {{ item.message }}
    </div>
  </div>
</template>
