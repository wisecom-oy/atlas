import {
  atlas_property_id,
  extended_property_value,
} from '@wisecom/atlas-core/services/shared/atlas-extended-property';

/**
 * Single-value extended property that tags a contact Atlas restored with the id of the contact it
 * was restored from, so a repeated restore recognises its own earlier output.
 */
export const SOURCE_CONTACT_PROPERTY_ID = atlas_property_id('AtlasSourceContactId');

/** The source contact id a contact was restored from, or undefined when Atlas did not create it. */
export function source_tag_of(contact: Readonly<Record<string, unknown>>): string | undefined {
  return extended_property_value(contact, SOURCE_CONTACT_PROPERTY_ID);
}

/** The extended property that tags a restored contact with its source contact id. */
export function source_tag_property(source_contact_id: string): Record<string, string> {
  return { id: SOURCE_CONTACT_PROPERTY_ID, value: source_contact_id };
}
