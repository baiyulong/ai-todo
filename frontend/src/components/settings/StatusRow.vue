<script setup>
/* 状态行：键值对展示，v 可带 ok / warn / bad 徽标色 */

defineProps({
  k: { type: String, required: true },
  v: { type: String, required: true },
  cls: { type: String, default: '' },
});
</script>

<template>
  <div class="status-row">
    <span class="k">{{ k }}</span>
    <span class="v" :class="cls ? 'badge-' + cls : ''">{{ v }}</span>
  </div>
</template>
