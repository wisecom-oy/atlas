/**
 * Content faults: a well-formed transport carrying a wrong answer.
 *
 * Only JSON success responses up to 4 MiB are touched. The body is buffered,
 * decoded (gzip, deflate, br), mutated, and sent identity-encoded with a
 * corrected content-length. When a mutation cannot apply (wrong type, too
 * large, not parseable, nothing to mutate) the reason is recorded as
 * `fault.skipped` and the original bytes are forwarded unmodified, so a
 * skipped fault never changes what the client receives.
 *
 * Choices that need randomness (which items, how many) come from the fault's
 * recorded sub-seed, so a replay mutates the same items.
 */
import { decode_content, is_json_content_type } from '../body-encoding.mjs';
import { send_response } from '../exchange.mjs';
import { create_rng, rng_guid } from '../seeded-random.mjs';
import { client_response_headers } from '../upstream-forwarder.mjs';
import { buffer_body, send_buffered_then_rest } from './response-streaming.mjs';

/** Fault ids implemented here. */
export const MUTATION_FAULTS = new Set([
  'malformed_json',
  'empty_body_200',
  'duplicate_items',
  'shuffle_items',
  'drop_next_link',
  'batch_inner_429',
]);

/** Indicates a mutation that does not apply to this response. */
class NotApplicable extends Error {}

/** Parses JSON or reports why the mutation cannot apply. */
function parse_json(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new NotApplicable('body is not parseable JSON');
  }
}

/** Returns the top-level `value` array or reports its absence. */
function value_array(doc, min_length) {
  if (!Array.isArray(doc?.value)) throw new NotApplicable('no top-level value array');
  if (doc.value.length < min_length)
    throw new NotApplicable(`value array has fewer than ${min_length} items`);
  return doc.value;
}

/** The TooManyRequests body a throttled $batch sub-response carries. */
function inner_throttle_body(rng) {
  return {
    error: {
      code: 'TooManyRequests',
      message: 'Please retry again later.',
      innerError: {
        date: new Date().toISOString().replace(/\.\d+Z$/, ''),
        'request-id': rng_guid(rng),
        'client-request-id': rng_guid(rng),
      },
    },
  };
}

/** Each mutation: (text, params, rng) -> new body text; throws NotApplicable to skip. */
const MUTATIONS = {
  malformed_json: (text, params) => {
    if (text.length < 2) throw new NotApplicable('body too short to cut');
    parse_json(text);
    return text.slice(
      0,
      Math.max(1, Math.min(text.length - 1, Math.floor(text.length * params.fraction))),
    );
  },
  empty_body_200: () => '',
  duplicate_items: (text, params, rng) => {
    const doc = parse_json(text);
    const items = value_array(doc, 1);
    for (let i = 0; i < params.count; i += 1) {
      const index = rng.int(0, items.length - 1);
      items.splice(index + 1, 0, structuredClone(items[index]));
    }
    return JSON.stringify(doc);
  },
  shuffle_items: (text, _params, rng) => {
    const doc = parse_json(text);
    doc.value = rng.shuffled(value_array(doc, 2));
    return JSON.stringify(doc);
  },
  drop_next_link: (text) => {
    const doc = parse_json(text);
    if (typeof doc?.['@odata.nextLink'] !== 'string')
      throw new NotApplicable('page has no @odata.nextLink');
    delete doc['@odata.nextLink'];
    return JSON.stringify(doc);
  },
  batch_inner_429: (text, params, rng) => {
    const doc = parse_json(text);
    if (!Array.isArray(doc?.responses) || !doc.responses.length)
      throw new NotApplicable('no $batch responses array');
    const count = rng.int(1, doc.responses.length);
    for (const index of rng.shuffled(doc.responses.map((_, i) => i)).slice(0, count)) {
      const original = doc.responses[index];
      doc.responses[index] = {
        id: original?.id,
        status: 429,
        headers: {
          'Retry-After': String(params.retry_after_s),
          'Content-Type': 'application/json',
        },
        body: inner_throttle_body(rng),
      };
    }
    return JSON.stringify(doc);
  },
};

/** Reasons a response cannot be mutated at all, before reading its body; null when it can. */
function precheck(fault_id, up_res) {
  const status = up_res.statusCode;
  if (fault_id === 'empty_body_200') return status === 200 ? null : `status ${status} is not 200`;
  if (status < 200 || status >= 300) return `status ${status} is not a success`;
  if (!is_json_content_type(up_res.headers['content-type'])) return 'content-type is not JSON';
  return null;
}

/** Decodes the buffered body to text, or reports why it cannot be. */
function decoded_text(buffered, encoding) {
  let decoded;
  try {
    decoded = decode_content(Buffer.concat(buffered.chunks), encoding);
  } catch {
    throw new NotApplicable('body does not decode');
  }
  if (!decoded) throw new NotApplicable(`unsupported content-encoding '${encoding}'`);
  return decoded.toString('utf8');
}

/** Headers for a rewritten body: identity encoding, length set by send_response. */
function rewritten_headers(up_res) {
  const headers = client_response_headers(up_res);
  for (const name of Object.keys(headers)) {
    if (['content-encoding', 'content-length', 'content-md5', 'etag'].includes(name.toLowerCase()))
      delete headers[name];
  }
  return headers;
}

/** Applies a content fault to an upstream response, or forwards it unchanged with a skip reason. */
export async function deliver_mutated(ex, up_res, body) {
  const fault = ex.fault;
  const headers = client_response_headers(up_res);
  const early_skip = precheck(fault.id, up_res);
  if (early_skip) {
    fault.skipped = early_skip;
    return send_buffered_then_rest(
      ex,
      up_res.statusCode,
      headers,
      { chunks: [], done: false },
      body,
    );
  }
  const buffered = await buffer_body(body);
  if (!buffered.done) {
    fault.skipped = 'body larger than 4 MiB';
    return send_buffered_then_rest(ex, up_res.statusCode, headers, buffered, body);
  }
  try {
    const text =
      fault.id === 'empty_body_200'
        ? ''
        : decoded_text(buffered, up_res.headers['content-encoding']);
    const rng = create_rng(`mutation\u0000${fault.params.sub_seed ?? ''}`);
    const mutated = MUTATIONS[fault.id](text, fault.params, rng);
    send_response(ex, up_res.statusCode, rewritten_headers(up_res), mutated);
  } catch (error) {
    if (!(error instanceof NotApplicable)) throw error;
    fault.skipped = error.message;
    await send_buffered_then_rest(ex, up_res.statusCode, headers, buffered, body);
  }
}
