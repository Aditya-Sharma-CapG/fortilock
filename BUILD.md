# FortiLock Build Guide

## For End Users

If someone gave you `FortiLock-Setup.exe`:

1. **Download** the exe file to your computer
2. **Double-click** it to run
3. **Follow the installer prompts** — it handles everything
4. **Launch FortiLock** from Start Menu or Desktop

**That's it!** No Node.js, npm, development tools, or command line needed.

---

## For Developers: Building the Installer

If you're building FortiLock from source code to create the installer:

### Quick Start

```bash
npm install
npm run dist
```

The installer will be created in `dist-installer/FortiLock-Setup.exe`.

Then share that exe file with end users — they just need to run it.

---

## What Gets Built

### FortiLock-Setup.exe (NSIS Installer)

- Full Windows installer with Start Menu shortcuts
- Users can choose installation directory
- Uninstall support via Control Panel
- Desktop shortcut creation option
- One-file distribution (everything packaged inside)

---

## Build Scripts

```bash
# Compile TypeScript and copy assets
npm run build

# Create Windows installer
npm run dist

# Type check only (no build)
npm run typecheck

# Run tests
npm test

# Run in dev mode with live reload
npm start
```

---

## Step-by-Step: Build and Distribute

### 1. Build the Installer (Developer Only)

```bash
npm install
npm run dist
```

Output: `dist-installer/FortiLock-Setup.exe` (~100 MB)

### 2. Share the Exe

Send `FortiLock-Setup.exe` to end users via:

- Download link
- Email attachment
- USB drive
- Cloud storage (Dropbox, OneDrive, etc.)

### 3. End Users Install (No Developer Tools Needed)

End users simply:

1. Download/receive `FortiLock-Setup.exe`
2. Double-click to run
3. Follow installer prompts
4. Launch from Start Menu or Desktop

**That's it** — the installer includes everything needed. No Node.js, npm, or command line.

---

## Configuration

### Customizing the Installer

Edit `electron-builder.yml` to customize:

- **Product name** — change `productName`
- **App ID** — modify `appId` (must be unique)
- **Installation directory** — set `nsis.allowToChangeInstallationDirectory`
- **Shortcuts** — add/remove via `nsis.createDesktopShortcut`, `nsis.createStartMenuShortcut`
- **Icon** — add `assets/icon.ico` (64x64 PNG) and reference in config

### Signing (Code Signing)

For production releases, add a code signing certificate to avoid SmartScreen warnings:

```yaml
win:
  certificateFile: /path/to/certificate.pfx
  certificatePassword: your_password
```

---

## Troubleshooting

### Build fails with "node_modules not found"

```bash
npm install
npm run dist
```

### Port conflicts during development

```bash
npm start  # Uses a free port automatically
```

### Large installer size

Normal for Electron apps (80–150 MB). Includes:

- Chromium browser (~100 MB)
- Node.js runtime (~50 MB)
- App code (~5 MB)

The installer is self-contained, so distribution is simple.

### Windows Defender/SmartScreen warnings

Unsigned executables may trigger warnings on first launch. This is normal and disappears as Windows builds reputation. For production, consider code signing (see Configuration section).

---

## Distribution

### What to Share

Share `dist-installer/FortiLock-Setup.exe` with users.

### End User Instructions

Send users:

> **Installation:**
>
> 1. Download `FortiLock-Setup.exe`
> 2. Double-click to run
> 3. Follow the installer prompts
> 4. Choose installation directory (optional)
> 5. Select "Create Desktop Shortcut" if desired
> 6. Click Install
> 7. Launch FortiLock from Start Menu or Desktop
>
> **No additional software needed** — the installer includes everything.
>
> **To Uninstall:** Control Panel → Programs → Uninstall a Program → FortiLock → Uninstall

---

## Version Bumping

When releasing a new version:

1. Update `package.json` version:

   ```json
   {
     "version": "1.0.1"
   }
   ```

2. Rebuild the installer:

   ```bash
   npm run dist
   ```

3. The new `FortiLock-Setup.exe` will have the updated version number

Users can install the new version over the old one, or uninstall first.
