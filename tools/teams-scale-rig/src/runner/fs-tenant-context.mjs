/**
 * Tenant context factory over FsObjectStorage. Mirrors packages/s3 DefaultTenantContextFactory:
 * the wrapped DEK lives at `_meta/dek.enc`, bootstrapped with a conditional create, and the
 * crypto surface is the same EnvelopeKeyService calls. Copied rather than imported because the
 * S3 factory and its build_context are not exported from the s3 package.
 */
import path from 'node:path';
import { EnvelopeKeyService } from '@wisecom/atlas-core';
import { NotFoundError } from '@wisecom/atlas-types';
import { FsObjectStorage, storage_error } from './fs-object-storage.mjs';

const DEK_META_KEY = '_meta/dek.enc';

/**
 * @param {{root: string, passphrase: string}} options root directory and encryption passphrase
 * @returns {{create, create_readonly, create_storage_only}} TenantContextFactory shape
 */
export function create_fs_tenant_context_factory({ root, passphrase }) {
  const storage_for = (tenant_id) =>
    new FsObjectStorage(path.join(root, encodeURIComponent(tenant_id)));

  return {
    async create_storage_only(tenant_id) {
      return { tenant_id, storage: storage_for(tenant_id) };
    },

    async create(tenant_id) {
      const storage = storage_for(tenant_id);
      const key_service = new EnvelopeKeyService(passphrase);
      const dek = await load_or_create_dek(storage, key_service, tenant_id);
      return build_context(tenant_id, storage, key_service, dek);
    },

    async create_readonly(tenant_id) {
      const storage = storage_for(tenant_id);
      const key_service = new EnvelopeKeyService(passphrase);
      if (!(await storage.exists(DEK_META_KEY))) {
        key_service.destroy();
        throw new NotFoundError(`No backups found for tenant ${tenant_id}`);
      }
      const dek = await key_service.unwrap_dek(await storage.get(DEK_META_KEY), tenant_id);
      return build_context(tenant_id, storage, key_service, dek);
    },
  };
}

/** Reads the stored DEK, or creates one exclusively when the tenant has none yet. */
async function load_or_create_dek(storage, key_service, tenant_id) {
  if (await storage.exists(DEK_META_KEY)) {
    return key_service.unwrap_dek(await storage.get(DEK_META_KEY), tenant_id);
  }
  const dek = key_service.generate_dek();
  try {
    const wrapped = await key_service.wrap_dek(dek, tenant_id);
    await storage.put(DEK_META_KEY, wrapped, undefined, undefined, undefined, true);
  } catch (err) {
    if (err.name !== 'PreconditionFailed') throw err;
  }
  return key_service.unwrap_dek(await storage.get(DEK_META_KEY), tenant_id);
}

/** Crypto surface over one DEK; identical to packages/s3 build_context. */
function build_context(tenant_id, storage, key_service, dek) {
  let naming_key = key_service.derive_naming_key(dek);
  return {
    tenant_id,
    storage,
    encrypt: (data, storage_key) => key_service.encrypt(data, dek, storage_key),
    decrypt: (data, storage_key) => key_service.decrypt(data, dek, storage_key),
    create_cipher: (scope_key) => key_service.create_encrypt_cipher(dek, scope_key),
    create_decipher: (iv, auth_tag, scope_key, header) =>
      key_service.create_decrypt_decipher(dek, iv, auth_tag, scope_key, header),
    create_content_hmac: () => {
      if (!naming_key)
        throw storage_error('Error', 'Cannot name content: the tenant context was destroyed');
      return key_service.create_content_hmac(naming_key);
    },
    destroy: () => {
      key_service.destroy();
      naming_key?.fill(0);
      naming_key = undefined;
    },
  };
}
