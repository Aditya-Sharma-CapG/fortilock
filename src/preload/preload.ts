import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("fortilock", {
  openFile: () => ipcRenderer.invoke("dialog:openFile"),
  openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  openApp: () => ipcRenderer.invoke("dialog:openApp"),
  submitUnlockPassword: (password: string, itemId: string) =>
    ipcRenderer.invoke("submit-unlock-password", password, itemId),
  createVault: (password: string) =>
    ipcRenderer.invoke("create-vault", password),
  unlockVault: (password: string) =>
    ipcRenderer.invoke("unlock-vault", password),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  addFile: (filePath: string) => ipcRenderer.invoke("add-file", filePath),
  addFolder: (folderPath: string) =>
    ipcRenderer.invoke("add-folder", folderPath),
  addApp: (exePath: string) => ipcRenderer.invoke("add-app", exePath),
  unlockItem: (id: string) => ipcRenderer.invoke("unlock-item", id),
  lockAllNow: (selectedIds?: string[]) =>
    ipcRenderer.invoke("lock-all-now", selectedIds),
  unlockAllNow: (password: string, selectedIds?: string[]) =>
    ipcRenderer.invoke("unlock-all-now", password, selectedIds),
  setItemAutoLock: (itemId: string, preventAutoLock: boolean) =>
    ipcRenderer.invoke("set-item-auto-lock", itemId, preventAutoLock),
  getDashboardData: () => ipcRenderer.invoke("get-dashboard-data"),
  saveConfig: (config: any) => ipcRenderer.invoke("save-config", config),
  getAuditLogs: () => ipcRenderer.invoke("get-audit-logs"),
  changePassword: (currentP: string, newP: string) =>
    ipcRenderer.invoke("change-password", currentP, newP),
  resetPassword: (newPassword: string) =>
    ipcRenderer.invoke("reset-password", newPassword),
  lockItem: (id: string) => ipcRenderer.invoke("lock-item", id),
  redeemRecoveryCode: (code: string) =>
    ipcRenderer.invoke("redeem-recovery-code", code),
  regenerateRecoveryKeys: (password: string) =>
    ipcRenderer.invoke("regenerate-recovery-keys", password),
  removeItemByPassword: (itemId: string, password: string) =>
    ipcRenderer.invoke("remove-item-by-password", itemId, password),
});
