import { changeMasterPassword, deriveMasterKey, verifyPassword, generateVaultKey, wrapVaultKey, unwrapVaultKey, hashPassword } from '../../src/core/crypto';
import { VaultData } from '../../src/core/types';
import crypto from 'node:crypto';

describe('Unit Tests: Master Password Change', () => {
  it('should correctly re-wrap the vault key and update authentication fields', async () => {
    // 1. Setup initial vault state
    const oldPassword = 'old-password-123';
    const vaultKey = generateVaultKey();
    
    // Initial fields (simulate what setup does)
    const oldPasswordSalt = crypto.randomBytes(32);
    const oldMasterKeySalt = crypto.randomBytes(32);
    const oldHashBuf = await hashPassword(oldPassword, oldPasswordSalt);
    const oldMasterKey = await deriveMasterKey(oldPassword, oldMasterKeySalt);
    const oldWrappedVaultKey = wrapVaultKey(oldMasterKey, vaultKey);

    const vaultData: VaultData = {
      passwordHash: oldHashBuf.toString('hex'),
      passwordSalt: oldPasswordSalt.toString('hex'),
      masterKeySalt: oldMasterKeySalt.toString('hex'),
      wrappedVaultKey: oldWrappedVaultKey,
      items: [{ id: 'item1', type: 'file', originalPath: 'test.txt', alkPath: 'test.alk', status: 'locked' }]
    };

    // 2. Perform password change
    const newPassword = 'new-password-456';
    const newFields = await changeMasterPassword(newPassword, vaultKey);

    // Update vault data
    Object.assign(vaultData, newFields);

    // 3. Verify old password no longer works
    const oldPassVerifies = await verifyPassword(oldPassword, Buffer.from(vaultData.passwordHash, 'hex'), Buffer.from(vaultData.passwordSalt, 'hex'));
    expect(oldPassVerifies).toBe(false);

    // 4. Verify new password works
    const newPassVerifies = await verifyPassword(newPassword, Buffer.from(vaultData.passwordHash, 'hex'), Buffer.from(vaultData.passwordSalt, 'hex'));
    expect(newPassVerifies).toBe(true);

    // 5. Verify vault key unwraps correctly with new master key
    const newMasterKey = await deriveMasterKey(newPassword, Buffer.from(vaultData.masterKeySalt, 'hex'));
    const unwrappedVaultKey = unwrapVaultKey(newMasterKey, vaultData.wrappedVaultKey);
    
    expect(crypto.timingSafeEqual(unwrappedVaultKey, vaultKey)).toBe(true);
    
    // 6. Verify existing items were not touched
    expect(vaultData.items).toHaveLength(1);
    expect(vaultData.items[0]!.id).toBe('item1');
  });
});
