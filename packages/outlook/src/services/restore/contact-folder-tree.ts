import type { ContactConnector, ContactFolder } from '@wisecom/atlas-types';

/** Validates the source hierarchy and returns parents before children. */
export function order_contact_folders(folders: ContactFolder[]): ContactFolder[] {
  const root = folders.find((folder) => folder.is_default);
  if (!root) throw new Error('Contact snapshot has no default Contacts folder');
  const ids = new Set(folders.map((folder) => folder.folder_id));
  if (ids.size !== folders.length)
    throw new Error('Contact snapshot contains duplicate folder IDs');
  const children = new Map<string, ContactFolder[]>();
  for (const folder of folders) {
    if (folder.is_default) continue;
    const parent_id = folder.parent_folder_id ?? root.folder_id;
    if (!ids.has(parent_id))
      throw new Error('Contact snapshot references an unknown parent folder');
    const siblings = children.get(parent_id) ?? [];
    siblings.push(folder);
    children.set(parent_id, siblings);
  }
  const ordered = [root];
  for (let i = 0; i < ordered.length; i++) {
    for (const child of children.get(ordered[i]!.folder_id) ?? []) ordered.push(child);
  }
  if (ordered.length !== folders.length)
    throw new Error('Contact snapshot contains a folder cycle');
  return ordered;
}

/** Finds or creates one target folder beneath the mapped parent. */
export async function resolve_target_contact_folder(
  connector: ContactConnector,
  tenant_id: string,
  target_id: string,
  source: ContactFolder,
  available: ContactFolder[],
  parent_target_id?: string,
): Promise<string> {
  const root = available.find((folder) => folder.is_default);
  if (!root) throw new Error('Target mailbox has no default Contacts folder');
  if (source.is_default) return root.folder_id;
  const parent_id = parent_target_id ?? root.folder_id;
  const target = available.find(
    (folder) =>
      !folder.is_default &&
      folder.display_name === source.display_name &&
      (folder.parent_folder_id ?? root.folder_id) === parent_id,
  );
  if (target) return target.folder_id;
  const folder_id = await connector.create_contact_folder(
    tenant_id,
    target_id,
    source.display_name,
    parent_id,
  );
  available.push({
    folder_id,
    display_name: source.display_name,
    is_default: false,
    parent_folder_id: parent_id,
  });
  return folder_id;
}
