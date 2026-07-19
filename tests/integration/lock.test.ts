import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import { generateVaultKey } from '../../src/core/crypto';
import { lockFile, unlockFile } from '../../src/core/fileLocker';
import { lockFolder, unlockFolder } from '../../src/core/folderLocker';
import * as cryptoModule from '../../src/core/crypto';

describe('Integration Tests: File and Folder Locking', () => {
  let tempDir: string;
  let vaultKey: Buffer;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fortilock-e2e-'));
    vaultKey = generateVaultKey();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('File Locking', () => {
    it('should complete a full lock and unlock round trip for a file', async () => {
      const originalFile = path.join(tempDir, 'testfile.txt');
      const testContent = 'Hello, this is a secret file.';
      await fs.writeFile(originalFile, testContent, 'utf-8');

      const alkPath = await lockFile(originalFile, vaultKey);

      // Verify original file is gone
      await expect(fs.access(originalFile)).rejects.toThrow();

      // Unlock
      const restoredFile = path.join(tempDir, 'restored.txt');
      await unlockFile(alkPath, restoredFile, vaultKey);

      const restoredContent = await fs.readFile(restoredFile, 'utf-8');
      expect(restoredContent).toBe(testContent);
    });

    it('should simulate an interrupted lock operation leaving the original untouched', async () => {
      const originalFile = path.join(tempDir, 'interrupted.txt');
      await fs.writeFile(originalFile, 'Data', 'utf-8');

      // To simulate interruption, we mock verifyAlkFile to throw an error 
      // (as if the power died before verification finished).
      // Since it's in the same file, we'll just test a corrupted vaultKey which triggers verification failure.
      
      const spy = jest.spyOn(cryptoModule, 'decryptStream').mockRejectedValueOnce(new Error('Verification failed'));
      
      await expect(lockFile(originalFile, vaultKey)).rejects.toThrow(/Verification failed/);
      
      spy.mockRestore();

      // Crucial part: The original file MUST still exist.
      const exists = await fs.access(originalFile).then(() => true).catch(() => false);
      expect(exists).toBe(true);
      
      // And the .alk file MUST have been cleaned up
      const alkExists = await fs.access(`${originalFile}.alk`).then(() => true).catch(() => false);
      expect(alkExists).toBe(false);
    });
  });

  describe('Folder Locking', () => {
    it('should complete a full lock and unlock round trip for a folder', async () => {
      const originalFolder = path.join(tempDir, 'testfolder');
      await fs.mkdir(originalFolder);
      await fs.writeFile(path.join(originalFolder, 'f1.txt'), 'content1');
      await fs.mkdir(path.join(originalFolder, 'sub'));
      await fs.writeFile(path.join(originalFolder, 'sub', 'f2.txt'), 'content2');

      const alkPath = await lockFolder(originalFolder, vaultKey);

      // Original folder should be deleted
      await expect(fs.access(originalFolder)).rejects.toThrow();

      // Unlock
      const restoredFolder = path.join(tempDir, 'restoredfolder');
      await unlockFolder(alkPath, restoredFolder, vaultKey);

      // Verify contents
      const c1 = await fs.readFile(path.join(restoredFolder, 'f1.txt'), 'utf-8');
      expect(c1).toBe('content1');
      const c2 = await fs.readFile(path.join(restoredFolder, 'sub', 'f2.txt'), 'utf-8');
      expect(c2).toBe('content2');
    });

    it('should simulate an interrupted folder lock operation leaving the original untouched', async () => {
      const originalFolder = path.join(tempDir, 'interruptedfolder');
      await fs.mkdir(originalFolder);
      await fs.writeFile(path.join(originalFolder, 'f1.txt'), 'content1', 'utf-8');

      const spy = jest.spyOn(cryptoModule, 'decryptStream').mockRejectedValueOnce(new Error('Verification failed'));

      await expect(lockFolder(originalFolder, vaultKey)).rejects.toThrow(/Verification failed/);

      spy.mockRestore();

      // Original folder MUST still exist
      const exists = await fs.access(originalFolder).then(() => true).catch(() => false);
      expect(exists).toBe(true);
      
      // And temp zip/alk files must be cleaned up
      const zipExists = await fs.access(`${originalFolder}.alk.zip.tmp`).then(() => true).catch(() => false);
      expect(zipExists).toBe(false);
      
      const alkTmpExists = await fs.access(`${originalFolder}.alk.zip.tmp.alk.tmp`).then(() => true).catch(() => false);
      expect(alkTmpExists).toBe(false);
      
      const alkExists = await fs.access(`${originalFolder}.alk.zip.tmp.alk`).then(() => true).catch(() => false);
      expect(alkExists).toBe(false);
      
      const finalAlkExists = await fs.access(`${originalFolder}.alk`).then(() => true).catch(() => false);
      expect(finalAlkExists).toBe(false);
    });
  });
});
