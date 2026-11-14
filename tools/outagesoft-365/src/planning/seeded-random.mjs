/**
 * Deterministic pseudo-random numbers, so `--seed` reproduces a run.
 *
 * The generator is sfc32: tiny, fast, and statistically fine for choosing
 * faults. It is not a cryptographic generator and is never used for anything
 * secret; the relay token comes from `crypto.randomBytes` instead.
 *
 * Every relayed request gets its own generator derived from the run seed, the
 * request's identity key and how many times that identity has arrived. Arrival
 * order plays no part, so a concurrent client that issues the same requests in
 * a different order still gets the same fault on the n-th attempt of each
 * request, and drawing a Retry-After for one request cannot shift the fault
 * another request receives.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Builds an sfc32 state from four 32-bit words. */
function sfc32(a, b, c, d) {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Hashes a label into four 32-bit seed words. */
function seed_words(label) {
  const digest = createHash('sha256').update(label).digest();
  return [0, 4, 8, 12].map((offset) => digest.readUInt32LE(offset));
}

/** Creates a generator for a seed label; the same label always yields the same sequence. */
export function create_rng(label) {
  const next_raw = sfc32(...seed_words(String(label)));
  // Discard the warm-up outputs: sfc32 mixes poorly for its first few draws.
  for (let i = 0; i < 12; i += 1) next_raw();

  const rng = {
    /** A float in [0, 1). */
    next: next_raw,
    /** An integer in [min, max], both inclusive. */
    int: (min, max) => min + Math.floor(next_raw() * (max - min + 1)),
    /** A float in [min, max). */
    float: (min, max) => min + next_raw() * (max - min),
    /** One element of a non-empty array. */
    pick: (items) => items[Math.floor(next_raw() * items.length)],
    /** A shuffled copy of an array (Fisher-Yates). */
    shuffled: (items) => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next_raw() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
  return rng;
}

/** Derives the generator for the `occurrence`-th arrival of a request identity under a run seed. */
export function request_rng(seed, identity_key, occurrence) {
  return create_rng(`${seed}\u0000${identity_key}\u0000${occurrence}`);
}

/** Draws a hex sub-seed, recorded in fault params so execution-time choices replay exactly. */
export function draw_sub_seed(rng) {
  return Array.from({ length: 4 }, () => rng.int(0, 0xffff).toString(16).padStart(4, '0')).join('');
}

/** Generates a fresh, printable seed for runs that did not pass `--seed`. */
export function random_seed() {
  return randomBytes(6).toString('hex');
}

/** Draws a random GUID from a generator, for synthetic request ids in error bodies. */
export function rng_guid(rng) {
  const hex = Array.from({ length: 32 }, () => rng.int(0, 15).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[rng.int(0, 3)]}${hex.slice(17, 20)}-${hex.slice(20)}`;
}
