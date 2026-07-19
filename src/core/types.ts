export interface WrappedKey {
  iv: string; // hex string
  authTag: string; // hex string
  ciphertext: string; // hex string
}

export interface LockedItem {
  id: string; // UUID
  type: 'file' | 'folder' | 'app';
  originalPath: string;
  alkPath: string; // path to the encrypted .alk file
  status: 'locked' | 'unlocked';
}

export interface RecoveryKeyEntry {
  id: string;
  codeHash: string; // hex
  used: boolean;
  createdAt: number;
  wrappedVaultKey?: WrappedKey; // optional per-key wrapped vault key
}

export interface VaultData {
  passwordHash: string; // hex string
  passwordSalt: string; // hex string
  masterKeySalt: string; // hex string
  wrappedVaultKey: WrappedKey;
  items: LockedItem[]; // Items registry

  // Recovery support
  recoverySalt?: string; // hex
  recoveryKeys?: RecoveryKeyEntry[];
}
