import { ProcessWatcher } from '../../src/platform/win/watcher';
import { defaultConfig } from '../../src/core/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Vault } from '../../src/core/vault';

jest.mock('node:fs/promises');
jest.mock('ps-list');
jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
  spawn: jest.fn()
}));
jest.mock('../../src/core/vault');

describe('Unit Tests: Process Watcher', () => {
  const installDir = 'C:\\Program Files\\FortiLock';
  let watcher: ProcessWatcher;
  let performanceNowSpy: jest.SpyInstance;
  let mockVault: jest.Mocked<Vault>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVault = {
      readVault: jest.fn().mockResolvedValue({ items: [] }),
      writeVault: jest.fn().mockResolvedValue(undefined)
    } as any;

    watcher = new ProcessWatcher(defaultConfig, installDir, mockVault);
    (fs.stat as jest.Mock).mockResolvedValue({ isFile: () => true });
    (fs.realpath as jest.Mock).mockImplementation((p) => Promise.resolve(p));
    performanceNowSpy = jest.spyOn(performance, 'now').mockReturnValue(1000);
  });

  afterEach(() => {
    performanceNowSpy.mockRestore();
  });

  describe('Blocklist validation', () => {
    it('should reject hard-blocked system processes', async () => {
      await expect(watcher.addToWatchList('C:\\Windows\\System32\\explorer.exe'))
        .rejects.toThrow(/Cannot lock critical system process: explorer.exe/);
        
      await expect(watcher.addToWatchList('C:\\Windows\\System32\\lsass.exe'))
        .rejects.toThrow(/Cannot lock critical system process: lsass.exe/);
    });

    it('should reject paths inside its own install directory', async () => {
      await expect(watcher.addToWatchList('C:\\Program Files\\FortiLock\\core.dll'))
        .rejects.toThrow(/Cannot lock FortiLock own directories/);
        
      // Case insensitive check
      await expect(watcher.addToWatchList('c:\\program files\\fortilock\\some_app.exe'))
        .rejects.toThrow(/Cannot lock FortiLock own directories/);
    });

    it('should accept a valid path', async () => {
      const app = await watcher.addToWatchList('C:\\Games\\Doom\\doom.exe');
      expect(app.resolvedPath.toLowerCase()).toBe('c:\\games\\doom\\doom.exe');
    });
  });

  describe('Backoff timing sequence', () => {
    it('should apply correct exponential backoff after 5 failures', async () => {
      const app = await watcher.addToWatchList('C:\\Games\\Doom\\doom.exe');
      
      // Simulate 5 failed attempts using the public method
      
      // 1-4 failures = 0 backoff
      for (let i = 1; i <= 4; i++) {
        watcher.handlePromptFailure(app);
        expect(app.nextAttemptAllowedAt).toBe(1000);
      }

      // 5th failure = 30s
      watcher.handlePromptFailure(app);
      expect(app.nextAttemptAllowedAt).toBe(31000);

      // 6th failure = 60s
      watcher.handlePromptFailure(app);
      expect(app.nextAttemptAllowedAt).toBe(61000);

      // 7th failure = 120s
      watcher.handlePromptFailure(app);
      expect(app.nextAttemptAllowedAt).toBe(121000);

      // 8th failure = 240s
      watcher.handlePromptFailure(app);
      expect(app.nextAttemptAllowedAt).toBe(241000);

      // 9th failure = 300s (capped)
      watcher.handlePromptFailure(app);
      expect(app.nextAttemptAllowedAt).toBe(301000);
    });
  });

  describe('Prompt handling', () => {
    it('should not increment failedAttempts if onPrompt returns ignored', async () => {
      const app = await watcher.addToWatchList('C:\\Games\\Doom\\doom.exe');
      
      watcher.onPrompt = jest.fn().mockResolvedValue('ignored');
      
      // We simulate handlePrompts which loops over the apps
      await (watcher as any).handlePrompts(new Set([app]), 2000);
      
      expect(app.failedAttempts).toBe(0);
      expect(watcher.onPrompt).toHaveBeenCalled();
    });
  });
});

/**
 * Security Limitation Comment:
 * As documented in §7.4, it is an accepted limitation that if a user renames a watched 
 * executable file (e.g. from doom.exe to doom2.exe), the watcher will not detect it 
 * since the canonical path no longer matches the registry. This is expected behavior
 * for Phase 3 polling and not considered a bug to fix here.
 */
