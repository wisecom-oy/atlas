export interface ContactFolder {
  readonly folder_id: string;
  readonly display_name: string;
  readonly is_default: boolean;
  readonly parent_folder_id?: string;
}

export interface ContactChange {
  readonly contact_id: string;
  readonly payload?: Record<string, unknown>;
  readonly removed: boolean;
}

export type ContactManifestEntry =
  | {
      readonly contact_id: string;
      readonly folder_id: string;
      readonly change_type: 'deleted';
    }
  | {
      readonly contact_id: string;
      readonly folder_id: string;
      readonly change_type: 'stored';
      readonly storage_key: string;
      readonly checksum: string;
      readonly size_bytes: number;
      readonly photo?: {
        readonly storage_key: string;
        readonly checksum: string;
        readonly size_bytes: number;
      };
    };

export type StoredContactEntry = Extract<ContactManifestEntry, { change_type: 'stored' }>;
