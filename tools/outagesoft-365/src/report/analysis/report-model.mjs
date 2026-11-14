/**
 * Assembles the report data model, the single JSON-serialisable object behind report.json,
 * report.md and the terminal summary. Pure: it takes the run header, reader statistics and the
 * results of both passes, and does no I/O.
 */
import { evaluate_verdicts } from '../verdicts/correctness-verdicts.mjs';
import { create_first_pass, create_second_pass } from './report-passes.mjs';
import { build_observations, build_warnings } from './report-observations.mjs';

export const REPORT_SCHEMA = 1;

const RETRY_CAVEAT_WITH_BODY =
  'A re-request of the same URL (same method and full URL, compared by url_key) is inferred to be a retry. Non-GET requests are also matched by a digest of the request body, so two different POSTs to one URL, such as two $batch calls, are kept apart and a re-sent write with the same body is grouped with the first.';
const RETRY_CAVEAT_URL_ONLY =
  'A re-request of the same URL (same method and full URL, compared by url_key) is inferred to be a retry. This journal records no request body digest for some non-GET requests, so two different POSTs to one URL, such as two $batch calls, look like a retry of each other.';

const CAVEATS = [
  'Atlas times out by racing a promise rather than aborting the request, so a client timeout usually shows as a new attempt arriving while the previous one is still open, not as `client_closed`.',
  'Gaps are measured from the end of the faulted exchange as the relay saw it to the arrival of the next attempt. Retry-After counts as honoured when the gap is at least the advised wait minus the stated tolerance.',
  'Latency percentiles come from a histogram that is exact below one second and within 1 % above it.',
  'Fault categories come from the journal. Older journals without them fall back to a table in the report code, marked `*`; ids it does not know are reported as `unknown`.',
  'Retry-After figures use only the header the client actually received. A `batch_inner_429` carries its Retry-After inside the sub-responses of an outer 200, so it is reported as a content fault, not as advised wait.',
];

function run_header(run_info, first, second) {
  const { run, present } = run_info;
  const totals = first.traffic.totals;
  return {
    ...run,
    run_json_present: present,
    finalised: Boolean(run.finished_at && run.child),
    journal_span_ms: totals.span_ms,
    time_zero_t: second.base_t,
  };
}

/** Builds the full report model from the run header, reader statistics and both pass results. */
export function assemble_report_model(run_info, reader, first, second) {
  const attempts = first.traffic.totals.requests;
  const facts = { run: run_info.run, reader, first, second };
  const injected = first.injection;
  return {
    report_schema: REPORT_SCHEMA,
    tool: 'outagesoft-365',
    run: run_header(run_info, first, second),
    input: { ...reader, ordering: second.ordering },
    warnings: build_warnings(run_info, reader, attempts, second.ordering),
    observations: build_observations(second),
    verdicts: evaluate_verdicts(facts),
    requested: first.traffic,
    injected: { ...injected, injection_rate: attempts ? injected.applied_total / attempts : 0 },
    timeline: second.timeline,
    response: {
      chains: second.chains,
      relations: second.relations,
      identities: second.identities,
    },
    outages: second.windows,
    compare: first.graph_tap,
    caveats: [
      reader.non_get_with_body_key < reader.non_get
        ? RETRY_CAVEAT_URL_ONLY
        : RETRY_CAVEAT_WITH_BODY,
      ...CAVEATS,
    ],
  };
}

/** Builds the model from an in-memory list of attempts; used by tests and small inputs. */
export function build_report_model(run_info, attempts, reader_overrides = {}) {
  const first_pass = create_first_pass();
  for (const a of attempts) first_pass.add(a);
  const first = first_pass.finish();
  const second_pass = create_second_pass(run_info.run, first);
  for (const a of attempts) second_pass.add(a);
  const second = second_pass.finish();
  const reader = {
    journal_present: true,
    lines: attempts.length,
    blank: 0,
    attempts: attempts.length,
    relay_errors: 0,
    relay_error_samples: [],
    malformed: 0,
    malformed_reasons: {},
    missing_url_key: attempts.filter((a) => !a.has_url_key).length,
    with_identity_key: attempts.filter((a) => a.identity_key).length,
    with_cursor: attempts.filter((a) => a.cursor !== undefined).length,
    with_idempotent: attempts.filter((a) => a.idempotent !== null).length,
    with_base_key: attempts.filter((a) => a.base_key).length,
    non_get: attempts.filter((a) => a.method !== 'GET').length,
    non_get_with_body_key: attempts.filter((a) => a.method !== 'GET' && a.body_key !== undefined)
      .length,
    ...reader_overrides,
  };
  return assemble_report_model(run_info, reader, first, second);
}
