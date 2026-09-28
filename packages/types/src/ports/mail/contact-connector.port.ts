import type { ContactChange, ContactFolder } from '@/domain/contact';

export interface ContactConnector {
  list_contact_folders(tenant_id: string, owner_id: string): Promise<ContactFolder[]>;
  fetch_contact_delta(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    delta_link: string | undefined,
    on_page: (changes: ContactChange[]) => Promise<boolean>,
  ): Promise<{ delta_link?: string; reset: boolean }>;
  fetch_contact(
    tenant_id: string,
    owner_id: string,
    contact_id: string,
  ): Promise<Record<string, unknown>>;
  fetch_contact_photo(
    tenant_id: string,
    owner_id: string,
    contact_id: string,
  ): Promise<Buffer | undefined>;
  create_contact_folder(
    tenant_id: string,
    owner_id: string,
    name: string,
    parent_folder_id?: string,
  ): Promise<string>;
  list_contacts(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
  ): Promise<Record<string, unknown>[]>;
  create_contact(
    tenant_id: string,
    owner_id: string,
    folder_id: string,
    data: Record<string, unknown>,
  ): Promise<string>;
  update_contact(
    tenant_id: string,
    owner_id: string,
    contact_id: string,
    data: Record<string, unknown>,
  ): Promise<void>;
  set_contact_photo(
    tenant_id: string,
    owner_id: string,
    contact_id: string,
    data: Buffer,
  ): Promise<void>;
}
