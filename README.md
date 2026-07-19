# FortiLock

> A desktop app to lock applications, files, and folders behind a password/PIN — with real encryption for file/folder content, not just hidden or permission-tricks.

---

## What This Is

FortiLock lets you password-protect:

- **Applications** — block a chosen app from launching without a password.
- **Files** — encrypt individual files so their contents are inaccessible without the password.
- **Folders** — encrypt entire folder trees, including nested contents, with no partial visibility.

Built on Windows with real AES-256-GCM encryption for files/folders.

---

## Security Notes

- **File/folder locking is real encryption** (AES-256-GCM, envelope key model).
- **App-locking is a deterrent, not hard security** — a local admin can bypass it (kill the watcher, rename the executable, boot into Safe Mode).
- **Recovery codes to reset your password** — save them securely. If you lose both your password and recovery codes, locked items are permanently inaccessible.

---

## Installation

### For Users

**1. Get the installer:**

- Go to the [Releases](https://github.com/Aditya-Sharma-CapG/fortilock/releases) page
- Download `FortiLock-Setup.exe` from the latest release
- Double-click to run
- Follow the installer prompts
- Launch from Start Menu or Desktop

**No other tools needed.**

### For Developers

Clone and build:

```bash
npm install
npm run build       # Compile TypeScript
npm test            # Run tests
npm start           # Run in dev mode
npm run dist        # Build installer (creates dist-installer/FortiLock-Setup.exe)
```

See [BUILD.md](./BUILD.md) for detailed build instructions.

---

## License

TBD.

---

## Disclaimer

This is not a substitute for full-disk encryption if your threat model includes physical theft of the machine. Use at your own risk.
