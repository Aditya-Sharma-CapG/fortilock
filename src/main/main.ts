import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  globalShortcut,
  nativeImage,
  shell,
} from "electron";
import AutoLaunch from "auto-launch";
import path from "node:path";
import fs from "node:fs/promises";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { ConfigManager } from "../core/config";
import { Vault } from "../core/vault";
import { SessionManager } from "../core/session";
import { AuditLogger } from "../core/audit";
import { ProcessWatcher } from "../platform/win/watcher";
import {
  verifyPassword,
  unwrapVaultKey,
  deriveMasterKey,
  changeMasterPassword,
  hashPassword,
  wrapVaultKey,
  generateRandomBytes,
} from "../core/crypto";
import { lockFile, unlockFile } from "../core/fileLocker";
import { lockFolder, unlockFolder } from "../core/folderLocker";

const APP_DATA_DIR = path.join(app.getPath("userData"), "FortiLock");
const CONFIG_PATH = path.join(APP_DATA_DIR, "config.json");
const VAULT_PATH = path.join(APP_DATA_DIR, "vault.json");
const AUDIT_PATH = path.join(APP_DATA_DIR, "audit.jsonl");

let mainWindow: BrowserWindow | null = null;
let unlockWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// Global Singletons
let configManager: ConfigManager;
let vault: Vault;
let auditLogger: AuditLogger;
let sessionManager: SessionManager;
let watcher: ProcessWatcher;
let autoLauncher: AutoLaunch | null = null;

let currentVaultKey: Buffer | null = null;
let activePromptResolver:
  | ((result: "success" | "failure" | "ignored") => void)
  | null = null;
let activePromptItemId: string | null = null;

function createWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      devTools: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  // Disable opening DevTools by keyboard shortcuts
  mainWindow.webContents.on("before-input-event", (event, input) => {
    // Disable F12, Ctrl+Shift+I, Ctrl+Shift+C, Ctrl+Shift+J
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i") ||
      (input.control && input.shift && input.key.toLowerCase() === "c") ||
      (input.control && input.shift && input.key.toLowerCase() === "j")
    ) {
      event.preventDefault();
    }
  });

  // Forward renderer console logs to main process terminal
  mainWindow.webContents.on(
    "console-message",
    (event, level, message, line, sourceId) => {
      console.log(`[Renderer] ${message}`);
    },
  );

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

export function createUnlockWindow(itemId: string, label: string) {
  if (unlockWin) {
    unlockWin.removeAllListeners("closed");
    unlockWin.close();
    unlockWin = null;
  }

  unlockWin = new BrowserWindow({
    width: 400,
    height: 250,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
    },
  });

  unlockWin.loadFile(path.join(__dirname, "../renderer/unlock.html"), {
    search: `id=${encodeURIComponent(itemId)}&label=${encodeURIComponent(label)}`,
  });

  unlockWin.on("closed", () => {
    unlockWin = null;
    if (activePromptResolver) {
      activePromptResolver("failure");
      activePromptResolver = null;
      activePromptItemId = null;
    }
  });

  return unlockWin;
}

async function syncAutostart(enabled: boolean) {
  if (!autoLauncher) return;
  try {
    if (enabled) {
      await autoLauncher.enable();
    } else {
      await autoLauncher.disable();
    }
  } catch (err) {
    console.error("Failed to sync autostart setting:", err);
  }
}

async function deriveVaultKeyFromPassword(password: string): Promise<Buffer> {
  const vaultData = await vault.readVault();
  const verified = await verifyPassword(
    password,
    Buffer.from(vaultData.passwordHash, "hex"),
    Buffer.from(vaultData.passwordSalt, "hex"),
  );

  if (!verified) {
    throw new Error("Invalid password");
  }

  const masterKey = await deriveMasterKey(
    password,
    Buffer.from(vaultData.masterKeySalt, "hex"),
  );
  const vaultKey = unwrapVaultKey(masterKey, vaultData.wrappedVaultKey);
  masterKey.fill(0);
  return vaultKey;
}

async function createNewVault(
  password: string,
): Promise<{ vaultKey: Buffer; recoveryCodes: string[] }> {
  if (!password || typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const passwordSalt = generateRandomBytes(32);
  const masterKeySalt = generateRandomBytes(32);
  const passwordHashBuf = await hashPassword(password, passwordSalt);
  const passwordHash = passwordHashBuf.toString("hex");

  const vaultKeyBuffer = generateRandomBytes(32);
  const masterKey = await deriveMasterKey(password, masterKeySalt);
  const wrappedVaultKey = wrapVaultKey(masterKey, vaultKeyBuffer);
  masterKey.fill(0);

  // Recovery keys
  const recoverySalt = generateRandomBytes(32);
  const recoveryCodes: string[] = [];
  const recoveryEntries: any[] = [];
  for (let i = 0; i < 3; i++) {
    const codeBuf = generateRandomBytes(20);
    const code = codeBuf.toString("hex");
    recoveryCodes.push(code);
    // compute code hash for lookup (use scrypt via hashPassword)
    const codeHashBuf = await hashPassword(code, recoverySalt);
    const codeHash = codeHashBuf.toString("hex");

    // derive key from code to wrap vaultKey
    const derived = await deriveMasterKey(code, recoverySalt);
    const wrappedByCode = wrapVaultKey(derived, vaultKeyBuffer);
    derived.fill(0);

    recoveryEntries.push({
      id: randomUUID(),
      codeHash,
      used: false,
      createdAt: Date.now(),
      wrappedVaultKey: wrappedByCode,
    });
  }

  const vaultData: any = {
    passwordHash,
    passwordSalt: passwordSalt.toString("hex"),
    masterKeySalt: masterKeySalt.toString("hex"),
    wrappedVaultKey,
    items: [],
    recoverySalt: recoverySalt.toString("hex"),
    recoveryKeys: recoveryEntries,
  };

  await vault.writeVault(vaultData);
  return { vaultKey: vaultKeyBuffer, recoveryCodes };
}

async function failActivePrompt() {
  if (!activePromptResolver) return;
  activePromptResolver("failure");
  activePromptResolver = null;
  activePromptItemId = null;
}

async function getItemLabel(itemId: string): Promise<string> {
  try {
    const vaultData = await vault.readVault();
    const item = vaultData.items.find((i: any) => i.id === itemId);
    return item?.originalPath ? path.basename(item.originalPath) : itemId;
  } catch {
    return itemId;
  }
}

async function openUnlockPromptForItem(itemId: string) {
  const label = await getItemLabel(itemId);
  createUnlockWindow(itemId, label);
}

async function handleProcessWatcherPrompt(
  itemId: string,
): Promise<"success" | "failure" | "ignored"> {
  if (activePromptItemId === itemId) {
    return "ignored";
  }

  await failActivePrompt();
  activePromptItemId = itemId;
  return new Promise((resolve) => {
    activePromptResolver = resolve;
    openUnlockPromptForItem(itemId);
  });
}

function getAuditItemName(item: any) {
  if (item.originalPath) {
    return path.basename(item.originalPath);
  }
  return item.id || "Unknown";
}

async function unlockStoredItem(itemId: string, password: string) {
  const vaultData = await vault.readVault();
  const verified = await verifyPassword(
    password,
    Buffer.from(vaultData.passwordHash, "hex"),
    Buffer.from(vaultData.passwordSalt, "hex"),
  );

  if (!verified) {
    return { ok: false, error: "Invalid password" };
  }

  const masterKey = await deriveMasterKey(
    password,
    Buffer.from(vaultData.masterKeySalt, "hex"),
  );
  currentVaultKey = unwrapVaultKey(masterKey, vaultData.wrappedVaultKey);
  masterKey.fill(0);

  sessionManager.setVaultKey(currentVaultKey);

  const item = vaultData.items.find((i: any) => i.id === itemId);
  if (!item) {
    return { ok: false, error: "Item not found" };
  }

  // If the encrypted artifact has been deleted on disk, return a clear error
  if (item.alkPath) {
    try {
      await fs.access(item.alkPath as string);
    } catch {
      await auditLogger.log({
        id: item.id,
        type: item.type,
        action: "unlock",
        status: "failure",
        itemName: getAuditItemName(item),
        details: "Encrypted file missing",
      });
      return { ok: false, error: "Encrypted file missing" };
    }
  }

  sessionManager.addSession(item.id);

  if (item.type === "file" && item.alkPath) {
    await unlockFile(item.alkPath, item.originalPath, currentVaultKey);
    item.status = "unlocked";
  } else if (item.type === "folder" && item.alkPath) {
    await unlockFolder(item.alkPath, item.originalPath, currentVaultKey);
    item.status = "unlocked";
  } else if (item.type === "app") {
    item.status = "unlocked";
    await watcher.unlockApp(item.id);
  }

  await vault.writeVault(vaultData);
  await auditLogger.log({
    id: item.id,
    type: item.type,
    action: "unlock",
    status: "success",
    itemName: getAuditItemName(item),
    details: "Unlocked via dashboard prompt",
  });

  return { ok: true };
}

async function unlockStoredItems(password: string, itemIds?: string[] | null) {
  const vaultData = await vault.readVault();
  const verified = await verifyPassword(
    password,
    Buffer.from(vaultData.passwordHash, "hex"),
    Buffer.from(vaultData.passwordSalt, "hex"),
  );

  if (!verified) {
    return { ok: false, error: "Invalid password" };
  }

  const masterKey = await deriveMasterKey(
    password,
    Buffer.from(vaultData.masterKeySalt, "hex"),
  );
  currentVaultKey = unwrapVaultKey(masterKey, vaultData.wrappedVaultKey);
  masterKey.fill(0);

  sessionManager.setVaultKey(currentVaultKey);

  const items = vaultData.items.filter((item: any) =>
    !itemIds || itemIds.length === 0 ? true : itemIds.includes(item.id),
  );

  if (items.length === 0) {
    return { ok: false, error: "No items selected" };
  }

  let successCount = 0;
  for (const item of items) {
    const result = await attemptUnlockDashboardItem(item);
    if (result.success) {
      successCount += 1;
    }
  }

  await vault.writeVault(vaultData);
  return {
    ok: successCount > 0,
    error: successCount > 0 ? undefined : "Failed to unlock selected items",
  };
}

async function attemptUnlockDashboardItem(item: any) {
  const itemName = getAuditItemName(item);
  const wasUnlocked = item.status === "unlocked";

  try {
    if (item.alkPath) {
      await fs.access(item.alkPath as string);
    }

    await unlockDashboardItem(item, wasUnlocked);

    sessionManager.addSession(item.id);
    await auditLogger.log({
      id: item.id,
      type: item.type,
      action: "unlock",
      status: "success",
      itemName,
      details: wasUnlocked
        ? "Already unlocked"
        : "Unlocked via dashboard prompt",
    });

    return { success: true };
  } catch (error: any) {
    await auditLogger.log({
      id: item.id,
      type: item.type,
      action: "unlock",
      status: "failure",
      itemName,
      details: error instanceof Error ? error.message : String(error),
    });
    return { success: false };
  }
}

async function unlockDashboardItem(item: any, wasUnlocked: boolean) {
  const vaultKey = currentVaultKey;
  if (!vaultKey) {
    throw new Error("Vault key unavailable");
  }

  if (item.type === "file" && item.alkPath && !wasUnlocked) {
    await unlockFile(item.alkPath, item.originalPath, vaultKey);
    item.status = "unlocked";
  } else if (item.type === "folder" && item.alkPath && !wasUnlocked) {
    await unlockFolder(item.alkPath, item.originalPath, vaultKey);
    item.status = "unlocked";
  } else if (item.type === "app" && !wasUnlocked) {
    await watcher.unlockApp(item.id);
    item.status = "unlocked";
  }
}

async function completePromptSuccess(itemId: string) {
  if (activePromptResolver && activePromptItemId === itemId) {
    activePromptResolver("success");
    activePromptResolver = null;
    activePromptItemId = null;
  }

  if (unlockWin) {
    unlockWin.close();
  }
}

async function removeVaultItemByPassword(itemId: string, password: string) {
  const vaultData = await vault.readVault();
  const verified = await verifyPassword(
    password,
    Buffer.from(vaultData.passwordHash, "hex"),
    Buffer.from(vaultData.passwordSalt, "hex"),
  );

  if (!verified) {
    await auditLogger.log({
      id: itemId,
      type: "system",
      action: "unlock",
      status: "failure",
      details: "Invalid password for item removal",
    });
    return { ok: false, error: "Invalid password" };
  }

  const itemIndex = vaultData.items.findIndex((i: any) => i.id === itemId);
  if (itemIndex === -1) {
    return { ok: false, error: "Item not found" };
  }

  const item = vaultData.items[itemIndex]!;
  const itemType = item.type;
  sessionManager.removeSession(itemId);

  vaultData.items.splice(itemIndex, 1);
  await vault.writeVault(vaultData);
  await auditLogger.log({
    id: itemId,
    type: itemType,
    action: "unlock",
    status: "success",
    details: "Item removed because encrypted artifact was missing",
  });

  return { ok: true };
}

// Suppress non-fatal Electron warnings
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-dev-shm-usage");
app.setAppUserModelId("com.fortilock.app");

app.whenReady().then(async () => {
  // 1. Initialize Paths & Config
  await fs.mkdir(APP_DATA_DIR, { recursive: true });

  configManager = new ConfigManager(CONFIG_PATH);
  await configManager.load();
  const config = configManager.config;

  // 2. Initialize Core Modules
  vault = new Vault(VAULT_PATH);
  auditLogger = new AuditLogger(AUDIT_PATH);
  sessionManager = new SessionManager(
    vault,
    auditLogger,
    config.idleTimeoutMinutes,
  );

  autoLauncher = new AutoLaunch({
    name: "FortiLock",
    path: app.getPath("exe"),
  });
  await syncAutostart(config.autostartEnabled);

  // 3. Initialize Process Watcher
  watcher = new ProcessWatcher(
    config,
    app.getPath("exe"),
    vault,
    sessionManager,
  );

  watcher.onPrompt = handleProcessWatcherPrompt;

  sessionManager.start();
  watcher.start();

  createWindow();

  // 4. Tray Icon Setup
  const trayIconCandidates = [
    path.join(__dirname, "../../assets/icon.png"),
    path.join(process.resourcesPath, "assets", "icon.png"),
  ];

  let trayIconPath: string | null = null;
  for (const candidate of trayIconCandidates) {
    try {
      await fs.access(candidate);
      trayIconPath = candidate;
      break;
    } catch {
      // ignore missing candidate
    }
  }

  if (trayIconPath) {
    tray = new Tray(trayIconPath);
  } else {
    console.warn("Tray icon not found in expected paths", trayIconCandidates);
    tray = new Tray(nativeImage.createEmpty());
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => createWindow() },
    {
      label: "Lock All Now",
      click: async () => {
        // Require master password before locking all items
        createUnlockWindow("__lock_all__", "All Items");
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("FortiLock");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => createWindow());

  // 5. Global Hotkey Setup
  if (config.globalHotkey) {
    globalShortcut.register(config.globalHotkey, async () => {
      // Require master password via unlock prompt for lock-all
      createUnlockWindow("__lock_all__", "All Items");
    });
  }

  // 6. IPC Handlers
  ipcMain.handle("submit-unlock-password", async (_, password, itemId) => {
    return handleSubmitUnlockPassword(itemId, password);
  });

  async function handleLockAll(password: string) {
    try {
      await deriveVaultKeyFromPassword(password);
    } catch {
      await auditLogger.log({
        type: "system",
        action: "lock",
        status: "failure",
        details: "Lock-all: invalid password",
      });
      return { ok: false, error: "Invalid password" };
    }

    await sessionManager.lockAllNow();
    await completePromptSuccess("__lock_all__");
    await auditLogger.log({
      type: "system",
      action: "lock",
      status: "success",
      details: "Lock-all executed",
    });
    return { ok: true };
  }

  async function handleSubmitUnlockPassword(itemId: string, password: string) {
    try {
      if (itemId === "__lock_all__") {
        return await handleLockAll(password);
      }

      const result = await unlockStoredItem(itemId, password);
      if (result.ok) {
        await completePromptSuccess(itemId);
        return { ok: true };
      }

      if (result.error === "Encrypted file missing") {
        const removalResult = await removeVaultItemByPassword(itemId, password);
        if (removalResult.ok) {
          await completePromptSuccess(itemId);
          return { ok: true };
        }

        await auditLogger.log({
          type: "system",
          action: "unlock",
          status: "failure",
          details: removalResult.error || "Invalid password",
        });
        return { ok: false, error: removalResult.error || "Invalid password" };
      }

      await auditLogger.log({
        type: "system",
        action: "unlock",
        status: "failure",
        details: result.error || "Invalid password",
      });
      return { ok: false, error: result.error || "Invalid password" };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: e?.message || "Unknown error" };
    }
  }

  ipcMain.handle("create-vault", async (_, password) => {
    try {
      if (!password || typeof password !== "string" || password.length < 8) {
        return { ok: false, error: "Password must be at least 8 characters" };
      }

      try {
        await vault.readVault();
        return { ok: false, error: "Vault already exists" };
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }

      const { vaultKey, recoveryCodes } = await createNewVault(password);
      currentVaultKey = vaultKey;
      sessionManager.setVaultKey(currentVaultKey);
      return { ok: true, recoveryCodes };
    } catch (err: any) {
      console.error(err);
      return { ok: false, error: err.message || "Failed to create vault" };
    }
  });

  ipcMain.handle("unlock-vault", async (_, password) => {
    try {
      const vaultKey = await deriveVaultKeyFromPassword(password);
      currentVaultKey = vaultKey;
      sessionManager.setVaultKey(currentVaultKey);
      return { ok: true };
    } catch (err: any) {
      console.error("Vault unlock failed", err);
      return { ok: false, error: err?.message || "Invalid password" };
    }
  });

  ipcMain.handle("redeem-recovery-code", async (_, code: string) => {
    try {
      const vaultData: any = await vault.readVault();
      if (!vaultData.recoverySalt || !Array.isArray(vaultData.recoveryKeys)) {
        return { ok: false, error: "No recovery configured" };
      }

      const recoverySalt = Buffer.from(vaultData.recoverySalt, "hex");
      const codeHashBuf = await hashPassword(code, recoverySalt);
      const codeHash = codeHashBuf.toString("hex");

      const idx = vaultData.recoveryKeys.findIndex(
        (k: any) => k.codeHash === codeHash && !k.used,
      );
      if (idx === -1)
        return { ok: false, error: "Invalid or already used recovery code" };

      const entry = vaultData.recoveryKeys[idx];
      const derived = await deriveMasterKey(code, recoverySalt);
      const unwrappedVaultKey = unwrapVaultKey(derived, entry.wrappedVaultKey);
      derived.fill(0);

      currentVaultKey = unwrappedVaultKey;
      sessionManager.setVaultKey(currentVaultKey);

      // mark used
      vaultData.recoveryKeys[idx].used = true;
      await vault.writeVault(vaultData);

      return { ok: true };
    } catch (e: any) {
      console.error("Recovery redeem failed", e);
      return { ok: false, error: e.message || "Recovery failed" };
    }
  });

  ipcMain.handle("regenerate-recovery-keys", async (_, password) => {
    try {
      const vaultData: any = await vault.readVault();
      // verify password
      const verified = await verifyPassword(
        password,
        Buffer.from(vaultData.passwordHash, "hex"),
        Buffer.from(vaultData.passwordSalt, "hex"),
      );
      if (!verified) return { ok: false, error: "Invalid password" };

      // obtain vaultKey
      const masterKey = await deriveMasterKey(
        password,
        Buffer.from(vaultData.masterKeySalt, "hex"),
      );
      const vaultKeyBuf = unwrapVaultKey(masterKey, vaultData.wrappedVaultKey);
      masterKey.fill(0);

      // generate new recovery set
      const recoverySalt = generateRandomBytes(32);
      const recoveryCodes: string[] = [];
      const recoveryEntries: any[] = [];
      for (let i = 0; i < 3; i++) {
        const codeBuf = generateRandomBytes(20);
        const code = codeBuf.toString("hex");
        recoveryCodes.push(code);
        const codeHashBuf = await hashPassword(code, recoverySalt);
        const codeHash = codeHashBuf.toString("hex");
        const derived = await deriveMasterKey(code, recoverySalt);
        const wrappedByCode = wrapVaultKey(derived, vaultKeyBuf);
        derived.fill(0);
        recoveryEntries.push({
          id: randomUUID(),
          codeHash,
          used: false,
          createdAt: Date.now(),
          wrappedVaultKey: wrappedByCode,
        });
      }

      vaultData.recoverySalt = recoverySalt.toString("hex");
      vaultData.recoveryKeys = recoveryEntries;
      await vault.writeVault(vaultData);

      return { ok: true, recoveryCodes };
    } catch (e: any) {
      console.error("Regenerate recovery failed", e);
      return { ok: false, error: e.message || "Failed to regenerate" };
    }
  });

  ipcMain.handle("dialog:openApp", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Applications", extensions: ["exe"] }],
    });
    if (!canceled && filePaths.length > 0) {
      return filePaths[0];
    }
    return null;
  });

  ipcMain.handle("add-app", async (_, exePath) => {
    if (!exePath || typeof exePath !== "string") {
      return { ok: false, error: "No application selected" };
    }

    try {
      const vaultData = await vault.readVault();
      if (
        vaultData.items.some(
          (item: any) =>
            item.type === "app" &&
            item.originalPath.toLowerCase() === exePath.toLowerCase(),
        )
      ) {
        return { ok: false, error: "Application already locked" };
      }

      const appItem = await watcher.addToWatchList(exePath);
      return { ok: true, id: appItem.id };
    } catch (err: any) {
      return { ok: false, error: err.message || "Failed to lock app" };
    }
  });

  ipcMain.handle("add-file", async (_, filePath) => {
    if (!currentVaultKey) {
      return { ok: false, error: "Vault is locked" };
    }

    try {
      const vaultData = await vault.readVault();
      if (
        vaultData.items.some(
          (item) => item.originalPath.toLowerCase() === filePath.toLowerCase(),
        )
      ) {
        return { ok: false, error: "Item already exists" };
      }

      const alkPath = await lockFile(filePath, currentVaultKey);
      const id = randomUUID();
      vaultData.items.push({
        id,
        type: "file",
        originalPath: filePath,
        alkPath,
        status: "locked",
      });
      await vault.writeVault(vaultData);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || "Failed to lock file" };
    }
  });

  ipcMain.handle("add-folder", async (_, folderPath) => {
    if (!currentVaultKey) {
      return { ok: false, error: "Vault is locked" };
    }

    try {
      const vaultData = await vault.readVault();
      if (
        vaultData.items.some(
          (item) =>
            item.originalPath.toLowerCase() === folderPath.toLowerCase(),
        )
      ) {
        return { ok: false, error: "Item already exists" };
      }

      const alkPath = await lockFolder(folderPath, currentVaultKey);
      const id = randomUUID();
      vaultData.items.push({
        id,
        type: "folder",
        originalPath: folderPath,
        alkPath,
        status: "locked",
      });
      await vault.writeVault(vaultData);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message || "Failed to lock folder" };
    }
  });

  ipcMain.handle("unlock-item", async (_, itemId) => {
    try {
      await failActivePrompt();
      activePromptItemId = itemId;
      await openUnlockPromptForItem(itemId);
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  });

  ipcMain.handle("lock-all-now", async (_, selectedIds?: string[]) => {
    try {
      await sessionManager.lockAllNow(selectedIds);
      return true;
    } catch (err) {
      console.error(err);
      return false;
    }
  });

  ipcMain.handle(
    "unlock-all-now",
    async (_, password: string, selectedIds?: string[]) => {
      try {
        return await unlockStoredItems(password, selectedIds);
      } catch (err) {
        console.error(err);
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message || "Failed to unlock items" };
      }
    },
  );

  ipcMain.handle("dialog:openFile", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (!canceled && filePaths.length > 0) {
      return filePaths[0];
    }
    return null;
  });

  ipcMain.handle("dialog:openDirectory", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (!canceled && filePaths.length > 0) {
      return filePaths[0];
    }
    return null;
  });

  const isAccessible = async (item: any): Promise<boolean> => {
    try {
      if (item.type === "app") {
        await fs.access(item.originalPath);
        return true;
      }

      if ((item.type === "file" || item.type === "folder") && item.alkPath) {
        await fs.access(item.alkPath);
        return true;
      }

      return false;
    } catch {
      return false;
    }
  };

  ipcMain.handle("get-dashboard-data", async () => {
    try {
      const vaultData = await vault.readVault();
      return {
        config: configManager.config,
        vaultExists: true,
        vaultUnlocked: currentVaultKey !== null,
        items: await Promise.all(
          vaultData.items.map(async (item: any) => {
            const expiry = sessionManager.getSessionExpiry(item.id);
            const missing = !(await isAccessible(item));
            return {
              ...item,
              expiresAt: expiry,
              missing,
            };
          }),
        ),
      };
    } catch {
      return {
        config: configManager.config,
        vaultExists: false,
        vaultUnlocked: false,
        items: [],
      };
    }
  });

  ipcMain.handle(
    "set-item-auto-lock",
    async (_, itemId: string, preventAutoLock: boolean) => {
      try {
        const vaultData = await vault.readVault();
        const item = vaultData.items.find((i: any) => i.id === itemId);
        if (!item) {
          return { ok: false, error: "Item not found" };
        }

        item.preventAutoLock = preventAutoLock;
        await vault.writeVault(vaultData);
        return { ok: true };
      } catch (err: any) {
        console.error("Failed to update item auto-lock setting:", err);
        return { ok: false, error: err?.message || "Failed to update setting" };
      }
    },
  );

  ipcMain.handle("save-config", async (_, newConfig) => {
    const oldHotkey = configManager.config.globalHotkey;
    await configManager.save(newConfig);

    await syncAutostart(
      newConfig.autostartEnabled ?? configManager.config.autostartEnabled,
    );

    // Refresh hotkey
    if (oldHotkey !== newConfig.globalHotkey) {
      if (oldHotkey) globalShortcut.unregister(oldHotkey);
      if (newConfig.globalHotkey) {
        try {
          globalShortcut.register(newConfig.globalHotkey, async () => {
            await sessionManager.lockAllNow();
          });
        } catch (e) {
          console.error("Failed to register hotkey", e);
        }
      }
    }
    return true;
  });

  ipcMain.handle("get-audit-logs", async () => {
    try {
      const content = await fs.readFile(AUDIT_PATH, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim().length > 0);
      return lines.map((l) => JSON.parse(l)).reverse(); // Most recent first
    } catch {
      return [];
    }
  });

  ipcMain.handle("get-app-version", () => {
    return app.getVersion();
  });

  const compareVersions = (a: string, b: string): number => {
    const parse = (value: string) =>
      value
        .replace(/^v/, "")
        .split(".")
        .map((part) => Number(part) || 0);

    const aParts = parse(a);
    const bParts = parse(b);
    const len = Math.max(aParts.length, bParts.length);

    for (let i = 0; i < len; i++) {
      const aNum = aParts[i] ?? 0;
      const bNum = bParts[i] ?? 0;
      if (aNum > bNum) return 1;
      if (aNum < bNum) return -1;
    }
    return 0;
  };

  const parseReleaseResponse = (
    res: import("node:http").IncomingMessage,
    data: string,
    resolve: (value: { tagName: string; htmlUrl: string }) => void,
    reject: (reason?: any) => void,
  ) => {
    if (res.statusCode !== 200) {
      reject(new Error(`GitHub release check failed: ${res.statusCode}`));
      return;
    }

    let json;
    try {
      json = JSON.parse(data);
    } catch (error) {
      reject(error);
      return;
    }

    if (!json.tag_name || !json.html_url) {
      reject(new Error("Invalid release response"));
      return;
    }

    resolve({ tagName: json.tag_name, htmlUrl: json.html_url });
  };

  const fetchLatestReleaseInfo = async (): Promise<{
    tagName: string;
    htmlUrl: string;
  }> => {
    let data = "";

    const handleReleaseData = (
      chunk: import("node:buffer").Buffer | string,
    ) => {
      data += chunk;
    };

    const handleReleaseEnd = (
      res: import("node:http").IncomingMessage,
      resolve: (value: { tagName: string; htmlUrl: string }) => void,
      reject: (reason?: any) => void,
    ) => {
      parseReleaseResponse(res, data, resolve, reject);
    };

    return new Promise((resolve, reject) => {
      const req = https.get(
        "https://api.github.com/repos/Aditya-Sharma-CapG/fortilock/releases/latest",
        {
          headers: {
            "User-Agent": "FortiLock",
            Accept: "application/vnd.github.v3+json",
          },
        },
        (res) => {
          res.on("data", handleReleaseData);
          res.on("end", handleReleaseEnd.bind(null, res, resolve, reject));
        },
      );
      req.on("error", reject);
    });
  };

  ipcMain.handle("check-for-updates", async () => {
    try {
      const currentVersion = app.getVersion();
      const latest = await fetchLatestReleaseInfo();
      const latestVersion = latest.tagName.replace(/^v/, "");
      const updateAvailable =
        compareVersions(latestVersion, currentVersion) === 1;

      if (updateAvailable) {
        shell.openExternal(latest.htmlUrl);
      }

      return {
        ok: true,
        updateAvailable,
        currentVersion,
        latestVersion,
        releaseUrl: latest.htmlUrl,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || "Failed to check updates" };
    }
  });

  ipcMain.handle("change-password", async (_, currentPassword, newPassword) => {
    try {
      const vaultData = await vault.readVault();
      const verified = await verifyPassword(
        currentPassword,
        Buffer.from(vaultData.passwordHash, "hex"),
        Buffer.from(vaultData.passwordSalt, "hex"),
      );
      if (!verified) return false;

      const masterKey = await deriveMasterKey(
        currentPassword,
        Buffer.from(vaultData.masterKeySalt, "hex"),
      );
      const unwrappedVaultKey = unwrapVaultKey(
        masterKey,
        vaultData.wrappedVaultKey,
      );
      masterKey.fill(0);

      const updatedFields = await changeMasterPassword(
        newPassword,
        unwrappedVaultKey,
      );

      Object.assign(vaultData, updatedFields);
      await vault.writeVault(vaultData);

      // Update in-memory vault key for active sessions
      if (currentVaultKey) {
        currentVaultKey.fill(0);
      }
      currentVaultKey = unwrappedVaultKey;
      sessionManager.setVaultKey(currentVaultKey);

      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  });

  ipcMain.handle("reset-password", async (_, newPassword) => {
    try {
      if (!currentVaultKey) {
        return { ok: false, error: "Vault is not unlocked" };
      }

      const updatedFields = await changeMasterPassword(
        newPassword,
        currentVaultKey,
      );
      const vaultData = await vault.readVault();
      Object.assign(vaultData, updatedFields);
      await vault.writeVault(vaultData);
      return { ok: true };
    } catch (e: any) {
      console.error("Password reset after recovery failed", e);
      return { ok: false, error: e.message || "Failed to reset password" };
    }
  });

  ipcMain.handle("lock-item", async (_, itemId) => {
    try {
      if (!currentVaultKey) {
        throw new Error(
          "No vault key in memory — please unlock the vault first.",
        );
      }

      const vaultData = await vault.readVault();
      const item = vaultData.items.find((i) => i.id === itemId);
      if (!item) return false;

      sessionManager.removeSession(itemId);
      if (item.type === "file") {
        const alkPath = await lockFile(item.originalPath, currentVaultKey);
        item.status = "locked";
        item.alkPath = alkPath;
      } else if (item.type === "folder") {
        const alkPath = await lockFolder(item.originalPath, currentVaultKey);
        item.status = "locked";
        item.alkPath = alkPath;
      } else if (item.type === "app") {
        item.status = "locked";
      }
      await vault.writeVault(vaultData);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle(
    "remove-item-by-password",
    async (_, itemId: string, password: string) => {
      try {
        // Verify password
        const vaultData = await vault.readVault();
        const verified = await verifyPassword(
          password,
          Buffer.from(vaultData.passwordHash, "hex"),
          Buffer.from(vaultData.passwordSalt, "hex"),
        );

        if (!verified) {
          await auditLogger.log({
            id: itemId,
            type: "system",
            action: "unlock",
            status: "failure",
            details: "Invalid password for item removal",
          });
          return { ok: false, error: "Invalid password" };
        }

        // Find and remove item
        const itemIdx = vaultData.items.findIndex((i) => i.id === itemId);
        if (itemIdx === -1) {
          return { ok: false, error: "Item not found" };
        }

        const item = vaultData.items[itemIdx]!;
        const itemType = item.type;
        sessionManager.removeSession(itemId);

        // Audit log before removal
        await auditLogger.log({
          id: itemId,
          type: itemType,
          action: "unlock",
          status: "success",
          details: "Item removed due to missing encrypted file",
        });

        // Remove item from vault
        vaultData.items.splice(itemIdx, 1);
        await vault.writeVault(vaultData);

        return { ok: true };
      } catch (e: any) {
        console.error("Failed to remove item by password:", e);
        return { ok: false, error: e.message || "Failed to remove item" };
      }
    },
  );

  app.on("activate", () => {
    createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  sessionManager?.stop();
  watcher?.stop();
  sessionManager?.clearVaultKey();
});
