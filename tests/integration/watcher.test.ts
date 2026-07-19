import { ProcessWatcher } from '../../src/platform/win/watcher';
import { defaultConfig } from '../../src/core/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { Vault } from '../../src/core/vault';

describe('Integration Tests: Process Watcher', () => {
  let watcher: ProcessWatcher;
  let tempDir: string;
  const installDir = 'C:\\Program Files\\FortiLock';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fortilock-watcher-'));
    const vault = new Vault(path.join(tempDir, 'vault.json'));
    await vault.writeVault({
      passwordHash: 'hash',
      passwordSalt: 'salt',
      masterKeySalt: 'mksalt',
      wrappedVaultKey: { iv: '1', authTag: '2', ciphertext: '3' },
      items: []
    });
    watcher = new ProcessWatcher({ ...defaultConfig, pollIntervalMs: 500, gracePeriodMs: 5000 }, installDir, vault);
  });

  afterEach(async () => {
    watcher.stop();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('should detect and terminate a watched process, and grace list prevents re-kill', async () => {
    const dummyExe = path.join(tempDir, 'dummy_app_test.exe');
    await fs.copyFile(process.execPath, dummyExe);

    await watcher.addToWatchList(dummyExe);
    
    let prompted = false;
    watcher.onPrompt = async () => {
      prompted = true;
      return 'success'; // Simulate correct password -> relaunches and adds to grace list
    };

    // Spawn the dummy executable with a sleep script
    const scriptPath = path.join(tempDir, 'sleep.js');
    await fs.writeFile(scriptPath, 'setTimeout(() => {}, 30000);');

    const child = spawn(dummyExe, [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    const originalPid = child.pid!;

    // Give the process a moment to fully start
    await new Promise(r => setTimeout(r, 2000));

    // Manually call poll() — more reliable than setInterval in Jest
    let attempts = 0;
    while (!prompted && attempts < 10) {
      await watcher.poll();
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    expect(prompted).toBe(true);

    // The original process should be killed
    let isDead = false;
    try {
      process.kill(originalPid, 0);
    } catch {
      isDead = true;
    }
    expect(isDead).toBe(true);
    
    // Verify grace list was populated (prevents re-kill of relaunched process)
    const lowerPath = (await fs.realpath(dummyExe)).toLowerCase();
    const graceExpiry = (watcher as any).graceList.get(lowerPath);
    expect(graceExpiry).toBeGreaterThan(performance.now());
  }, 30000);
});
