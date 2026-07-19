import psList from "ps-list";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { AppConfig } from "../../core/config";
import { randomUUID } from "node:crypto";
import { Vault } from "../../core/vault";
import { SessionManager } from "../../core/session";

const execFileAsync = promisify(execFile);

export interface WatchedApp {
  id: string; // matches LockedItem ID
  resolvedPath: string;
  failedAttempts: number;
  nextAttemptAllowedAt: number; // monotonic time
  isBroken: boolean;
}

const HARD_BLOCKLIST = new Set([
  "explorer.exe",
  "csrss.exe",
  "winlogon.exe",
  "wininit.exe",
  "services.exe",
  "lsass.exe",
  "smss.exe",
  "svchost.exe",
]);

export class ProcessWatcher {
  private readonly config: AppConfig;
  private timer: NodeJS.Timeout | null = null;
  public watchedApps: Map<string, WatchedApp> = new Map();
  private readonly graceList: Map<string, number> = new Map(); // path -> expiresAt (monotonic)
  private readonly promptCooldownMs = 60_000;
  private readonly missingPromptCooldown: Map<string, number> = new Map();
  private readonly installDir: string;
  private readonly vault: Vault;
  private readonly sessionManager?: SessionManager;
  public onPrompt?: (
    itemId: string,
  ) => Promise<"success" | "failure" | "ignored">;

  constructor(
    config: AppConfig,
    installDir: string,
    vault: Vault,
    sessionManager?: SessionManager,
  ) {
    this.config = config;
    this.installDir = path.resolve(installDir).toLowerCase();
    this.vault = vault;
    if (sessionManager) {
      this.sessionManager = sessionManager;
    }
  }

  async addToWatchList(exePath: string, id?: string): Promise<WatchedApp> {
    let resolvedPath: string;
    try {
      resolvedPath = await fs.realpath(path.resolve(exePath));
    } catch {
      throw new Error(
        `Executable path does not exist: ${path.resolve(exePath)}`,
      );
    }

    const lowerPath = resolvedPath.toLowerCase();
    const basename = path.basename(lowerPath);

    if (HARD_BLOCKLIST.has(basename)) {
      throw new Error(`Cannot lock critical system process: ${basename}`);
    }

    if (lowerPath.startsWith(this.installDir)) {
      throw new Error("Cannot lock FortiLock own directories.");
    }

    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      throw new Error("Path is not a file");
    }

    const data = await this.vault.readVault();
    const appAlreadyLocked = data.items.some(
      (item: any) =>
        item.type === "app" &&
        item.originalPath.toLowerCase() === lowerPath,
    );
    if (appAlreadyLocked) {
      throw new Error("Application already locked");
    }

    const app: WatchedApp = {
      id: id || randomUUID(),
      resolvedPath,
      failedAttempts: 0,
      nextAttemptAllowedAt: 0,
      isBroken: false,
    };

    data.items.push({
      id: app.id,
      type: "app",
      originalPath: app.resolvedPath,
      alkPath: "",
      status: "locked",
    });
    await this.vault.writeVault(data);

    this.watchedApps.set(app.id, app);
    return app;
  }

  async start() {
    if (this.timer) return;

    try {
      const data = await this.vault.readVault();
      for (const item of data.items) {
        if (item.type === "app") {
          this.watchedApps.set(item.id, {
            id: item.id,
            resolvedPath: item.originalPath,
            failedAttempts: 0,
            nextAttemptAllowedAt: 0,
            isBroken: false,
          });
        }
      }
    } catch (e) {
      console.warn("Could not load initial apps from vault", e);
    }

    this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async getFullPathsForPids(
    pids: number[],
  ): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    if (pids.length === 0) return map;

    try {
      // PowerShell script to get exact paths efficiently
      const pidList = pids.join(",");
      const script = `Get-Process -Id ${pidList} -ErrorAction SilentlyContinue | Select-Object Id, Path | ConvertTo-Json -Compress`;
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile",
        "-Command",
        script,
      ]);

      if (!stdout.trim()) return map;

      const parsed = JSON.parse(stdout);
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (item.Id && item.Path) {
          try {
            const realPath = await fs.realpath(item.Path);
            map.set(item.Id, realPath);
          } catch {
            map.set(item.Id, item.Path);
          }
        }
      }
    } catch {
      // Ignore if powershell fails or process exited
    }
    return map;
  }

  private async checkBrokenApps() {
    for (const app of this.watchedApps.values()) {
      if (!app.isBroken) {
        try {
          await fs.access(app.resolvedPath);
        } catch {
          app.isBroken = true;
        }
      }
    }
  }

  private async isAccessible(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async isMissingLockedItem(item: any): Promise<boolean> {
    if (item?.status !== "locked") return false;

    if (item.type === "app") {
      return (
        Boolean(item.originalPath) &&
        !(await this.isAccessible(item.originalPath))
      );
    }

    if ((item.type === "file" || item.type === "folder") && item.alkPath) {
      return !(await this.isAccessible(item.alkPath));
    }

    return false;
  }

  private async collectMissingLockedItems(): Promise<string[]> {
    const missingIds: string[] = [];
    try {
      const vaultData: any = await this.vault.readVault();
      for (const item of vaultData.items ?? []) {
        if (await this.isMissingLockedItem(item)) {
          missingIds.push(item.id);
        }
      }
    } catch (err) {
      console.error("Missing artifact scan failed:", err);
    }
    return missingIds;
  }

  private canPromptForMissingItem(itemId: string, now: number): boolean {
    const nextAllowedAt = this.missingPromptCooldown.get(itemId) || 0;
    if (now < nextAllowedAt) return false;
    this.missingPromptCooldown.set(itemId, now + this.promptCooldownMs);
    return true;
  }

  private async handleMissingItemPrompts(missedItemIds: string[], now: number) {
    if (!this.onPrompt) return;

    for (const itemId of missedItemIds) {
      if (!this.canPromptForMissingItem(itemId, now)) continue;
      try {
        const result = await this.onPrompt(itemId);
        if (result === "success") {
          this.watchedApps.delete(itemId);
        }
      } catch (err) {
        console.error("Missing item prompt failed:", err);
      }
    }
  }

  private killProcesses(toKill: Map<string, number[]>) {
    for (const pids of toKill.values()) {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (e) {
          console.debug("Process already dead:", e);
        }
      }
    }
  }

  private async launchApp(app: WatchedApp) {
    app.failedAttempts = 0;
    app.nextAttemptAllowedAt = 0;

    try {
      const child = spawn(app.resolvedPath, [], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      const lowerPath = app.resolvedPath.toLowerCase();
      this.graceList.set(
        lowerPath,
        performance.now() + this.config.gracePeriodMs,
      );
    } catch {
      app.isBroken = true;
    }
  }

  public async unlockApp(itemId: string) {
    const app = this.watchedApps.get(itemId);
    if (!app || app.isBroken) return;
    await this.launchApp(app);
  }

  private async handlePromptSuccess(app: WatchedApp) {
    await this.launchApp(app);
  }

  public handlePromptFailure(app: WatchedApp) {
    app.failedAttempts++;
    let backoffS = 0;
    if (app.failedAttempts >= 5) {
      backoffS = Math.min(300, 30 * Math.pow(2, app.failedAttempts - 5));
    }
    app.nextAttemptAllowedAt = performance.now() + backoffS * 1000;
  }

  private async handlePrompts(matchedApps: Set<WatchedApp>, now: number) {
    for (const app of matchedApps) {
      if (now < app.nextAttemptAllowedAt) continue;

      if (this.onPrompt) {
        const result = await this.onPrompt(app.id);
        if (result === "success") {
          this.handlePromptSuccess(app);
        } else if (result === "failure") {
          this.handlePromptFailure(app);
        }
      }
    }
  }

  private async getCandidatePids(): Promise<number[]> {
    const processes = await psList();
    const watchedNames = new Set(
      Array.from(this.watchedApps.values())
        .filter((a) => !a.isBroken)
        .map((a) => path.basename(a.resolvedPath.toLowerCase())),
    );

    return processes
      .filter((p) => watchedNames.has(p.name.toLowerCase()))
      .map((p) => p.pid);
  }

  private shouldKillApp(
    app: WatchedApp,
    lowerPath: string,
    now: number,
  ): boolean {
    if (app.isBroken || app.resolvedPath.toLowerCase() !== lowerPath) {
      return false;
    }

    if (this.sessionManager?.hasSession(app.id)) {
      return false;
    }

    const graceExpiry = this.graceList.get(lowerPath);
    if (graceExpiry && now < graceExpiry) {
      return false;
    }

    return true;
  }

  private matchCandidates(
    candidatePids: number[],
    pathsMap: Map<number, string>,
  ) {
    const now = performance.now();
    const toKill = new Map<string, number[]>();
    const matchedApps = new Set<WatchedApp>();

    for (const pid of candidatePids) {
      const fullPath = pathsMap.get(pid);
      if (!fullPath) continue;

      const lowerPath = fullPath.toLowerCase();

      for (const app of this.watchedApps.values()) {
        if (this.shouldKillApp(app, lowerPath, now)) {
          if (!toKill.has(lowerPath)) toKill.set(lowerPath, []);
          toKill.get(lowerPath)!.push(pid);
          matchedApps.add(app);
        }
      }
    }

    return { toKill, matchedApps, now };
  }

  async poll() {
    if (this.watchedApps.size === 0) return;

    await this.checkBrokenApps();

    try {
      const missingIds = await this.collectMissingLockedItems();
      await this.handleMissingItemPrompts(missingIds, performance.now());

      const candidatePids = await this.getCandidatePids();
      if (candidatePids.length === 0) return;

      const pathsMap = await this.getFullPathsForPids(candidatePids);
      const { toKill, matchedApps, now } = this.matchCandidates(
        candidatePids,
        pathsMap,
      );

      this.killProcesses(toKill);
      await this.handlePrompts(matchedApps, now);
    } catch (err) {
      console.error("Polling error:", err);
    }
  }
}
