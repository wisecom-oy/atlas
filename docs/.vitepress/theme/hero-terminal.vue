<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { OUTLOOK_BACKUP, type TerminalSession } from './terminal-sessions';

// Types each session's command, prints its output, pauses, clears, and moves to the next.
const props = withDefaults(defineProps<{ sessions?: TerminalSession[]; label?: string }>(), {
  sessions: () => [OUTLOOK_BACKUP],
  label: 'Example output of atlas outlook backup',
});

const index = ref(0);
const typed = ref('');
const shown = ref(0);
const done = ref(false);
// Reduced motion: no playback; the whole transcript is printed at once and scrolls.
const reduced = ref(false);
const session = computed(() => props.sessions[index.value]!);
let timer: ReturnType<typeof setTimeout> | undefined;
const body = ref<HTMLElement>();

// Output past the fixed height scrolls; keep the newest line in view, as a terminal does.
watch([typed, shown], () => nextTick(() => body.value?.scrollTo({ top: body.value.scrollHeight })));

const wait = (ms: number) => new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));

async function play(): Promise<void> {
  for (;;) {
    typed.value = '';
    shown.value = 0;
    done.value = false;
    await wait(600);
    for (const ch of session.value.command) {
      typed.value += ch;
      await wait(35);
    }
    for (const line of session.value.lines) {
      await wait(line.delay);
      shown.value++;
    }
    done.value = true;
    await wait(props.sessions.length > 1 ? 3500 : 6000);
    index.value = (index.value + 1) % props.sessions.length;
  }
}

onMounted(() => {
  // Client only, so server-rendered HTML still matches the first hydration pass.
  index.value = Math.floor(Math.random() * props.sessions.length);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    reduced.value = true;
    return;
  }
  void play();
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <figure class="wc-term" :aria-label="label">
    <div class="wc-term-bar">
      <span class="wc-term-dots"><i /><i /><i /></span>
      <span class="wc-term-title">atlas · zsh</span>
    </div>
    <pre v-if="reduced" class="wc-term-body"><template v-for="s in sessions" :key="s.command"><span class="prompt">$ </span><span>{{ s.command }}</span>
<template v-for="(line, i) in s.lines" :key="i"><span :class="line.cls">{{ line.text }}</span>
</template>
</template><span class="prompt">$ </span><span class="cursor" /></pre>
    <pre v-else ref="body" class="wc-term-body"><span class="prompt">$ </span><span>{{ typed }}</span><span v-if="shown === 0" class="cursor" />
<template v-for="(line, i) in session.lines.slice(0, shown)" :key="i"><span :class="line.cls">{{ line.text }}</span>
</template><template v-if="done"><span class="prompt">$ </span><span class="cursor" /></template></pre>
    <figcaption class="wc-term-foot">
      <span>Encrypted per tenant · Object Lock · Incremental</span>
      <a href="https://wisecom.fi/en/products/continuity">Skip the setup: Wisecom Continuity →</a>
    </figcaption>
  </figure>
</template>
