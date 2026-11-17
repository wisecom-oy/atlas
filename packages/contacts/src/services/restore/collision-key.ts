import { is_record } from '@/services/shared/json-record';

const PHONE_FIELDS = ['businessPhones', 'homePhones'] as const;

/** Trimmed, lowercased string field, or '' when absent. */
function text_field(contact: Readonly<Record<string, unknown>>, field: string): string {
  const value = contact[field];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Sorted, lowercased email addresses. */
function email_addresses(contact: Readonly<Record<string, unknown>>): string[] {
  const emails: string[] = [];
  if (!Array.isArray(contact['emailAddresses'])) return emails;
  for (const item of contact['emailAddresses'] as unknown[]) {
    if (is_record(item) && typeof item['address'] === 'string') {
      const address = item['address'].trim().toLowerCase();
      if (address !== '') emails.push(address);
    }
  }
  return emails.sort();
}

/** Sorted phone numbers from every phone field, with whitespace removed. */
function phone_numbers(contact: Readonly<Record<string, unknown>>): string[] {
  const phones: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const phone = value.replace(/\s+/g, '');
    if (phone !== '') phones.push(phone);
  };
  for (const field of PHONE_FIELDS) {
    const values = contact[field];
    if (Array.isArray(values)) (values as unknown[]).forEach(add);
  }
  add(contact['mobilePhone']);
  return phones.sort();
}

/**
 * Content identity used to recognise a contact Atlas did not create but that already holds the
 * same person: display name, email addresses, phone numbers and company, normalised. Returns
 * undefined when every one of them is empty, since such a contact cannot be told apart from another.
 */
export function collision_key(contact: Readonly<Record<string, unknown>>): string | undefined {
  const name = text_field(contact, 'displayName');
  const emails = email_addresses(contact);
  const phones = phone_numbers(contact);
  const company = text_field(contact, 'companyName');
  if (name === '' && emails.length === 0 && phones.length === 0 && company === '') return undefined;
  return JSON.stringify([name, emails, phones, company]);
}
