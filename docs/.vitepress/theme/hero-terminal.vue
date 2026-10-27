<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

// Mock run of `atlas outlook backup`. Line formats mirror packages/cli: Banner, KeyValueList,
// BackupProgressLineReporter, logger prefixes ([*] [+]) and ResultSummary.
type Line = { text: string; cls?: string; delay: number };

const COMMAND = 'atlas outlook backup -m user@example.com';
const LINES: Line[] = [
  { text: 'Atlas · Outlook Backup', cls: 'banner', delay: 250 },
  { text: 'Tenant:  00000000-aaaa-4bbb-8ccc-000000000000', delay: 150 },
  { text: 'Mailbox: user@example.com', delay: 0 },
  { text: '  [ok] Inbox -- 128 stored, 14 dedup', cls: 'ok', delay: 700 },
  { text: '  [ok] Sent Items -- 42 stored, 3 dedup', cls: 'ok', delay: 500 },
  { text: '  [==] Archive -- 2310 items -- up to date', cls: 'muted', delay: 400 },
  { text: '  [ok] Projects/2026 -- 61 stored, 9 dedup', cls: 'ok', delay: 500 },
  { text: '  [--] Junk Email -- 0 items -- empty', cls: 'muted', delay: 300 },
  { text: '[*] Resuming incremental sync from saved delta state', cls: 'info', delay: 350 },
  { text: '231 stored | 26 dedup | 48 attachments | 0 errors — 9.2s', cls: 'bold', delay: 300 },
  { text: '[+] Snapshot snap-1761555312000-a3f9c1 -- 2,617 objects, 1.4 GB', cls: 'ok', delay: 300 },
];

const typed = ref('');
const shown = ref(0);
const done = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

const wait = (ms: number) => new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));

async function play(): Promise<void> {
  for (;;) {
    typed.value = '';
    shown.value = 0;
    done.value = false;
    await wait(600);
    for (const ch of COMMAND) {
      typed.value += ch;
      await wait(35);
    }
    for (const line of LINES) {
      await wait(line.delay);
      shown.value++;
    }
    done.value = true;
    await wait(6000);
  }
}

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    typed.value = COMMAND;
    shown.value = LINES.length;
    done.value = true;
    return;
  }
  void play();
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <figure class="wc-term" aria-label="Example output of atlas outlook backup">
    <div class="wc-term-bar">
      <span class="wc-term-dots"><i /><i /><i /></span>
      <span class="wc-term-title">atlas · zsh</span>
    </div>
    <pre class="wc-term-body"><span class="prompt">$ </span><span>{{ typed }}</span><span v-if="shown === 0" class="cursor" />
<template v-for="(line, i) in LINES.slice(0, shown)" :key="i"><span :class="line.cls">{{ line.text }}</span>
</template><template v-if="done"><span class="prompt">$ </span><span class="cursor" /></template></pre>
    <figcaption class="wc-term-foot">
      <span>Encrypted per tenant · Object Lock · Incremental</span>
      <a href="https://wisecom.fi/en/products/continuity">Skip the setup: Wisecom Continuity →</a>
    </figcaption>
  </figure>
</template>
