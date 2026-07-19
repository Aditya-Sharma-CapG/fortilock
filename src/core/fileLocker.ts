import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { encryptStream, decryptStream } from './crypto';
import { Writable } from 'node:stream';

const ALK_MAGIC = Buffer.from('F_ALK_V1');

export function sanitizePath(p: string): string {
  if (process.platform === 'win32' && p.length >= 260 && !p.startsWith('\\\\?\\')) {
    return `\\\\?\\${p}`;
  }
  return p;
}

export async function checkDiskSpace(required: number, dir: string): Promise<boolean> {
  try {
    const stats = await fs.statfs(dir);
    const freeSpace = stats.bavail * stats.bsize;
    return freeSpace > required;
  } catch (e) {
    console.debug('Disk space check failed, assuming true:', e);
    return true; // Fallback if statfs fails
  }
}

export async function isFileAccessible(filePath: string): Promise<boolean> {
  try {
    const fh = await fs.open(filePath, 'r+');
    await fh.close();
    return true;
  } catch (e) {
    console.debug('File accessibility check failed:', e);
    return false;
  }
}

export async function lockFile(originalPath: string, vaultKey: Buffer): Promise<string> {
  const safePath = sanitizePath(originalPath);
  const alkPath = `${safePath}.alk`;
  const tempAlkPath = `${alkPath}.tmp`;
  
  if (!(await isFileAccessible(safePath))) {
    throw new Error('File is in use, read-only, or permission denied.');
  }

  const stat = await fs.stat(safePath);
  const destDir = path.dirname(safePath);
  if (!(await checkDiskSpace(stat.size * 1.1, destDir))) {
    throw new Error('Insufficient disk space for encryption.');
  }

  const originalFilename = Buffer.from(path.basename(originalPath), 'utf8');
  if (originalFilename.length > 65535) {
    throw new Error('Filename too long.');
  }

  const headerSize = 8 + 12 + 16 + 2 + originalFilename.length;
  let fileHandle = await fs.open(tempAlkPath, 'w');
  
  try {
    const initialHeader = Buffer.alloc(headerSize);
    initialHeader.set(ALK_MAGIC, 0);
    initialHeader.writeUInt16LE(originalFilename.length, 8 + 12 + 16);
    initialHeader.set(originalFilename, 8 + 12 + 16 + 2);
    
    await fileHandle.write(initialHeader, 0, headerSize, 0);
    
    const outStream = createWriteStream('', { fd: fileHandle.fd, start: headerSize, autoClose: false });
    const inStream = createReadStream(safePath);
    
    const { iv, authTag } = await encryptStream(vaultKey, inStream, outStream);
    
    await fileHandle.write(iv, 0, 12, 8);
    await fileHandle.write(authTag, 0, 16, 8 + 12);
    await fileHandle.close();
  } catch (err) {
    await fileHandle.close().catch(() => {});
    await fs.unlink(tempAlkPath).catch(() => {});
    throw err;
  }
  
  try {
    await verifyAlkFile(tempAlkPath, vaultKey);
    await fs.rename(tempAlkPath, alkPath);
  } catch (err) {
    await fs.unlink(tempAlkPath).catch(() => {});
    throw new Error(`Verification failed. Original untouched. Error: ${err}`);
  }

  try {
    const fd = await fs.open(safePath, 'r+');
    const chunkSize = 1024 * 1024; // 1MB
    const zeroBuf = Buffer.alloc(chunkSize);
    let bytesWritten = 0;
    while (bytesWritten < stat.size) {
      const writeLen = Math.min(chunkSize, stat.size - bytesWritten);
      await fd.write(zeroBuf, 0, writeLen, bytesWritten);
      bytesWritten += writeLen;
    }
    await fd.close();
  } catch (e) {
    console.debug('Failed to securely overwrite file before deletion:', e);
  }
  
  await fs.unlink(safePath);
  
  return alkPath;
}

export async function unlockFile(alkPath: string, destPath: string, vaultKey: Buffer): Promise<void> {
  const safeAlkPath = sanitizePath(alkPath);
  const safeDestPath = sanitizePath(destPath);
  
  let fileHandle = await fs.open(safeAlkPath, 'r');
  
  try {
    const { iv, authTag, headerSize } = await readAlkHeader(fileHandle);
    const inStream = createReadStream('', { fd: fileHandle.fd, start: headerSize, autoClose: false });
    const outStream = createWriteStream(safeDestPath);
    
    await decryptStream(vaultKey, iv, authTag, inStream, outStream);
    await fileHandle.close();
  } catch(err) {
    await fileHandle.close().catch(() => {});
    throw err;
  }
}

async function verifyAlkFile(alkPath: string, vaultKey: Buffer): Promise<void> {
  let fileHandle = await fs.open(alkPath, 'r');
  try {
    const { iv, authTag, headerSize } = await readAlkHeader(fileHandle);
    
    const inStream = createReadStream('', { fd: fileHandle.fd, start: headerSize, autoClose: false });
    const outStream = new Writable({
      write(chunk: any, encoding: any, callback: any) { callback(); }
    });
    
    await decryptStream(vaultKey, iv, authTag, inStream, outStream);
    await fileHandle.close();
  } catch(err) {
    await fileHandle.close().catch(() => {});
    throw err;
  }
}

async function readAlkHeader(fileHandle: fs.FileHandle) {
  const magicBuf = Buffer.alloc(8);
  await fileHandle.read(magicBuf, 0, 8, 0);
  if (!magicBuf.equals(ALK_MAGIC)) {
    throw new Error('Not a valid .alk file.');
  }
  
  const iv = Buffer.alloc(12);
  await fileHandle.read(iv, 0, 12, 8);
  
  const authTag = Buffer.alloc(16);
  await fileHandle.read(authTag, 0, 16, 20);
  
  const lenBuf = Buffer.alloc(2);
  await fileHandle.read(lenBuf, 0, 2, 36);
  const nameLen = lenBuf.readUInt16LE(0);
  
  const nameBuf = Buffer.alloc(nameLen);
  await fileHandle.read(nameBuf, 0, nameLen, 38);
  
  return { iv, authTag, nameLen, originalName: nameBuf.toString('utf8'), headerSize: 38 + nameLen };
}
