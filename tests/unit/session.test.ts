import { SessionManager } from '../../src/core/session';
import { Vault } from '../../src/core/vault';
import { AuditLogger } from '../../src/core/audit';
import * as fileLocker from '../../src/core/fileLocker';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

jest.mock('../../src/core/vault');
jest.mock('../../src/core/audit');
jest.mock('../../src/core/fileLocker', () => ({
  lockFile: jest.fn().mockResolvedValue('fake.alk')
}));
jest.mock('../../src/core/folderLocker', () => ({
  lockFolder: jest.fn().mockResolvedValue('fake-folder.alk')
}));
jest.mock('node:fs/promises');

describe('Unit Tests: SessionManager', () => {
  let sessionManager: SessionManager;
  let mockVault: jest.Mocked<Vault>;
  let mockAudit: jest.Mocked<AuditLogger>;
  let performanceNowSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVault = {
      readVault: jest.fn(),
      writeVault: jest.fn()
    } as any;
    
    mockAudit = {
      log: jest.fn()
    } as any;

    sessionManager = new SessionManager(mockVault, mockAudit, 15); // 15 mins
    performanceNowSpy = jest.spyOn(performance, 'now').mockReturnValue(1000);
  });

  it('should create and retrieve sessions', () => {
    sessionManager.addSession('item1');
    expect(sessionManager.hasSession('item1')).toBe(true);
    expect(sessionManager.getSessionExpiry('item1')).toBe(1000 + 15 * 60 * 1000);
  });

  it('should lockAllNow and force expire sessions', async () => {
    mockVault.readVault.mockResolvedValue({
      items: [
        { id: 'item1', type: 'file', originalPath: 'test.txt', alkPath: '', status: 'unlocked' }
      ]
    } as any);
    (fs.access as jest.Mock).mockResolvedValue(undefined);

    sessionManager.setVaultKey(crypto.randomBytes(32));
    sessionManager.addSession('item1');
    
    await sessionManager.lockAllNow(); // should force expire and trigger relock
    
    expect(fileLocker.lockFile).toHaveBeenCalledWith('test.txt', expect.any(Buffer));
    expect(mockVault.writeVault).toHaveBeenCalled();
    expect(mockAudit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'session_expire',
      status: 'success'
    }));
    expect(sessionManager.hasSession('item1')).toBe(false);
  });

  it('should handle missing files gracefully during expiry', async () => {
    mockVault.readVault.mockResolvedValue({
      items: [
        { id: 'item1', type: 'file', originalPath: 'test.txt', alkPath: '', status: 'unlocked' }
      ]
    } as any);
    (fs.access as jest.Mock).mockRejectedValue(new Error('ENOENT')); // simulate missing

    sessionManager.setVaultKey(crypto.randomBytes(32));
    sessionManager.addSession('item1');
    
    await sessionManager.lockAllNow();
    
    expect(fileLocker.lockFile).not.toHaveBeenCalled();
    expect(mockVault.writeVault).toHaveBeenCalled(); // Should update status to unlocked and clear alkPath
    
    const savedData = mockVault.writeVault.mock.calls[0]![0];
    expect(savedData.items[0]!.status).toBe('unlocked');
    
    expect(mockAudit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'session_expire',
      status: 'failure'
    }));
  });
});
