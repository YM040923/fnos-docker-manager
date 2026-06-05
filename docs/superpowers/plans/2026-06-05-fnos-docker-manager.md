# Docker Manager 0.2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished fnOS native Docker guard console with order-aware monitoring, richer container inventory, safer actions, config import/export, and a redesigned UI.

**Architecture:** Keep the proven fnOS package structure and Go native server. Extend `cmd/docker-manager/main.go` for Docker metadata, config version 2, log management, stale entries, and protected actions. Rebuild the static UI in `src/web/*` around an operations-console layout while keeping `/app/dockermanager` gateway-safe asset and API paths.

**Tech Stack:** Go standard library, Docker Engine HTTP API over Unix socket, vanilla HTML/CSS/JS, official fnpack build scripts, Chrome preview verification.

---

## File Responsibilities

- `cmd/docker-manager/main.go`: runtime server, Docker API client, config normalization, monitor loop, action endpoints.
- `cmd/docker-manager/main_test.go`: focused Go tests for config migration, discovery metadata, stale entries, readiness, protected actions.
- `src/web/index.html`: static console structure.
- `src/web/app.js`: client state, API calls, filters, editing, details drawer, confirmations, import/export.
- `src/web/styles.css`: compact fnOS-window-friendly layout.
- `package.json`: version bump to `0.2.0`.
- `docs/superpowers/specs/2026-06-05-fnos-docker-manager-design.md`: approved product design.

---

### Task 1: Backend Data Model And Tests

**Files:**
- Modify: `cmd/docker-manager/main.go`
- Create: `cmd/docker-manager/main_test.go`
- Modify: `package.json`

- [ ] Add config version 2 fields: `AutoRunOnStart`, `ProtectManagerContainers`, `LogRetentionLines`, `Name`, `Image`, `ReadinessMode`, `FailurePolicy`.
- [ ] Write tests proving old version 1 config migrates to version 2 defaults.
- [ ] Write tests proving invalid readiness/failure values normalize to `auto` and `retry`.
- [ ] Bump `package.json` from `0.1.11` to `0.2.0`.
- [ ] Run `go test ./...` and confirm tests pass.

### Task 2: Docker Inventory And Stale Config Entries

**Files:**
- Modify: `cmd/docker-manager/main.go`
- Modify: `cmd/docker-manager/main_test.go`

- [ ] Extend container JSON with running, missing, protected, created, ports, mounts, networks, compose project/service, and config fields.
- [ ] Parse Docker list response labels, ports, mounts, created timestamp, and network names without exposing env secrets.
- [ ] Store discovered name/image into config on merge.
- [ ] Return stale configured entries as `missing: true`.
- [ ] Write tests for discovered metadata merge and stale entry output.
- [ ] Run `go test ./...`.

### Task 3: Order-Aware Engine Improvements

**Files:**
- Modify: `cmd/docker-manager/main.go`
- Modify: `cmd/docker-manager/main_test.go`

- [ ] Add readiness mode logic: `auto`, `running`, `healthy`.
- [ ] Add failure policy logic: `retry`, `log`.
- [ ] Treat missing containers as blocked and stop the chain.
- [ ] Restart unhealthy running containers only when policy is `retry`.
- [ ] Keep one operation lock for manual startup and monitor startup.
- [ ] Write tests for missing container blocking, running-only readiness, and log-only unhealthy policy.
- [ ] Run `go test ./...`.

### Task 4: Safety And Operations APIs

**Files:**
- Modify: `cmd/docker-manager/main.go`
- Modify: `cmd/docker-manager/main_test.go`

- [ ] Add `GET /api/containers/:id/details`.
- [ ] Add `POST /api/logs/clear`.
- [ ] Block stop/restart actions for protected containers.
- [ ] Return structured errors with stable codes for protected, not found, Docker unavailable, and bad JSON.
- [ ] Trim activity logs to `logRetentionLines` after writes.
- [ ] Write tests for protected action blocking and log clearing helper behavior.
- [ ] Run `go test ./...`.

### Task 5: Redesigned UI Shell

**Files:**
- Modify: `src/web/index.html`
- Modify: `src/web/styles.css`
- Modify: `src/web/app.js`

- [ ] Replace the current page with overview, startup plan, inventory, details drawer, settings, and events sections.
- [ ] Preserve all existing gateway-safe absolute asset paths.
- [ ] Add empty, loading, Docker unavailable, and busy operation states.
- [ ] Add search and filters for all/running/problem/stopped/missing/monitored.
- [ ] Add Compose project grouping.
- [ ] Run `node --check src/web/app.js`.

### Task 6: UI Editing And Safety Interactions

**Files:**
- Modify: `src/web/app.js`
- Modify: `src/web/styles.css`

- [ ] Add editable order, delay, monitor, readiness mode, and failure policy controls.
- [ ] Ensure filtered-out rows never lose draft config.
- [ ] Add details drawer loading from `/api/containers/:id/details`.
- [ ] Add confirmation modal for stop, restart, clear logs, and config import.
- [ ] Add config export/import and log export.
- [ ] Run `node --check src/web/app.js`.

### Task 7: Preview Verification

**Files:**
- Update temporary preview server under `C:\tmp\fnos-dm-preview-server.mjs` for local verification only.

- [ ] Mock the expanded API responses.
- [ ] Open `http://127.0.0.1:41731/app/dockermanager` in Chrome.
- [ ] Verify dashboard, filters, group toggle, detail drawer, save, import/export, logs clear/export, confirmation modal, and narrow viewport.
- [ ] Confirm browser console has no errors.

### Task 8: Build, Verify, Commit

**Files:**
- Modify as needed based on verification output.

- [ ] Run `npm test`.
- [ ] Run `node --check src/web/app.js`.
- [ ] Run `go test ./...`.
- [ ] Run `npm run build:fpk:official`.
- [ ] Run `npm run verify:fpk:native -- C:\Users\ymzwh\Code\fnos-docker-manager\dist\fnos\DockerManager-0.2.0-fnpack-fixed-x86_64.fpk`.
- [ ] Commit with `feat: redesign docker manager console`.
