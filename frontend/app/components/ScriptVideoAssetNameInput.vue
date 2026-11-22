<template>
  <input
    v-model="draft"
    class="input"
    :aria-label="`资产名称 ${name}`"
    :title="name"
    :disabled="disabled"
    @focus="beginEdit"
    @blur="finishEdit"
    @keydown.enter="finishOnEnter"
  />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  name: string
  disabled: boolean
  commit: (value: string) => string
}>()

const draft = ref(props.name)
let nameOnFocus: string | undefined

watch(() => props.name, name => {
  if (nameOnFocus === undefined) draft.value = name
})

function beginEdit() {
  nameOnFocus = draft.value
}

function finishEdit(event: FocusEvent) {
  const input = event.currentTarget as HTMLInputElement
  const initial = nameOnFocus
  nameOnFocus = undefined
  draft.value = initial === undefined || input.value === initial ? props.name : props.commit(input.value)
  input.value = draft.value
}

function finishOnEnter(event: KeyboardEvent) {
  if (!event.isComposing) (event.currentTarget as HTMLInputElement).blur()
}
</script>
