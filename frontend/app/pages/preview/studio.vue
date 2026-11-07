<template><div>正在进入导演空间…</div></template>
<script setup lang="ts">
await navigateTo({ path: '/', query: { interface: 'cinematic' } }, { replace: true })
</script>
