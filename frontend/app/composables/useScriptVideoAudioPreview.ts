import { ref } from 'vue'

const hoverDelay = 240
const sampleLength = 6_000
let activePlayer: HTMLAudioElement | undefined

export function activateScriptVideoAudio(event: Event) {
  const player = event.currentTarget as HTMLAudioElement
  if (activePlayer !== player) activePlayer?.pause()
  activePlayer = player
}

export function deactivateScriptVideoAudio(event: Event) {
  if (activePlayer === event.currentTarget) activePlayer = undefined
}

export function useScriptVideoAudioPreview() {
  const player = ref<HTMLAudioElement>()
  let start: ReturnType<typeof setTimeout> | undefined
  let end: ReturnType<typeof setTimeout> | undefined
  let revision = 0

  function cancelAudioStart() {
    clearTimeout(start)
  }

  function stopAudioPreview() {
    revision++
    cancelAudioStart()
    clearTimeout(end)
    if (player.value === activePlayer) activePlayer = undefined
    player.value?.pause()
  }

  function scheduleAudioPreview() {
    stopAudioPreview()
    const current = revision
    start = setTimeout(() => {
      const audio = player.value
      if (!audio?.paused) return
      // Browsers can reject playback without a user gesture. The controls stay available.
      void audio.play().then(() => {
        if (current !== revision || audio !== player.value) audio.pause()
        else end = setTimeout(() => audio.pause(), sampleLength)
      }).catch(() => {})
    }, hoverDelay)
  }

  return { player, scheduleAudioPreview, cancelAudioStart, stopAudioPreview }
}
