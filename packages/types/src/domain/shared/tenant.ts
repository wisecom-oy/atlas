export interface Tenant {
  readonly id: string;
  readonly display_name: string;
  readonly primary_domain: string;
  readonly client_id: string;
  readonly client_secret: string;
}
