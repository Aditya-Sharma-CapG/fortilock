import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { WrappedKey } from './types';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12; // 96 bits
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

export function generateRandomBytes(length: number): Buffer {
  return crypto.randomBytes(length);
}

export function generateVaultKey(): Buffer {
  return generateRandomBytes(KEY_LENGTH);
}

export function deriveMasterKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function verifyPassword(password: string, expectedHash: Buffer, salt: Buffer): Promise<boolean> {
  const hash = await hashPassword(password, salt);
  if (hash.length !== expectedHash.length) {
    return false;
  }
  return crypto.timingSafeEqual(hash, expectedHash);
}

export function wrapVaultKey(masterKey: Buffer, vaultKey: Buffer): WrappedKey {
  const iv = generateRandomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);
  
  let ciphertext = cipher.update(vaultKey);
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: ciphertext.toString('hex')
  };
}

export function unwrapVaultKey(masterKey: Buffer, wrapped: WrappedKey): Buffer {
  const iv = Buffer.from(wrapped.iv, 'hex');
  const authTag = Buffer.from(wrapped.authTag, 'hex');
  const ciphertext = Buffer.from(wrapped.ciphertext, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAuthTag(authTag);

  let vaultKey = decipher.update(ciphertext);
  vaultKey = Buffer.concat([vaultKey, decipher.final()]);

  return vaultKey;
}

export function encryptBuffer(key: Buffer, plaintext: Buffer): { ciphertext: Buffer, iv: Buffer, authTag: Buffer } {
  const iv = generateRandomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let ciphertext = cipher.update(plaintext);
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);
  
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag()
  };
}

export function decryptBuffer(key: Buffer, ciphertext: Buffer, iv: Buffer, authTag: Buffer): Buffer {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let plaintext = decipher.update(ciphertext);
  plaintext = Buffer.concat([plaintext, decipher.final()]);
  
  return plaintext;
}

export function encryptStream(key: Buffer, inputStream: Readable, outputStream: Writable): Promise<{ iv: Buffer, authTag: Buffer }> {
  return new Promise((resolve, reject) => {
    const iv = generateRandomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    inputStream.pipe(cipher).pipe(outputStream);
    
    outputStream.on('finish', () => {
      resolve({ iv, authTag: cipher.getAuthTag() });
    });
    
    inputStream.on('error', reject);
    cipher.on('error', reject);
    outputStream.on('error', reject);
  });
}

export function decryptStream(key: Buffer, iv: Buffer, authTag: Buffer, inputStream: Readable, outputStream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    inputStream.pipe(decipher).pipe(outputStream);
    
    outputStream.on('finish', () => resolve());
    
    inputStream.on('error', reject);
    decipher.on('error', reject);
    outputStream.on('error', reject);
  });
}

export async function changeMasterPassword(newPassword: string, currentVaultKey: Buffer): Promise<Pick<import('./types').VaultData, 'passwordHash' | 'passwordSalt' | 'masterKeySalt' | 'wrappedVaultKey'>> {
  const passwordSalt = generateRandomBytes(32);
  const masterKeySalt = generateRandomBytes(32);
  
  const passwordHashBuf = await hashPassword(newPassword, passwordSalt);
  const passwordHash = passwordHashBuf.toString('hex');
  
  const masterKey = await deriveMasterKey(newPassword, masterKeySalt);
  const wrappedVaultKey = wrapVaultKey(masterKey, currentVaultKey);
  
  masterKey.fill(0); // Clear from memory

  return {
    passwordHash,
    passwordSalt: passwordSalt.toString('hex'),
    masterKeySalt: masterKeySalt.toString('hex'),
    wrappedVaultKey
  };
}
