// src/core/config.ts

// This file contains the application configuration settings.

import fs from "node:fs/promises";

export interface AppConfig {
  pollIntervalMs: number;
  gracePeriodMs: number;
  idleTimeoutMinutes: number;
  autostartEnabled: boolean;
  globalHotkey: string;
}

export const defaultConfig: AppConfig = {
  pollIntervalMs: 1000,
  gracePeriodMs: 5000,
  idleTimeoutMinutes: 15,
  autostartEnabled: false,
  globalHotkey: "CommandOrControl+Alt+L",
};

export class ConfigManager {
  private readonly configPath: string;
  private currentConfig: AppConfig;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.currentConfig = { ...defaultConfig };
  }

  async load(): Promise<AppConfig> {
    try {
      const data = await fs.readFile(this.configPath, "utf-8");
      const parsed = JSON.parse(data);
      this.currentConfig = { ...defaultConfig, ...parsed };
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.warn("Failed to load config, using defaults:", err);
      }
      this.currentConfig = { ...defaultConfig };
    }
    return this.currentConfig;
  }

  async save(newConfig: Partial<AppConfig>): Promise<void> {
    this.currentConfig = { ...this.currentConfig, ...newConfig };
    const tempPath = `${this.configPath}.tmp`;
    await fs.writeFile(
      tempPath,
      JSON.stringify(this.currentConfig, null, 2),
      "utf-8",
    );
    await fs.rename(tempPath, this.configPath);
  }

  get config(): AppConfig {
    return this.currentConfig;
  }
}
