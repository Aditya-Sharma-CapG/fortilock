import fs from 'node:fs/promises';
import { VaultData } from './types';

export class Vault {
  private readonly vaultPath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
  }

  async writeVault(data: VaultData): Promise<void> {
    const tempPath = `${this.vaultPath}.tmp`;
    const json = JSON.stringify(data, null, 2);
    
    // Write to temp file first
    await fs.writeFile(tempPath, json, 'utf-8');
    
    // Atomic rename
    await fs.rename(tempPath, this.vaultPath);
  }

  async readVault(): Promise<VaultData> {
    try {
      const data = await fs.readFile(this.vaultPath, 'utf-8');
      const parsed = JSON.parse(data);
      
      // Basic validation
      if (!parsed?.passwordHash || !parsed?.passwordSalt || !parsed?.masterKeySalt || !parsed?.wrappedVaultKey || !Array.isArray(parsed?.items)) {
        throw new Error('Corrupted vault file: missing required fields');
      }

      // recoveryKeys is optional but if present must be an array
      if (parsed.recoveryKeys && !Array.isArray(parsed.recoveryKeys)) {
        throw new Error('Corrupted vault file: invalid recovery keys');
      }
      
      return parsed as VaultData;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw err;
      }
      throw new Error(`Failed to read vault: ${err.message}`);
    }
  }
}
