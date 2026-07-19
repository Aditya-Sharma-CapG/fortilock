import { EventEmitter } from 'events';

// Simulating Electron's BrowserWindow for the test
class MockBrowserWindow extends EventEmitter {
  public closed = false;
  
  close() {
    // In Electron, close() is asynchronous and fires 'closed' later.
    // But if we remove listeners first, it shouldn't matter.
    this.closed = true;
    setTimeout(() => {
      this.emit('closed');
    }, 10);
  }
}

describe('Concurrent Prompt Race Condition', () => {
  let unlockWin: MockBrowserWindow | null = null;
  let activePromptResolver: ((result: 'success' | 'failure' | 'ignored') => void) | null = null;
  let activePromptPath: string | null = null;

  // This perfectly replicates the logic from main.ts
  function createUnlockWindow(appPath: string) {
    if (unlockWin) {
      unlockWin.removeAllListeners('closed'); // The fix
      unlockWin.close();
      unlockWin = null;
    }
    
    unlockWin = new MockBrowserWindow();
    
    unlockWin.on('closed', () => {
      unlockWin = null;
      if (activePromptResolver) {
        activePromptResolver('failure');
        activePromptResolver = null;
        activePromptPath = null;
      }
    });
    
    return unlockWin;
  }

  const onPrompt = (appPath: string): Promise<'success' | 'failure' | 'ignored'> => {
    return new Promise((resolve) => {
      if (activePromptPath === appPath) {
        return resolve('ignored');
      }
      
      if (activePromptResolver) {
        activePromptResolver('failure');
      }
      
      activePromptPath = appPath;
      activePromptResolver = resolve;
      
      createUnlockWindow(appPath);
    });
  };

  it('should handle concurrent prompts gracefully without the stale closed race condition', async () => {
    // 1. App A triggers prompt
    const promiseA = onPrompt('AppA.exe');
    const winA = unlockWin!;
    
    // 2. Before user can react, App B triggers prompt
    const promiseB = onPrompt('AppB.exe');
    const winB = unlockWin!;

    // Assert: winA is closed, winB is open
    expect(winA.closed).toBe(true);
    expect(winB.closed).toBe(false);
    expect(winA).not.toBe(winB);

    // Assert: active globals point to AppB
    expect(activePromptPath).toBe('AppB.exe');
    expect(activePromptResolver).not.toBeNull();

    // 3. Wait for winA's asynchronous 'closed' event to fire
    await new Promise(r => setTimeout(r, 20));

    // Assert: active globals STILL point to AppB (the stale listener didn't fire)
    expect(activePromptPath).toBe('AppB.exe');
    expect(activePromptResolver).not.toBeNull();
    expect(unlockWin).toBe(winB);

    // Assert: promiseA was resolved as failure by the preempting call
    await expect(promiseA).resolves.toBe('failure');

    // 4. User finally types password for App B
    const storedResolver = activePromptResolver;
    activePromptResolver = null;
    activePromptPath = null;
    storedResolver!('success');

    // Assert: promiseB resolves correctly based on user input
    await expect(promiseB).resolves.toBe('success');
  });
});
