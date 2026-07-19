import crypto from 'crypto';
import { Readable, Writable } from 'stream';
import {
  generateRandomBytes,
  generateVaultKey,
  deriveMasterKey,
  hashPassword,
  verifyPassword,
  wrapVaultKey,
  unwrapVaultKey,
  encryptBuffer,
  decryptBuffer,
  encryptStream,
  decryptStream
} from '../../src/core/crypto';

describe('Crypto Module', () => {
  describe('Key Derivation and Hashing', () => {
    it('should deterministically derive the same master key for the same password and salt', async () => {
      const password = 'my-super-secret-password';
      const salt = generateRandomBytes(16);
      
      const key1 = await deriveMasterKey(password, salt);
      const key2 = await deriveMasterKey(password, salt);
      
      expect(key1).toEqual(key2);
      expect(key1).toHaveLength(32);
    });

    it('should derive different keys for different salts', async () => {
      const password = 'password';
      const key1 = await deriveMasterKey(password, generateRandomBytes(16));
      const key2 = await deriveMasterKey(password, generateRandomBytes(16));
      
      expect(key1).not.toEqual(key2);
    });

    it('should correctly hash and verify a password', async () => {
      const password = 'password123';
      const salt = generateRandomBytes(16);
      const hash = await hashPassword(password, salt);
      
      const isValid = await verifyPassword(password, hash, salt);
      expect(isValid).toBe(true);
      
      const isInvalid = await verifyPassword('wrongpassword', hash, salt);
      expect(isInvalid).toBe(false);
    });

    it('should handle edge cases in passwords (empty, unicode, long strings)', async () => {
      const salt = generateRandomBytes(16);
      const testCases = [
        '',
        '🚀👾👽', // unicode emojis
        'a'.repeat(10000) // long string
      ];

      for (const pwd of testCases) {
        const hash = await hashPassword(pwd, salt);
        expect(await verifyPassword(pwd, hash, salt)).toBe(true);
        expect(await verifyPassword(pwd + '1', hash, salt)).toBe(false);
      }
    });
  });

  describe('Envelope Key Model (Wrap/Unwrap)', () => {
    it('should wrap and unwrap a vault key', async () => {
      const masterKey = generateRandomBytes(32);
      const vaultKey = generateVaultKey();
      
      const wrapped = wrapVaultKey(masterKey, vaultKey);
      expect(wrapped.ciphertext).toBeDefined();
      expect(wrapped.iv).toBeDefined();
      expect(wrapped.authTag).toBeDefined();
      
      const unwrapped = unwrapVaultKey(masterKey, wrapped);
      expect(unwrapped).toEqual(vaultKey);
    });

    it('should throw when unwrapping with the wrong master key', async () => {
      const masterKey = generateRandomBytes(32);
      const wrongMasterKey = generateRandomBytes(32);
      const vaultKey = generateVaultKey();
      
      const wrapped = wrapVaultKey(masterKey, vaultKey);
      
      expect(() => unwrapVaultKey(wrongMasterKey, wrapped)).toThrow(); // Auth tag mismatch
    });
  });

  describe('Buffer Encrypt/Decrypt (AES-256-GCM)', () => {
    it('should encrypt and decrypt buffers of various sizes (0 bytes, 1 byte, block boundary)', () => {
      const key = generateVaultKey();
      const sizes = [0, 1, 16, 32, 1024];

      for (const size of sizes) {
        const plaintext = generateRandomBytes(size);
        const { ciphertext, iv, authTag } = encryptBuffer(key, plaintext);
        
        const decrypted = decryptBuffer(key, ciphertext, iv, authTag);
        expect(decrypted).toEqual(plaintext);
        
        if (size > 0) {
          expect(ciphertext).not.toEqual(plaintext);
        }
      }
    });

    it('should generate fresh 96-bit IVs for each encryption', () => {
      const key = generateVaultKey();
      const plaintext = Buffer.from('test');
      
      const res1 = encryptBuffer(key, plaintext);
      const res2 = encryptBuffer(key, plaintext);
      
      expect(res1.iv).not.toEqual(res2.iv);
      expect(res1.iv).toHaveLength(12); // 96 bits
      expect(res2.iv).toHaveLength(12);
    });

    it('should fail cleanly if ciphertext or auth tag is tampered with', () => {
      const key = generateVaultKey();
      const plaintext = Buffer.from('important data');
      const { ciphertext, iv, authTag } = encryptBuffer(key, plaintext);
      
      // Tamper ciphertext
      const tamperedCiphertext = Buffer.from(ciphertext);
      if (tamperedCiphertext.length > 0) {
        tamperedCiphertext.writeUInt8(tamperedCiphertext.readUInt8(0) ^ 1, 0);
      }
      expect(() => decryptBuffer(key, tamperedCiphertext, iv, authTag)).toThrow();

      // Tamper auth tag
      const tamperedAuthTag = Buffer.from(authTag);
      tamperedAuthTag.writeUInt8(tamperedAuthTag.readUInt8(0) ^ 1, 0);
      expect(() => decryptBuffer(key, ciphertext, iv, tamperedAuthTag)).toThrow();
    });
  });

  describe('Stream Encrypt/Decrypt (AES-256-GCM)', () => {
    it('should stream encrypt and decrypt data properly', async () => {
      const key = generateVaultKey();
      const dataSize = 5 * 1024 * 1024; // 5MB to simulate multi-chunk file
      const plaintext = crypto.randomBytes(dataSize);
      
      // Setup memory streams
      let ciphertextChunks: Buffer[] = [];
      const inputPlaintext = Readable.from(plaintext, { objectMode: false });
      const outputCiphertext = new Writable({
        write(chunk, encoding, callback) {
          ciphertextChunks.push(Buffer.from(chunk));
          callback();
        }
      });
      
      const { iv, authTag } = await encryptStream(key, inputPlaintext, outputCiphertext);
      const fullCiphertext = Buffer.concat(ciphertextChunks);
      
      let decryptedChunks: Buffer[] = [];
      const inputCiphertext = Readable.from(fullCiphertext, { objectMode: false });
      const outputPlaintext = new Writable({
        write(chunk, encoding, callback) {
          decryptedChunks.push(Buffer.from(chunk));
          callback();
        }
      });
      
      await decryptStream(key, iv, authTag, inputCiphertext, outputPlaintext);
      const fullDecrypted = Buffer.concat(decryptedChunks);
      
      expect(fullDecrypted).toEqual(plaintext);
    });

    it('should fail stream decryption on auth tag mismatch', async () => {
      const key = generateVaultKey();
      const plaintext = Buffer.from('stream test data');
      
      const inputPlaintext = Readable.from(plaintext);
      const outputCiphertext = new Writable({ write(chunk, enc, cb) { cb(); } }); // Discard
      
      const { iv, authTag } = await encryptStream(key, inputPlaintext, outputCiphertext);
      
      // Re-run stream encrypt correctly to get ciphertext for testing
      let chunks: Buffer[] = [];
      const w = new Writable({ write(c, e, cb) { chunks.push(c); cb(); } });
      const r = Readable.from(plaintext);
      const res = await encryptStream(key, r, w);
      
      const tamperedTag = Buffer.from(res.authTag);
      tamperedTag.writeUInt8(tamperedTag.readUInt8(0) ^ 1, 0);

      const inputCiphertext = Readable.from(Buffer.concat(chunks));
      const outputPlaintext = new Writable({ write(c, e, cb) { cb(); } });
      
      await expect(decryptStream(key, res.iv, tamperedTag, inputCiphertext, outputPlaintext)).rejects.toThrow();
    });
  });
});
