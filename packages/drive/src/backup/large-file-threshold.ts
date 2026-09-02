/**
 * Files and historical versions at or above this size use the chunked staging + multipart
 * pipeline instead of being buffered whole.
 *
 * The buffered path below this holds the plaintext and its ciphertext copy at once, so the
 * threshold is the per-file memory ceiling doubled. 64 MB keeps document- and photo-sized content
 * on the single-PUT path while capping that ceiling at ~128 MB; the streaming path costs a staging
 * copy per file, which is why this is not lower still.
 *
 * Both providers read the same value: it is a heap budget, not a service limit, so a divergence
 * would only mean one workload runs out of memory before the other.
 */
export const LARGE_FILE_THRESHOLD = 64 * 1024 * 1024;
