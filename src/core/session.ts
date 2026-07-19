import { Vault } from "./vault";
import { lockFile } from "./fileLocker";
import { lockFolder } from "./folderLocker";
import { AuditLogger } from "./audit";
import fs from "node:fs/promises";

export interface UnlockedSession {
  itemId: string;
  expiresAt: number; // monotonic time
}

export class SessionManager {
  private readonly sessions = new Map<string, UnlockedSession>();
  private readonly idleTimeoutMs: number;
  private readonly vault: Vault;
  private readonly audit: AuditLogger;
  private vaultKey: Buffer | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(vault: Vault, audit: AuditLogger, idleTimeoutMinutes: number) {
    this.vault = vault;
    this.audit = audit;
    this.idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;
  }

  setVaultKey(key: Buffer) {
    this.vaultKey = key;
  }

  clearVaultKey() {
    if (this.vaultKey) {
      this.vaultKey.fill(0);
      this.vaultKey = null;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkExpiries(), 5000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  addSession(itemId: string) {
    this.sessions.set(itemId, {
      itemId,
      expiresAt: performance.now() + this.idleTimeoutMs,
    });
  }

  removeSession(itemId: string) {
    this.sessions.delete(itemId);
  }

  hasSession(itemId: string): boolean {
    const s = this.sessions.get(itemId);
    if (!s) return false;
    return performance.now() < s.expiresAt;
  }

  getSessionExpiry(itemId: string): number | null {
    const s = this.sessions.get(itemId);
    return s ? s.expiresAt : null;
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  async lockAllNow(itemIds?: string[]) {
    const ids =
      itemIds && itemIds.length > 0
        ? Array.from(this.sessions.keys()).filter((id) => itemIds.includes(id))
        : Array.from(this.sessions.keys());

    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session) {
        session.expiresAt = 0; // force expire
      }
    }
    await this.checkExpiries();
  }

  private async relockItem(item: any): Promise<boolean> {
    if (item.type === "app") {
      item.status = "locked";
      return true;
    }

    if (!this.vaultKey) {
      throw new Error("Vault key not available to re-lock item");
    }

    try {
      await fs.access(item.originalPath);
    } catch {
      item.status = "unlocked";
      item.alkPath = "";
      this.sessions.delete(item.id);
      await this.audit.log({
        id: item.id,
        type: item.type,
        action: "session_expire",
        status: "failure",
        details: "Item moved or deleted",
      });
      return true; // vault was updated
    }

    let alkPath = "";
    if (item.type === "file") {
      alkPath = await lockFile(item.originalPath, this.vaultKey);
    } else {
      alkPath = await lockFolder(item.originalPath, this.vaultKey);
    }

    item.status = "locked";
    item.alkPath = alkPath;
    return true;
  }

  private async checkExpiries() {
    const now = performance.now();
    const toExpire = [];

    for (const session of this.sessions.values()) {
      if (now >= session.expiresAt) {
        toExpire.push(session.itemId);
      }
    }

    if (toExpire.length === 0) return;

    const vaultData = await this.vault.readVault();
    let vaultUpdated = false;

    for (const itemId of toExpire) {
      const item = vaultData.items.find((i) => i.id === itemId);
      if (!item) {
        this.sessions.delete(itemId);
        continue;
      }

      if (item.preventAutoLock) {
        await this.audit.log({
          id: item.id,
          type: item.type,
          action: "session_expire",
          status: "success",
          details: "Auto-lock skipped because preventAutoLock is enabled.",
        });
        this.sessions.delete(itemId);
        continue;
      }

      try {
        const updated = await this.relockItem(item);
        if (updated) vaultUpdated = true;

        if (item.status === "locked") {
          await this.audit.log({
            id: item.id,
            type: item.type,
            action: "session_expire",
            status: "success",
          });
        }
      } catch (err: any) {
        console.error(`Failed to relock item ${item.id}:`, err);
        await this.audit.log({
          id: item.id,
          type: item.type,
          action: "session_expire",
          status: "failure",
          details: err.message,
        });
      }

      this.sessions.delete(itemId);
    }

    if (vaultUpdated) {
      await this.vault.writeVault(vaultData);
    }
  }
}
