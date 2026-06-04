# fnOS Docker Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new fnOS native Docker Manager that installs through App Center, opens through the unified gateway, discovers Docker containers, persists startup/monitoring configuration, and enforces order-aware startup and monitoring.

**Architecture:** Use a zero-production-dependency Node.js app: built-in HTTP server on `${TRIM_APPDEST}/app.sock`, Docker Engine API over `/var/run/docker.sock`, JSON persistence under `${TRIM_PKGVAR}`, and a static HTML/CSS/JS UI. Package with a clean `packaging/fnos` template copied into `dist/fnos/fpk-work`, then run `fnpack build` and a strict verifier.

**Tech Stack:** Node.js 22 ESM, Node built-in test runner, vanilla HTML/CSS/JS, bash packaging scripts, fnOS unified gateway, Unix sockets.

---

### Task 1: Project Skeleton

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/shared/defaults.js`

- [ ] Add npm scripts for test, web build, runtime preparation, fpk build, and verification.
- [ ] Define default settings and app constants in `src/shared/defaults.js`.
- [ ] Run `npm test` and confirm the empty test suite exits cleanly once tests exist.

### Task 2: Core Server Modules

**Files:**
- Create: `src/server/config-store.js`
- Create: `src/server/activity-log.js`
- Create: `src/server/docker-client.js`
- Create: `src/server/startup-engine.js`
- Create: `src/server/http-app.js`
- Create: `src/server/index.js`
- Test: `src/server/startup-engine.test.js`
- Test: `src/server/config-store.test.js`

- [ ] Write tests for default config creation and clamped settings.
- [ ] Write tests for order-aware startup stopping at the first unresolved dependency.
- [ ] Implement config persistence, Docker API wrapper, startup engine, routes, and Unix socket boot.
- [ ] Run `npm test`.

### Task 3: Static UI

**Files:**
- Create: `src/web/index.html`
- Create: `src/web/styles.css`
- Create: `src/web/app.js`

- [ ] Build a dashboard-first UI with containers, startup plan, logs, and settings sections.
- [ ] Implement API calls for refresh, save config, ordered startup, and manual container actions.
- [ ] Add empty, loading, Docker unavailable, and error states.
- [ ] Run a local preview against the Node server and inspect the UI.

### Task 4: fnOS Package Template

**Files:**
- Create: `packaging/fnos/manifest`
- Create: `packaging/fnos/config/privilege`
- Create: `packaging/fnos/config/resource`
- Create: `packaging/fnos/wizard/install`
- Create: `packaging/fnos/wizard/uninstall`
- Create: `packaging/fnos/cmd/common`
- Create: all required lifecycle scripts under `packaging/fnos/cmd`
- Create: `packaging/fnos/app/ui/config`
- Create: `packaging/fnos/app/config/env.example`
- Create: `packaging/fnos/app/README.md`

- [ ] Match FrpPilot's successful native package shape.
- [ ] Use unified gateway fields and `checkport = false`.
- [ ] Keep install scripts lightweight and avoid appdata writes before runtime startup.

### Task 5: Build and Verify Scripts

**Files:**
- Create: `scripts/build-web-fnos.sh`
- Create: `scripts/prepare-linux-runtime.sh`
- Create: `packaging/fnos/build-fpk.sh`
- Create: `scripts/verify-fnos-package.sh`
- Create: `scripts/generate-icons.mjs`

- [ ] Generate real PNG icons at required sizes.
- [ ] Copy server, web, UI config, scripts, and metadata into `dist/fnos/runtime`.
- [ ] Build `.fpk` from a clean temporary work directory.
- [ ] Verify package structure, JSON, line endings, executable bits, gateway config, and `cmd/main status`.

### Task 6: Final Validation

**Files:**
- Modify as needed based on verification output.

- [ ] Run `npm test`.
- [ ] Run `bash scripts/build-web-fnos.sh`.
- [ ] Run WSL runtime preparation.
- [ ] Run WSL fpk build.
- [ ] Run WSL package verification.
- [ ] Commit the implementation.

