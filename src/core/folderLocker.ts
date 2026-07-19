import archiver = require('archiver');
import unzipper = require('unzipper');
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import { lockFile, unlockFile, checkDiskSpace } from './fileLocker';

export async function preScanFolder(folderPath: string): Promise<{ size: number, hasSymlinks: boolean }> {
  let size = 0;
  let hasSymlinks = false;
  
  async function scan(currentPath: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        hasSymlinks = true;
      } else if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        size += stat.size;
      }
    }
  }
  await scan(folderPath);
  return { size, hasSymlinks };
}

export async function lockFolder(folderPath: string, vaultKey: Buffer): Promise<string> {
  const { size, hasSymlinks } = await preScanFolder(folderPath);
  if (hasSymlinks) {
    console.warn('Folder contains symlinks. They will be skipped per user choice/default.');
  }
  if (size > 2 * 1024 * 1024 * 1024) {
    console.warn('Folder size exceeds 2GB. This operation may take a long time and use significant disk space.');
  }
  
  const destDir = path.dirname(folderPath);
  if (!(await checkDiskSpace(size * 2.5, destDir))) {
    throw new Error('Insufficient disk space for folder encryption.');
  }

  const tempZipPath = `${folderPath}.alk.zip.tmp`;
  
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(tempZipPath);
    const archive = (archiver as any)('zip', {
      zlib: { level: 0 }
    });
    
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    async function appendFiles(currentPath: string, basePath: string) {
      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);
          const relPath = path.relative(basePath, fullPath).replace(/\\/g, '/');
          
          if (entry.isSymbolicLink()) {
            continue; // Explicitly skip symlinks per Edge Case #23
          } else if (entry.isDirectory()) {
            await appendFiles(fullPath, basePath);
          } else if (entry.isFile()) {
            archive.file(fullPath, { name: relPath });
          }
        }
      } catch (err) {
        archive.abort();
        reject(err);
      }
    }
    
    appendFiles(folderPath, folderPath).then(() => {
      archive.finalize();
    }).catch(reject);
  });
  
  let alkPath: string;
  try {
    alkPath = await lockFile(tempZipPath, vaultKey);
  } catch (err) {
    await fs.unlink(tempZipPath).catch(() => {});
    throw err;
  }
  
  // lockFile succeeds, now safely delete the original folder
  await fs.rm(folderPath, { recursive: true, force: true });
  
  const finalAlkPath = `${folderPath}.alk`;
  await fs.rename(alkPath, finalAlkPath);
  
  return finalAlkPath;
}

export async function unlockFolder(alkPath: string, destPath: string, vaultKey: Buffer): Promise<void> {
  const tempZipPath = `${alkPath}.zip.tmp`;
  
  try {
    await unlockFile(alkPath, tempZipPath, vaultKey);
    
    await fs.mkdir(destPath, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const readStream = createReadStream(tempZipPath);
      const extractStream = unzipper.Extract({ path: destPath });
      
      extractStream.on('close', resolve);
      extractStream.on('error', reject);
      readStream.on('error', reject);
      
      readStream.pipe(extractStream);
    });
  } finally {
    await fs.unlink(tempZipPath).catch(() => {});
  }
}
