<template>
  <dialog ref="dialog" class="dialog jimeng-confirmation" :aria-labelledby="titleId" @cancel.prevent="finish(false)">
    <template v-if="pending">
      <header class="dialog-head">
        <h2 :id="titleId" class="dialog-title">确认即梦积分</h2>
      </header>
      <div class="dialog-body">
        <p>{{ pending.shotLabel }} · {{ pending.quote.model }}<template v-if="pending.duration"> · {{ pending.duration }} 秒</template></p>
        <p>即梦官方报价，本次最多扣除 <strong>{{ formatCredits(pending.quote.credits) }} 积分</strong>。</p>
        <p v-if="pending.replacing">本次会提交新的任务。若先前的任务已被即梦受理，可能已产生扣点。</p>
      </div>
      <footer class="dialog-foot">
        <button v-if="allowBatchCancel" type="button" class="btn" @click="$emit('cancel-batch')">取消本集视频生成</button>
        <button type="button" class="btn" autofocus @click="finish(false)">{{ allowBatchCancel ? '跳过本段' : '取消' }}</button>
        <button type="button" class="btn btn-primary" @click="finish(true)">确认扣点并生成</button>
      </footer>
    </template>
  </dialog>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, shallowRef, useId } from 'vue'
import type { JimengVideoQuote } from '~/utils/jimengVideo'

defineProps<{ allowBatchCancel?: boolean }>()
defineEmits<{ 'cancel-batch': [] }>()
const titleId = useId()
const dialog = ref<HTMLDialogElement | null>(null)
const pending = shallowRef<{ quote: JimengVideoQuote; shotLabel: string; replacing: boolean; duration?: number; resolve: (approved: boolean) => void }>()
const formatCredits = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 20 }).format

async function approve(quote: JimengVideoQuote, shotLabel: string, replacing = false, duration?: number): Promise<boolean> {
  if (pending.value || !dialog.value) return false
  const expiresAt = Date.parse(quote.expires_at)
  if (!quote.quote_id || !Number.isFinite(quote.credits) || quote.credits < 0 || !Number.isFinite(expiresAt)) {
    throw new Error('未取得有效的即梦积分报价')
  }
  if (Date.now() >= expiresAt) throw new Error('即梦报价已过期，请重新生成以获取报价')
  const confirmation = new Promise<boolean>(resolve => { pending.value = { quote, shotLabel, replacing, duration, resolve } })
  await nextTick()
  if (!dialog.value || !pending.value) return false
  try {
    dialog.value.showModal()
  } catch (error) {
    finish(false)
    throw error
  }
  const approved = await confirmation
  if (approved && Date.now() >= expiresAt) throw new Error('即梦报价已过期，请重新生成以获取报价')
  return approved
}

function finish(approved: boolean) {
  const request = pending.value
  pending.value = undefined
  if (dialog.value?.open) dialog.value.close()
  request?.resolve(approved)
}

onBeforeUnmount(() => finish(false))
defineExpose({ approve, cancel: () => finish(false) })
</script>

<style scoped>
.jimeng-confirmation {
  position: fixed;
  inset: 0;
  width: min(440px, calc(100vw - 32px));
  margin: auto;
  padding: 0;
  border: 1px solid var(--border);
  color: var(--text-0);
}
.jimeng-confirmation:not([open]) { display: none; }
.jimeng-confirmation::backdrop { background: var(--scrim); }
.dialog-body { display: grid; gap: 8px; }
</style>
