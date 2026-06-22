import { injectable } from 'inversify';
import type { KeyService } from '@atlas/types';

@injectable()
export class DefaultKeyService implements KeyService {
  /** @inheritdoc */
  async encrypt(_data: Buffer): Promise<Buffer> {
    throw new Error('DefaultKeyService.encrypt not implemented');
  }

  /** @inheritdoc */
  async decrypt(_data: Buffer): Promise<Buffer> {
    throw new Error('DefaultKeyService.decrypt not implemented');
  }

  /** @inheritdoc */
  async generate_data_key(): Promise<{ plain: Buffer; encrypted: Buffer }> {
    throw new Error('DefaultKeyService.generate_data_key not implemented');
  }
}
