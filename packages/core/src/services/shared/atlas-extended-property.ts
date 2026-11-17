/**
 * Named MAPI properties Atlas writes on items it restores, so a repeated restore recognises its
 * own earlier output. Every workload shares one property set so the tags never collide with
 * another application's properties.
 */
const ATLAS_PROPERTY_SET = 'String {6f1d5a7e-3c2b-4f8e-9a41-0b7c2d9e5f13} Name';

/** The Graph single-value extended property id of the Atlas property `name`. */
export function atlas_property_id(name: string): string {
  return `${ATLAS_PROPERTY_SET} ${name}`;
}

/** The string value of one single-value extended property, or undefined when the item lacks it. */
export function extended_property_value(
  item: Readonly<Record<string, unknown>>,
  property_id: string,
): string | undefined {
  const props = item['singleValueExtendedProperties'];
  if (!Array.isArray(props)) return undefined;
  for (const prop of props as unknown[]) {
    if (typeof prop !== 'object' || prop === null) continue;
    const record = prop as Readonly<Record<string, unknown>>;
    if (record['id'] !== property_id) continue;
    return typeof record['value'] === 'string' ? record['value'] : undefined;
  }
  return undefined;
}

/** The URL-encoded `$expand` clause that returns only the given extended properties. */
export function extended_properties_expand(property_ids: readonly string[]): string {
  const filter = encodeURIComponent(property_ids.map((id) => `id eq '${id}'`).join(' or '));
  return `singleValueExtendedProperties($filter=${filter})`;
}
