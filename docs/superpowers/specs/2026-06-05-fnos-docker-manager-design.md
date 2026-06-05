# fnOS Docker Manager 0.2.0 Design

## Goal

Turn Docker Manager from a basic startup-order page into a practical fnOS native container guard console. The app should help the NAS recover container services in the right order after boot or failure, show enough Docker state for daily decisions, and keep dangerous operations explicit.

The product is not a full replacement for the fnOS Docker app. It focuses on order-aware startup, monitoring, and operational visibility.

## Product Shape

The first screen is the working console:

- Overview: Docker access, monitor state, next check, unhealthy/stopped count, monitored count.
- Startup Plan: ordered dependency list, readiness mode, retry policy, delay, monitor toggle.
- Containers: searchable and filterable inventory grouped by Compose project where available.
- Details: selected container metadata such as ports, mounts, networks, image, status, and latest action result.
- Events: action and monitor logs with filtering, clear, and export.
- Settings: intervals, timeout, startup behavior, protection behavior, import/export configuration.

## Non-Goals

- Do not create or delete containers, images, volumes, or networks in this version.
- Do not edit Docker Compose files.
- Do not expose a TCP management port.
- Do not add MySQL, OAuth, Docker Hub, or external runtime dependencies.
- Do not change the known-good fnOS package layout unless package verification requires it.

## Runtime Architecture

Use the current successful native architecture:

- Go server binary from `cmd/docker-manager/main.go`.
- Unix socket listener at `${TRIM_APPDEST}/app.sock`.
- Static UI under the fnOS unified gateway prefix `/app/dockermanager`.
- Docker Engine API over `/var/run/docker.sock`.
- JSON config at `${TRIM_PKGVAR}/config.json`.
- JSONL activity log at `${TRIM_PKGVAR}/logs/activity.log`.

The package remains built by the official fnpack path already proven installable. The package structure, manifest shape, gateway config, icon names, and `run-as: root` privilege must remain compatible with the successful install path.

## Data Model

Config remains versioned and backward compatible:

```json
{
  "version": 2,
  "settings": {
    "checkIntervalSeconds": 60,
    "startupRetryDelaySeconds": 10,
    "startupTimeoutSeconds": 120,
    "autoRunOnStart": true,
    "protectManagerContainers": true,
    "logRetentionLines": 500
  },
  "containers": {
    "container-id": {
      "enabled": true,
      "name": "moviepilot",
      "image": "jxxghp/moviepilot-v2:latest",
      "startupOrder": 20,
      "startupDelaySeconds": 5,
      "monitor": true,
      "readinessMode": "auto",
      "failurePolicy": "retry"
    }
  }
}
```

Backward compatibility rules:

- Missing version or version `1` is normalized into version `2`.
- Missing `readinessMode` becomes `auto`.
- Missing `failurePolicy` becomes `retry`.
- Missing `autoRunOnStart` defaults to `true`.
- Missing `protectManagerContainers` defaults to `true`.
- Missing `logRetentionLines` defaults to `500`.

## Container Discovery

`GET /api/containers` returns discovered containers plus stale configured entries.

For discovered containers, the API should include:

- id, name, image, state, status, health
- running boolean
- missing boolean
- protected boolean
- created timestamp when available
- ports summary
- mounts summary
- networks summary
- compose project and compose service labels when available
- configured startup/monitor metadata from config

For stale configured entries, return `missing: true`, display the saved name/image when available, and avoid deleting the entry automatically.

## Startup And Monitoring Semantics

Startup order is ascending. Lower numbers are dependencies of later numbers.

For each enabled container in order:

1. Inspect the container.
2. If it is missing, stop the chain and record a blocked result.
3. If it is stopped, start it.
4. If it is running but unhealthy and the failure policy is `retry`, restart it.
5. Wait until ready before continuing.
6. Readiness mode:
   - `auto`: Docker health check must be healthy when present; otherwise running is enough.
   - `running`: running is enough.
   - `healthy`: health status must be healthy.
7. If the current container cannot become ready before timeout, stop later work and report the blocked container.
8. After ready, wait `startupDelaySeconds`, then continue.

Background monitoring must use the same chain and a single operation lock. Manual ordered startup and background monitor cannot run concurrently. Single-container actions are allowed, but the UI must clearly show when an ordered operation is running.

On app start, if `autoRunOnStart` is enabled, the monitor loop should run a first order-aware pass immediately.

## Safety

The app has Docker control access, so the product must make dangerous actions deliberate:

- Stop and restart require confirmation in the UI.
- Log clear requires confirmation.
- Config import shows a validation result before saving.
- Protected containers cannot be stopped or restarted from this app.
- Names containing `docker-manager` are protected by default.
- Missing containers are never auto-removed from config.
- API errors must be structured and visible in the UI.

## API Surface

Required endpoints:

```text
GET  /api/health
GET  /api/config
PUT  /api/config
GET  /api/containers
GET  /api/containers/:id/details
POST /api/actions/refresh
POST /api/actions/startup-run
GET  /api/monitor
GET  /api/logs
POST /api/logs/clear
POST /api/containers/:id/start
POST /api/containers/:id/stop
POST /api/containers/:id/restart
```

All endpoints return JSON. Errors use:

```json
{
  "error": {
    "code": "DOCKER_UNAVAILABLE",
    "message": "cannot access /var/run/docker.sock"
  }
}
```

## UI Requirements

The UI should feel like a compact operations console:

- No landing page.
- No nested decorative cards.
- Dense but readable spacing.
- Clear primary action: run ordered startup.
- Important state should be visible without scrolling on desktop.
- Table should remain usable in small fnOS windows with horizontal scrolling.
- Long names, images, ports, mounts, and logs must truncate or wrap cleanly.

Expected interactions:

- Search by name, image, ID, Compose project/service.
- Filter by all, running, needs attention, stopped, missing, monitored only.
- Group by Compose project.
- Edit order, delay, monitor, readiness mode, failure policy.
- Open a container detail drawer.
- Export config as JSON.
- Import config from JSON with validation.
- Clear logs.
- Export logs.

## Verification

Before delivery:

- Run `npm test`.
- Run `node --check src/web/app.js`.
- Run `go test ./...`.
- Preview UI through `/app/dockermanager`, test main actions and narrow viewport.
- Build with `npm run build:fpk:official`.
- Verify with `npm run verify:fpk:native -- <fpk>`.
- Do not claim installability from build alone; final proof remains NAS App Center or `appcenter-cli` when available.
