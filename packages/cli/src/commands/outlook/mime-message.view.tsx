import { Box, Text } from 'ink';
import { html_to_text } from '@wisecom/atlas-core';
import { parse_mime_message, type ParsedMimeMessage } from '@wisecom/atlas-outlook';
import { format_bytes } from '@/command-formatters';
import { KeyValueList, type KeyValueItem } from '@/ui/components/key-value-list';
import { render_static_view } from '@/ui/render';

/** Parses a stored RFC 5322 blob and prints its headers, body, and embedded attachments. */
export async function print_mime_message(raw: Buffer): Promise<void> {
  const parsed = await parse_mime_message(raw);
  const cc = parsed.cc.map(format_address).join(', ');
  const items: KeyValueItem[] = [
    { label: 'Subject', value: parsed.subject },
    { label: 'From', value: format_address(parsed.from) },
    { label: 'To', value: parsed.to.map(format_address).join(', ') },
  ];
  if (cc) items.push({ label: 'Cc', value: cc });
  items.push({ label: 'Date', value: parsed.date ?? '' });

  await render_static_view(
    <Box flexDirection="column">
      <KeyValueList items={items} />
      <Text dimColor>{'-'.repeat(60)}</Text>
      <Text>{extract_mime_body(parsed)}</Text>
    </Box>,
  );

  await print_mime_attachments(parsed.attachments);
}

/** Lists the attachments embedded in the MIME blob (name, MIME type, size). */
async function print_mime_attachments(
  attachments: ParsedMimeMessage['attachments'],
): Promise<void> {
  if (attachments.length === 0) return;

  await render_static_view(
    <Box flexDirection="column">
      <Text dimColor>{'-'.repeat(60)}</Text>
      <Text bold>{`Attachments (${attachments.length}):`}</Text>
      {attachments.map((a, i) => (
        <Text key={i}>
          {`  ${i + 1}. ${a.name}  `}
          <Text dimColor>{a.content_type}</Text>
          {`  ${format_bytes(a.content.length)}`}
          {a.is_inline ? <Text dimColor>{'  (inline)'}</Text> : undefined}
        </Text>
      ))}
    </Box>,
  );
}

/** Prefers the decoded text/plain part, falling back to the HTML part stripped to text. */
function extract_mime_body(parsed: ParsedMimeMessage): string {
  if (parsed.text) return parsed.text;
  if (parsed.html) return html_to_text(parsed.html);
  return '(no body)';
}

/** Formats a parsed MIME address as `Name <addr>`, or just the address. */
function format_address(addr?: { readonly name: string; readonly address: string }): string {
  if (!addr) return '(unknown)';
  return addr.name && addr.name !== addr.address
    ? `${addr.name} <${addr.address}>`
    : addr.address || '(unknown)';
}
