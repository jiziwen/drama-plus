<template>
  <NuxtPage :key="attempt" />
  <section v-if="pageFailed" class="workspace-page-error" role="alert">
    <h1>页面暂时无法显示</h1>
    <button type="button" class="btn btn-primary" @click="retry">重试当前页面</button>
  </section>
</template>

<script setup lang="ts">
import { onErrorCaptured, ref, watch } from 'vue'

const pageFailed = ref(false)
const attempt = ref(0)
const router = useRouter()

onErrorCaptured(() => {
  pageFailed.value = true
})

watch(router.currentRoute, () => {
  pageFailed.value = false
})

function retry() {
  pageFailed.value = false
  attempt.value++
}
</script>

<style scoped>
.workspace-page-error {
  display: none;
}

/* A child component can fail while the page and its editor remain usable. */
.workspace-page-error:only-child {
  display: grid;
  justify-items: center;
  gap: 16px;
  align-self: center;
  margin: auto;
  padding: 24px;
  text-align: center;
}

.workspace-page-error h1 {
  font-size: 18px;
  margin: 0;
}
</style>
