<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { EDGES, NODES, STEPS, type NodeId } from './data-journey-steps';

const TOUR_MS = 9000;
const LAP_MS = 1600;
const VIEW_W = 900;
const PATH_SAMPLES = 24;
/** Two packets per edge, the second half a lap ahead. */
const PACKET_OFFSETS = [0, LAP_MS / 2];

const step = ref(0);
const playing = ref(false);
const motion = ref(false);
const scale = ref(1);
const stage = ref<HTMLElement>();
const back = ref<SVGSVGElement>();
const packet_layer = ref<HTMLElement>();
let timer: ReturnType<typeof setInterval> | undefined;
let animations: Animation[] = [];
let resize_observer: ResizeObserver | undefined;
let visibility_observer: IntersectionObserver | undefined;
let in_view = true;

const current = computed(() => STEPS[step.value]);
const active_nodes = computed(() => new Set<NodeId>(current.value.nodes));
const active_edges = computed(() => new Set(current.value.edges.map((e) => e.id)));

function go(i: number): void {
  step.value = (i + STEPS.length) % STEPS.length;
}

function stop_tour(): void {
  clearInterval(timer);
  playing.value = false;
}

function toggle_tour(): void {
  if (playing.value) return stop_tour();
  playing.value = true;
  timer = setInterval(() => go(step.value + 1), TOUR_MS);
}

/** Manual navigation ends the tour so the reader stays on the step they picked. */
function pick(i: number): void {
  stop_tour();
  go(i);
}

function pick_node(id: NodeId): void {
  pick(STEPS.findIndex((s) => s.nodes.includes(id)));
}

/** Samples an edge path into translate keyframes, in viewBox units. */
function path_keyframes(edge_id: string): Keyframe[] {
  const path = back.value!.querySelector<SVGPathElement>(`path[data-edge="${edge_id}"]`)!;
  const length = path.getTotalLength();
  return Array.from({ length: PATH_SAMPLES + 1 }, (_, i) => {
    const point = path.getPointAtLength((length * i) / PATH_SAMPLES);
    return { transform: `translate(${point.x}px, ${point.y}px)` };
  });
}

/**
 * Packets are HTML elements animated on transform only, so the compositor moves them and the
 * SVG is never repainted per frame. SMIL animateMotion repainted the whole diagram every frame.
 */
function start_packets(): void {
  animations.forEach((a) => a.cancel());
  animations = [];
  for (const el of Array.from(packet_layer.value?.children ?? []) as HTMLElement[]) {
    const animation = el.animate(path_keyframes(el.dataset.edge!), {
      duration: LAP_MS,
      delay: -Number(el.dataset.offset),
      iterations: Infinity,
      direction: el.dataset.reverse === 'true' ? 'reverse' : 'normal',
    });
    if (!in_view) animation.pause();
    animations.push(animation);
  }
}

watch(step, () => nextTick(start_packets));

onMounted(async () => {
  motion.value = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  resize_observer = new ResizeObserver(
    ([entry]) => (scale.value = entry.contentRect.width / VIEW_W),
  );
  resize_observer.observe(stage.value!);
  // Off-screen, the packets stop instead of animating unseen.
  visibility_observer = new IntersectionObserver(([entry]) => {
    in_view = entry.isIntersecting;
    animations.forEach((a) => (in_view ? a.play() : a.pause()));
  });
  visibility_observer.observe(stage.value!);
  await nextTick();
  start_packets();
});
onBeforeUnmount(() => {
  clearInterval(timer);
  animations.forEach((a) => a.cancel());
  resize_observer?.disconnect();
  visibility_observer?.disconnect();
});
</script>

<template>
  <figure class="wc-journey">
    <div class="canvas">
      <!-- Three layers: edges, then moving packets, then boxes, so packets pass under the boxes. -->
      <div ref="stage" class="stage">
        <svg
          ref="back"
          viewBox="0 0 900 340"
          role="img"
          :aria-label="`Diagram, step ${step + 1} of ${STEPS.length}: ${current.title}`"
        >
          <rect class="bucket" x="752" y="34" width="136" height="290" />
          <text class="bucket-label" x="820" y="62">YOUR S3 BUCKET</text>
          <path
            v-for="(d, id) in EDGES"
            :key="id"
            :d="d"
            :data-edge="id"
            class="edge"
            :class="{ on: active_edges.has(id) }"
          />
        </svg>

        <div
          v-if="motion"
          ref="packet_layer"
          class="packets"
          :style="{ transform: `scale(${scale})` }"
          aria-hidden="true"
        >
          <template v-for="e in current.edges" :key="`${step}-${e.id}`">
            <i
              v-for="offset in PACKET_OFFSETS"
              :key="offset"
              :class="e.kind"
              :data-edge="e.id"
              :data-offset="offset"
              :data-reverse="Boolean(e.reverse)"
            />
          </template>
        </div>

        <svg class="front" viewBox="0 0 900 340">
          <g
            v-for="n in NODES"
            :key="n.id"
            class="node"
            :class="{ on: active_nodes.has(n.id) }"
            tabindex="0"
            role="button"
            :aria-label="`${n.title}: show its step`"
            @click="pick_node(n.id)"
            @keydown.enter.prevent="pick_node(n.id)"
            @keydown.space.prevent="pick_node(n.id)"
          >
            <rect :x="n.x - n.w / 2" :y="n.y - 25" :width="n.w" height="50" />
            <text class="title" :x="n.x" :y="n.y - 3">{{ n.title }}</text>
            <text class="sub" :x="n.x" :y="n.y + 13">{{ n.sub }}</text>
          </g>
        </svg>
      </div>
    </div>

    <div class="legend" aria-hidden="true">
      <span><i class="plain" />Readable content</span>
      <span><i class="sealed" />Sealed content</span>
      <span><i class="key" />Key</span>
    </div>

    <figcaption aria-live="polite">
      <p class="count">STEP {{ step + 1 }} OF {{ STEPS.length }}</p>
      <h3>{{ current.title }}</h3>
      <p>{{ current.text }}</p>
      <p class="detail">{{ current.detail }}</p>
    </figcaption>

    <nav class="controls" aria-label="Diagram steps">
      <button type="button" @click="pick(step - 1)">Back</button>
      <button
        v-for="(s, i) in STEPS"
        :key="s.title"
        type="button"
        class="dot"
        :class="{ on: i === step }"
        :aria-label="`Step ${i + 1}: ${s.title}`"
        :aria-current="i === step ? 'step' : undefined"
        @click="pick(i)"
      >
        {{ i + 1 }}
      </button>
      <button type="button" @click="pick(step + 1)">Next</button>
      <button type="button" class="tour" @click="toggle_tour">
        {{ playing ? 'Pause' : 'Play tour' }}
      </button>
    </nav>
  </figure>
</template>

<style scoped>
.wc-journey {
  margin: 24px 0;
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
}
/* Below ~640px the labels get too small to read, so the diagram scrolls sideways instead of shrinking. */
.canvas {
  overflow-x: auto;
}
.stage {
  position: relative;
  min-width: 640px;
}
svg {
  display: block;
  width: 100%;
  height: auto;
  font-family: var(--vp-font-family-base);
}
.front {
  position: absolute;
  inset: 0;
}
/* Drawn in viewBox units and scaled to the stage, so packets keep their size relative to the boxes. */
.packets {
  position: absolute;
  top: 0;
  left: 0;
  width: 900px;
  height: 340px;
  transform-origin: 0 0;
  pointer-events: none;
}
.packets i {
  position: absolute;
  top: -6px;
  left: -6px;
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border: 1.5px solid var(--vp-c-text-1);
  background: var(--vp-c-bg);
}
.packets i.sealed {
  background: var(--vp-c-text-1);
}
.packets i.key {
  top: -5px;
  left: -5px;
  width: 10px;
  height: 10px;
  border: none;
  border-radius: 50%;
  background: var(--vp-c-text-2);
}
.bucket {
  fill: var(--vp-c-bg-alt);
  stroke: var(--vp-c-divider);
  stroke-dasharray: 4 4;
}
.bucket-label {
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-anchor: middle;
  fill: var(--vp-c-text-3);
}
.edge {
  fill: none;
  stroke: var(--vp-c-divider);
  stroke-width: 1.5;
  transition: stroke 0.3s;
}
.edge.on {
  stroke: var(--vp-c-text-2);
}
.node {
  cursor: pointer;
  opacity: 0.4;
  transition: opacity 0.3s;
}
.node.on,
.node:hover,
.node:focus-visible {
  opacity: 1;
}
.node:focus-visible {
  outline: none;
}
.node rect {
  fill: var(--vp-c-bg);
  stroke: var(--vp-c-border);
}
.node.on rect {
  fill: var(--vp-c-bg-soft);
  stroke: var(--vp-c-text-1);
}
.node:focus-visible rect {
  stroke-width: 2;
}
.node text {
  text-anchor: middle;
}
.node .title {
  font-size: 13px;
  font-weight: 600;
  fill: var(--vp-c-text-1);
}
.node .sub {
  font-family: var(--vp-font-family-mono);
  font-size: 10px;
  fill: var(--vp-c-text-2);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--vp-c-text-2);
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--vp-c-text-1);
}
.legend i.sealed {
  background: var(--vp-c-text-1);
}
.legend i.key {
  border: none;
  border-radius: 50%;
  background: var(--vp-c-text-2);
}
figcaption {
  min-height: 210px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--vp-c-divider);
}
figcaption .count {
  margin: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--vp-c-text-3);
}
figcaption h3 {
  margin: 4px 0 8px;
  padding: 0;
  border: none;
}
figcaption p {
  margin: 0 0 10px;
}
figcaption .detail {
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.controls button {
  min-width: 34px;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--vp-c-border);
  border-radius: 2px;
  font-size: 13px;
  color: var(--vp-c-text-1);
  transition: border-color 0.2s;
}
.controls button:hover {
  border-color: var(--vp-c-text-1);
}
.controls .dot {
  padding: 0;
  font-family: var(--vp-font-family-mono);
}
.controls .dot.on {
  background: var(--vp-c-text-1);
  border-color: var(--vp-c-text-1);
  color: var(--vp-c-bg);
}
.controls .tour {
  margin-left: auto;
}
</style>
