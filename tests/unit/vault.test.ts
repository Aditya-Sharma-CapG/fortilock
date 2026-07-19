import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Vault } from '../../src/core/vault';
import { VaultData } from '../../src/core/types';

describe('Vault Module', () => {
  let tempDir: string;
  let vaultPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fortilock-test-'));
    vaultPath = path.join(tempDir, 'vault.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const validVaultData: VaultData = {
    passwordHash: 'hash',
    passwordSalt: 'salt',
    masterKeySalt: 'mksalt',
    wrappedVaultKey: {
      iv: 'ivhex',
      authTag: 'taghex',
      ciphertext: 'cipherhex'
    },
    items: []
  };

  it('should write and read valid vault data', async () => {
    const vault = new Vault(vaultPath);
    await vault.writeVault(validVaultData);
    
    const readData = await vault.readVault();
    expect(readData).toEqual(validVaultData);
  });

  it('should atomicaly write vault using a temp file', async () => {
    const vault = new Vault(vaultPath);
    await vault.writeVault(validVaultData);
    
    // Ensure the temp file doesn't remain
    const tempPath = `${vaultPath}.tmp`;
    await expect(fs.access(tempPath)).rejects.toThrow();
  });

  it('should fail loudly on corrupted or invalid json file', async () => {
    await fs.writeFile(vaultPath, '{ invalid json', 'utf-8');
    
    const vault = new Vault(vaultPath);
    await expect(vault.readVault()).rejects.toThrow(/Failed to read vault/);
  });

  it('should fail loudly when missing required fields', async () => {
    const invalidData = { passwordHash: 'hash' }; // Missing everything else
    await fs.writeFile(vaultPath, JSON.stringify(invalidData), 'utf-8');
    
    const vault = new Vault(vaultPath);
    await expect(vault.readVault()).rejects.toThrow('Corrupted vault file: missing required fields');
  });

  it('should throw ENOENT if vault file does not exist', async () => {
    const vault = new Vault(vaultPath);
    await expect(vault.readVault()).rejects.toThrow('ENOENT');
  });
});
