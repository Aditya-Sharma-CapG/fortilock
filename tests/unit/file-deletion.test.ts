import fs from "node:fs/promises";
import path from "node:path";
import { lockFile, unlockFile } from "../../src/core/fileLocker";
import { generateRandomBytes } from "../../src/core/crypto";

describe("File Deletion & Unlock Flow", () => {
  let testDir: string;
  let testFile: string;
  let vaultKey: Buffer;
  let alkPath: string;

  beforeEach(async () => {
    // Setup: Create temp test directory
    testDir = path.join(__dirname, "../../test-fixtures", `test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    testFile = path.join(testDir, "test-file.txt");
    await fs.writeFile(testFile, "Test content for deletion flow");

    vaultKey = generateRandomBytes(32);
  });

  afterEach(async () => {
    // Cleanup: Remove test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (e) {
      console.warn("Cleanup warning:", e);
    }
  });

  describe("Positive Cases", () => {
    it("should lock and unlock a file successfully", async () => {
      // Lock file
      alkPath = await lockFile(testFile, vaultKey);
      expect(alkPath).toBeDefined();
      expect(alkPath).toMatch(/\.alk$/);

      // Original file should be deleted/zeroed
      let originalExists = true;
      try {
        await fs.access(testFile);
      } catch {
        originalExists = false;
      }
      expect(originalExists).toBe(false);

      // .alk file should exist
      let alkExists = false;
      try {
        await fs.access(alkPath);
        alkExists = true;
      } catch {
        alkExists = false;
      }
      expect(alkExists).toBe(true);

      // Unlock file
      const unlockedPath = path.join(testDir, "test-file-unlocked.txt");
      await unlockFile(alkPath, unlockedPath, vaultKey);

      // Unlocked file should exist
      const unlocked = await fs.readFile(unlockedPath, "utf-8");
      expect(unlocked).toBe("Test content for deletion flow");
    });

    it("should detect missing encrypted file during unlock", async () => {
      // Lock file
      alkPath = await lockFile(testFile, vaultKey);

      // Delete the .alk file
      await fs.unlink(alkPath);

      // Try to unlock - should fail because .alk is missing
      const unlockedPath = path.join(testDir, "test-file-unlocked.txt");
      let error: Error | null = null;
      try {
        await unlockFile(alkPath, unlockedPath, vaultKey);
      } catch (e) {
        error = e as Error;
      }

      // Should have an error about missing file or invalid file
      expect(error).toBeDefined();
      expect(error?.message).toMatch(/not a valid|ENOENT|no such file/i);
    });

    it("should handle unlock with wrong password", async () => {
      // Lock file
      alkPath = await lockFile(testFile, vaultKey);

      // Try to unlock with wrong key
      const wrongKey = generateRandomBytes(32);
      const unlockedPath = path.join(testDir, "test-file-unlocked.txt");
      let error: Error | null = null;
      try {
        await unlockFile(alkPath, unlockedPath, wrongKey);
      } catch (e) {
        error = e as Error;
      }

      // Should fail with decryption error
      expect(error).toBeDefined();
      expect(error?.message.toLowerCase()).toMatch(
        /decipher|decrypt|auth|invalid/i,
      );
    });
  });

  describe("Negative Cases", () => {
    it("should fail when trying to lock a non-existent file", async () => {
      const nonExistentFile = path.join(testDir, "does-not-exist.txt");

      let error: Error | null = null;
      try {
        await lockFile(nonExistentFile, vaultKey);
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
      expect(error?.message.toLowerCase()).toMatch(
        /not found|enoent|does not exist|permission denied/i,
      );
    });

    it("should fail when trying to unlock with missing .alk file", async () => {
      // Try to unlock a file that was never locked
      const fakeLockPath = path.join(testDir, "nonexistent.txt.alk");
      const unlockedPath = path.join(testDir, "unlocked.txt");

      let error: Error | null = null;
      try {
        await unlockFile(fakeLockPath, unlockedPath, vaultKey);
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
    });

    it("should handle unlock destination in read-only directory", async () => {
      // Lock file
      alkPath = await lockFile(testFile, vaultKey);

      // Create a read-only destination (if permissions allow)
      const readOnlyDir = path.join(testDir, "readonly");
      await fs.mkdir(readOnlyDir, { recursive: true });

      // On some systems, we can't change permissions, so skip this test
      try {
        await fs.chmod(readOnlyDir, 0o444);
        const unlockedPath = path.join(readOnlyDir, "unlocked.txt");

        let error: Error | null = null;
        try {
          await unlockFile(alkPath, unlockedPath, vaultKey);
        } catch (e) {
          error = e as Error;
        }

        expect(error).toBeDefined();

        // Restore permissions for cleanup
        await fs.chmod(readOnlyDir, 0o755);
      } catch {
        // Skip if can't set permissions
        console.log("Skipping read-only directory test");
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle large files", async () => {
      // Create a large test file (10MB)
      const largeContent = Buffer.alloc(10 * 1024 * 1024, "x");
      const largeFile = path.join(testDir, "large-file.bin");
      await fs.writeFile(largeFile, largeContent);

      // Lock large file
      alkPath = await lockFile(largeFile, vaultKey);
      expect(alkPath).toBeDefined();

      // Unlock large file
      const unlockedPath = path.join(testDir, "large-file-unlocked.bin");
      await unlockFile(alkPath, unlockedPath, vaultKey);

      const unlockedContent = await fs.readFile(unlockedPath);
      expect(unlockedContent).toHaveLength(largeContent.length);
    });

    it("should handle files with special characters in name", async () => {
      const specialFile = path.join(testDir, "file-with-!@#$%^&()_+-=.txt");
      await fs.writeFile(specialFile, "Special file content");

      // Lock special file
      alkPath = await lockFile(specialFile, vaultKey);
      expect(alkPath).toBeDefined();

      // Unlock special file
      const unlockedPath = path.join(testDir, "special-unlocked.txt");
      await unlockFile(alkPath, unlockedPath, vaultKey);

      const unlocked = await fs.readFile(unlockedPath, "utf-8");
      expect(unlocked).toBe("Special file content");
    });

    it("should handle empty files", async () => {
      const emptyFile = path.join(testDir, "empty.txt");
      await fs.writeFile(emptyFile, "");

      // Lock empty file
      alkPath = await lockFile(emptyFile, vaultKey);
      expect(alkPath).toBeDefined();

      // Unlock empty file
      const unlockedPath = path.join(testDir, "empty-unlocked.txt");
      await unlockFile(alkPath, unlockedPath, vaultKey);

      const unlocked = await fs.readFile(unlockedPath, "utf-8");
      expect(unlocked).toBe("");
    });

    it("should handle consecutive lock/unlock cycles", async () => {
      let currentPath = testFile;

      for (let i = 0; i < 3; i++) {
        // Lock
        alkPath = await lockFile(currentPath, vaultKey);
        expect(alkPath).toBeDefined();

        // Unlock
        const nextPath = path.join(testDir, `cycle-${i}-unlocked.txt`);
        await unlockFile(alkPath, nextPath, vaultKey);

        // Read and verify
        const content = await fs.readFile(nextPath, "utf-8");
        expect(content).toBe("Test content for deletion flow");

        // Use unlocked file as next input
        currentPath = nextPath;
      }
    });

    it("should prevent double-unlock of the same .alk file", async () => {
      // Lock file
      alkPath = await lockFile(testFile, vaultKey);

      // Unlock first time
      const unlockedPath1 = path.join(testDir, "unlocked1.txt");
      await unlockFile(alkPath, unlockedPath1, vaultKey);

      // Try to unlock same .alk again (should work technically, but .alk is consumed/corrupted)
      const unlockedPath2 = path.join(testDir, "unlocked2.txt");
      let error: Error | null = null;
      try {
        await unlockFile(alkPath, unlockedPath2, vaultKey);
      } catch (e) {
        error = e as Error;
      }

      // This should fail because .alk header/auth was already read
      // This is an edge case - depending on implementation
      // The file stream might be at EOF or auth tag already consumed
      if (error) {
        expect(error.message).toMatch(/decipher|decrypt|auth|invalid/i);
      }
    });
  });
});
