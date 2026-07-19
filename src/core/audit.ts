import fs from "node:fs/promises";

export type AuditAction =
  | "lock"
  | "unlock"
  | "session_expire"
  | "master_password_change";
export type AuditType = "file" | "folder" | "app" | "system";
export type AuditStatus = "success" | "failure";

export interface AuditEntry {
  timestamp: string; // ISO string
  id?: string; // LockedItem id
  type: AuditType;
  action: AuditAction;
  status: AuditStatus;
  itemName?: string;
  details?: string;
}

export class AuditLogger {
  private readonly logPath: string;

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  async log(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    const fullEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const line = JSON.stringify(fullEntry) + "\n";
    try {
      await fs.appendFile(this.logPath, line, "utf-8");
    } catch (err) {
      console.error("Failed to write to audit log:", err);
    }
  }

  async readLog(): Promise<AuditEntry[]> {
    try {
      const data = await fs.readFile(this.logPath, "utf-8");
      const lines = data.trim().split("\n").filter(Boolean);
      const entries = lines.map((l) => JSON.parse(l));
      return entries.reverse(); // Most recent first
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }
}
