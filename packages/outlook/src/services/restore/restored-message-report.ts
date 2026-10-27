import type { AttachmentKindCounts, RestoredMessageReport } from '@wisecom/atlas-types';

/** Counts attachments by kind: inline parts embedded in the body versus listed file attachments. */
export function count_attachment_kinds(
  attachments: readonly { readonly is_inline: boolean }[],
): AttachmentKindCounts {
  const inline = attachments.filter((a) => a.is_inline).length;
  return { file: attachments.length - inline, inline };
}

/**
 * The warning for a message that landed with fewer attachments than its snapshot holds, or
 * undefined when every expected attachment was uploaded. Failed uploads already appear in
 * `errors`; this also catches attachments skipped without an error, such as legacy JSON entries
 * whose attachment content was never stored (issue #475).
 */
export function attachment_shortfall_warning(report: RestoredMessageReport): string | undefined {
  const expected = report.attachments_expected.file + report.attachments_expected.inline;
  const uploaded = report.attachments_uploaded.file + report.attachments_uploaded.inline;
  if (uploaded >= expected) return undefined;
  return `${report.object_id}: ${uploaded} of ${expected} attachments restored`;
}
