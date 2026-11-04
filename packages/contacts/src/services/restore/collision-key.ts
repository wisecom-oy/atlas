import { is_record } from '@/services/shared/json-record';

/**
 * Identity used to detect a contact already in the target folder: trimmed, lowercased display
 * name plus sorted, lowercased email addresses. Returns undefined when a contact has neither,
 * since such a contact cannot be matched and is always restored.
 */
export function collision_key(contact: Readonly<Record<string, unknown>>): string | undefined {
  const name =
    typeof contact['displayName'] === 'string' ? contact['displayName'].trim().toLowerCase() : '';
  const emails: string[] = [];
  if (Array.isArray(contact['emailAddresses'])) {
    for (const item of contact['emailAddresses']) {
      if (is_record(item) && typeof item['address'] === 'string') {
        emails.push(item['address'].trim().toLowerCase());
      }
    }
  }
  emails.sort();
  if (name === '' && emails.length === 0) return undefined;
  return JSON.stringify([name, emails]);
}
