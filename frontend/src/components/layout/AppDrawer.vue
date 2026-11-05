<script setup>
/* 侧栏抽屉：设置（通知规则已并入其中） */

import { useUiStore } from '../../stores/ui.js';
import { t } from '../../i18n.js';
import SettingsPanel from '../settings/SettingsPanel.vue';

const ui = useUiStore();
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.drawerMode" class="drawer-backdrop" @click="ui.closeDrawer()"></div>
    <aside v-if="ui.drawerMode" class="drawer" :aria-label="t('drawer.settings')">
      <div class="drawer-head">
        <h2>{{ t('drawer.settings') }}</h2>
        <button class="icon-btn" type="button" :aria-label="t('drawer.close')" @click="ui.closeDrawer()">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="drawer-body">
        <SettingsPanel />
      </div>
    </aside>
  </Teleport>
</template>
