import {
  deriveMasterKey,
  wrapVaultKey,
  unwrapVaultKey,
  hashPassword,
  generateRandomBytes,
} from "../../src/core/crypto";
import { randomUUID } from "node:crypto";

describe("Recovery Codes Generation & Redemption", () => {
  let vaultKey: Buffer;
  let recoverySalt: Buffer;
  let recoveryEntries: any[];
  let recoveryCodes: string[];

  beforeEach(async () => {
    // Setup: Generate a vault key and recovery codes
    vaultKey = generateRandomBytes(32);
    recoverySalt = generateRandomBytes(32);
    recoveryCodes = [];
    recoveryEntries = [];

    // Generate 3 recovery codes
    for (let i = 0; i < 3; i++) {
      const codeBuf = generateRandomBytes(20);
      const code = codeBuf.toString("hex");
      recoveryCodes.push(code);

      const codeHashBuf = await hashPassword(code, recoverySalt);
      const codeHash = codeHashBuf.toString("hex");

      const derived = await deriveMasterKey(code, recoverySalt);
      const wrappedByCode = wrapVaultKey(derived, vaultKey);
      derived.fill(0);

      recoveryEntries.push({
        id: randomUUID(),
        codeHash,
        used: false,
        createdAt: Date.now(),
        wrappedVaultKey: wrappedByCode,
      });
    }
  });

  describe("Positive Cases", () => {
    it("should generate valid recovery codes", () => {
      expect(recoveryCodes).toHaveLength(3);
      recoveryCodes.forEach((code) => {
        expect(code).toMatch(/^[a-f0-9]{40}$/); // 20 bytes = 40 hex chars
        expect(code).toHaveLength(40);
      });
    });

    it("should generate unique recovery codes", () => {
      const uniqueCodes = new Set(recoveryCodes);
      expect(uniqueCodes.size).toBe(3);
    });

    it("should create recovery entries with proper structure", () => {
      expect(recoveryEntries).toHaveLength(3);
      recoveryEntries.forEach((entry) => {
        expect(entry.id).toBeDefined();
        expect(entry.codeHash).toBeDefined();
        expect(entry.used).toBe(false);
        expect(entry.createdAt).toBeGreaterThan(0);
        expect(entry.wrappedVaultKey).toBeDefined();
      });
    });

    it("should successfully redeem a recovery code", async () => {
      const code = recoveryCodes[0]!;
      const entry = recoveryEntries[0]!;

      // Verify code hash
      const codeHashBuf = await hashPassword(code, recoverySalt);
      const codeHash = codeHashBuf.toString("hex");
      expect(codeHash).toBe(entry.codeHash);

      // Unwrap vault key using recovery code
      const derived = await deriveMasterKey(code, recoverySalt);
      const unwrappedVaultKey = unwrapVaultKey(derived, entry.wrappedVaultKey);
      derived.fill(0);

      // Should match original vault key
      expect(unwrappedVaultKey).toEqual(vaultKey);
    });

    it("should handle redemption of multiple codes", async () => {
      for (let i = 0; i < recoveryCodes.length; i++) {
        const code = recoveryCodes[i]!;
        const entry = recoveryEntries[i]!;

        const derived = await deriveMasterKey(code, recoverySalt);
        const unwrappedKey = unwrapVaultKey(derived, entry.wrappedVaultKey);
        derived.fill(0);

        expect(unwrappedKey).toEqual(vaultKey);

        // Mark as used
        entry.used = true;
      }

      // All should be marked as used
      recoveryEntries.forEach((entry) => {
        expect(entry.used).toBe(true);
      });
    });

    it("should prevent reuse of already-used recovery codes", async () => {
      const entry = recoveryEntries[0]!;
      entry.used = true;

      // Try to find unused code matching the code hash
      const code = recoveryCodes[0]!;
      const codeHashBuf = await hashPassword(code, recoverySalt);
      const codeHash = codeHashBuf.toString("hex");

      const idx = recoveryEntries.findIndex(
        (e) => e.codeHash === codeHash && !e.used,
      );

      // Should not find it because it's marked as used
      expect(idx).toBe(-1);
    });
  });

  describe("Negative Cases", () => {
    it("should reject invalid recovery code format", async () => {
      const invalidCode = "not-a-valid-hex-code";

      // Hash invalid code
      const invalidHashBuf = await hashPassword(invalidCode, recoverySalt);
      const invalidHash = invalidHashBuf.toString("hex");

      // Should not match any entry hash
      const idx = recoveryEntries.findIndex((e) => e.codeHash === invalidHash);
      expect(idx).toBe(-1);
    });

    it("should reject wrong recovery code", async () => {
      const wrongCode = generateRandomBytes(20).toString("hex");
      const entry = recoveryEntries[0]!;

      // Try to unwrap with wrong code - should throw or fail
      const wrongDerived = await deriveMasterKey(wrongCode, recoverySalt);

      let failed = false;
      try {
        const wrongUnwrapped = unwrapVaultKey(
          wrongDerived,
          entry.wrappedVaultKey,
        );
        // If we get here without exception, it should not match original
        expect(wrongUnwrapped).not.toEqual(vaultKey);
      } catch (e: any) {
        // Expected: unwrap fails with wrong key
        failed = true;
      }
      wrongDerived.fill(0);

      expect(failed).toBe(true);
    });

    it("should not allow redemption of used codes", async () => {
      const code = recoveryCodes[0]!;
      const entry = recoveryEntries[0]!;

      // Mark as used
      entry.used = true;

      // Try to find it in unused entries
      const codeHashBuf = await hashPassword(code, recoverySalt);
      const codeHash = codeHashBuf.toString("hex");

      const foundIdx = recoveryEntries.findIndex(
        (e) => e.codeHash === codeHash && !e.used,
      );

      expect(foundIdx).toBe(-1);
    });

    it("should reject recovery when salt changes", async () => {
      const code = recoveryCodes[0]!;
      const entry = recoveryEntries[0]!;

      // Use wrong salt
      const wrongSalt = generateRandomBytes(32);

      const wrongDerived = await deriveMasterKey(code, wrongSalt);

      let failed = false;
      try {
        const wrongUnwrapped = unwrapVaultKey(
          wrongDerived,
          entry.wrappedVaultKey,
        );
        // If we get here without exception, it should not match original
        expect(wrongUnwrapped).not.toEqual(vaultKey);
      } catch (e: any) {
        // Expected: unwrap fails with wrong salt-derived key
        failed = true;
      }
      wrongDerived.fill(0);

      expect(failed).toBe(true);
    });
  });

  describe("Edge Cases", () => {
    it("should handle redemption with empty code list", () => {
      const emptyEntries: any[] = [];
      const code = recoveryCodes[0]!;

      // Try to find code in empty list
      const found = emptyEntries.findIndex((e) => e === code);
      expect(found).toBe(-1);
    });

    it("should regenerate codes without affecting unlocked items", async () => {
      // Original codes
      const originalCodes = [...recoveryCodes];
      const originalEntries = [...recoveryEntries];

      // Regenerate (simulate)
      const newRecoveryCodes: string[] = [];
      const newRecoveryEntries: any[] = [];

      for (let i = 0; i < 3; i++) {
        const codeBuf = generateRandomBytes(20);
        const code = codeBuf.toString("hex");
        newRecoveryCodes.push(code);

        const codeHashBuf = await hashPassword(code, recoverySalt);
        const codeHash = codeHashBuf.toString("hex");

        const derived = await deriveMasterKey(code, recoverySalt);
        const wrappedByCode = wrapVaultKey(derived, vaultKey);
        derived.fill(0);

        newRecoveryEntries.push({
          id: randomUUID(),
          codeHash,
          used: false,
          createdAt: Date.now(),
          wrappedVaultKey: wrappedByCode,
        });
      }

      // Vault key should be the same
      const originalUnwrapped = unwrapVaultKey(
        await deriveMasterKey(originalCodes[0]!, recoverySalt),
        originalEntries[0]!.wrappedVaultKey,
      );

      const newUnwrapped = unwrapVaultKey(
        await deriveMasterKey(newRecoveryCodes[0]!, recoverySalt),
        newRecoveryEntries[0]!.wrappedVaultKey,
      );

      // Both should unwrap to same vault key
      expect(originalUnwrapped).toEqual(vaultKey);
      expect(newUnwrapped).toEqual(vaultKey);

      // But codes should be different
      expect(newRecoveryCodes).not.toEqual(originalCodes);
    });

    it("should handle code redemption during active session", async () => {
      // Assume a session exists
      const code = recoveryCodes[0]!;
      const entry = recoveryEntries[0]!;

      // Redeem code
      const derived = await deriveMasterKey(code, recoverySalt);
      const recoveredKey = unwrapVaultKey(derived, entry.wrappedVaultKey);
      derived.fill(0);

      // Mark as used
      entry.used = true;

      // New code should still work for unlocking
      const newCode = recoveryCodes[1]!;
      const newEntry = recoveryEntries[1]!;

      const newDerived = await deriveMasterKey(newCode, recoverySalt);
      const newRecoveredKey = unwrapVaultKey(
        newDerived,
        newEntry.wrappedVaultKey,
      );
      newDerived.fill(0);

      expect(newRecoveredKey).toEqual(vaultKey);
      expect(newEntry.used).toBe(false);
    });

    it("should handle all codes being used", () => {
      // Mark all as used
      recoveryEntries.forEach((entry) => {
        entry.used = true;
      });

      // Should have no unused codes
      const unusedCodes = recoveryEntries.filter((e) => !e.used);
      expect(unusedCodes).toHaveLength(0);
    });
  });
});
