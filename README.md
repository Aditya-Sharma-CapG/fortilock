# FortiLock

> A desktop app to lock applications, files, and folders behind a password/PIN — with real encryption for file/folder content, not just hidden or permission-tricks.

**Status:** 🚧 In active development — Phase 1 (core crypto & vault logic). Not yet functional.

---

## What This Is

FortiLock lets you password-protect:

- **Applications** — block a chosen app from launching without a password.
- **Files** — encrypt individual files so their contents are inaccessible without the password.
- **Folders** — encrypt entire folder trees, including nested contents, with no partial visibility.

Built as a personal-use tool, first for Windows, with the architecture kept portable in case macOS/Linux support follows later.

Full design rationale, architecture, tech stack, edge cases, and the complete development plan live in **[`FortiLock_Project_Plan.md`](./FortiLock_Project_Plan.md)** — the source of truth for this project.

---

## Honest Security Notes

- **File/folder locking is real encryption** (AES-256-GCM, envelope key model) — this is where the actual security guarantee lives.
- **App-locking is a deterrent, not a hard security boundary.** A local admin can bypass it (kill the watcher, rename the executable, boot into Safe Mode). This is an inherent limitation of userspace app-locking, not a bug — see the plan's [Threat Model](./FortiLock_Project_Plan.md#91-threat-model) for the full breakdown.
- **There is no password recovery by design.** Forgetting the master password means locked files/folders are permanently unrecoverable. This is the honest trade-off of real encryption.

---

## Roadmap

- [ ] **Phase 1** — Core crypto & vault logic _(in progress)_
- [ ] **Phase 2** — File & folder locking, minimal UI
- [ ] **Phase 3** — App locking (process watcher)
- [ ] **Phase 4** — Settings, tray icon, audit log, polish
- [ ] **Phase 5** — Packaging & Windows release
- [ ] **Phase 6** — macOS / Linux ports _(future)_

Full phase breakdown: [project plan, §8.3](./FortiLock_Project_Plan.md#83-development-phases).

---

## License

TBD.

---

## Disclaimer

This is a personal project, not a substitute for full-disk encryption (BitLocker/FileVault/LUKS) if your threat model includes physical theft of the machine. See the [Risks & Limitations](./FortiLock_Project_Plan.md#9-risks--known-limitations-read-before-building) section of the project plan for the full picture before relying on this for anything sensitive.
