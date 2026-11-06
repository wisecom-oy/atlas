/** Seeded PRNG and deterministic id helpers for the scale rig fixture. */

/**
 * FNV-1a 32-bit hash of the joined parts. Derives independent sub-seeds from one root seed.
 * @param {...(string|number)} parts
 * @returns {number} unsigned 32-bit seed
 */
export function derive_seed(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * mulberry32 generator with typed helpers. Same seed, same sequence.
 * @param {number} seed
 */
export function create_rng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    bytes: (n) => {
      const out = Buffer.alloc(n);
      for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
      return out;
    },
  };
}

/**
 * Synthetic GUID in 8-4-4-4-12 form, deterministic from a kind tag and index.
 * @param {number} kind small integer namespace (team, user, item)
 * @param {number} n index within the namespace
 */
export function synthetic_guid(kind, n) {
  const tail = n.toString(16).padStart(12, '0');
  return `0000000${kind}-0000-4000-8000-${tail}`;
}
