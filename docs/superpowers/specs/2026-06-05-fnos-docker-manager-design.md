# fnOS Docker Manager Design

## Goal

Build a new fnOS native Docker Manager from scratch. It must provide the same practical value as the previous Docker Manager project: discover containers on the NAS, configure startup order, start containers in dependency order, continuously monitor them, and provide a local management UI. The package must be a real fnOS native app using the unified gateway and Unix socket model, not a Docker Compose deployment and not a web app with an exposed port.

## Non-Goals

- Do not reuse the previous Docker Manager package structure.
- Do not include Manus OAuth, MySQL, Docker Compose deployment, or a separate web port.
- Do not add nonstandard manifest fields such as `install_type = root` or extra desktop fields that are not present in the official template or the known-good FrpPilot package.
- Do not depend on Docker Hub or any external registry at runtime.
- Do not require the user to edit terminal configuration files for normal use.

## Reference Rules

The implementation must follow this order of trust:

1. A fresh `fnpack create <appname>` template.
2. The official fnOS developer documentation mirrored in `ckcoding/fnnas-docs`.
3. The known-good FrpPilot fnOS package structure and verification script.
4. Project-specific requirements in this spec.

`fnpack build` success is not enough. The package must pass a repository verification script before it is considered deliverable, and final validation should use `appcenter-cli install-fpk` on the NAS when available.

## App Identity

- Package name: `fnos-docker-manager`
- Display name: `Docker Manager`
- Gateway prefix: `/app/fnos-docker-manager`
- Gateway socket: `app.sock`
- Launch entry id: `fnos-docker-manager.Application`
- Initial version: `0.1.0`

Versions must be bumped for every installable test package after the first NAS install attempt, so App Center does not confuse old and new packages.

## Package Structure

The source tree should contain:

```text
fnos-docker-manager/
  package.json
  pnpm-lock.yaml
  src/
    server/
    web/
    shared/
  packaging/
    fnos/
      manifest
      config/
        privilege
        resource
      wizard/
        install
        uninstall
      cmd/
        common
        main
        install_init
        install_callback
        uninstall_init
        uninstall_callback
        upgrade_init
        upgrade_callback
        config_init
        config_callback
      app/
        bin/
        web/
        ui/
          config
          images/
            icon.png
            icon_64.png
            icon_256.png
        scripts/
          start.sh
          stop.sh
          status.sh
        config/
          env.example
        README.md
      ICON.PNG
      ICON_256.PNG
      build-fpk.sh
  scripts/
    build-web-fnos.sh
    prepare-linux-runtime.sh
    verify-fnos-package.sh
```

The final `.fpk` must contain:

```text
manifest
app.tgz
config/privilege
config/resource
wizard/install
wizard/uninstall
cmd/common
cmd/main
cmd/install_init
cmd/install_callback
cmd/uninstall_init
cmd/uninstall_callback
cmd/upgrade_init
cmd/upgrade_callback
cmd/config_init
cmd/config_callback
ICON.PNG
ICON_256.PNG
```

`app.tgz` must contain the runtime app contents expected by `TRIM_APPDEST`, including `web`, `ui`, `scripts`, `config`, and server executable/runtime files. The exact internal layout should be generated from the same shape as the `fnpack create` template and verified by `scripts/verify-fnos-package.sh`.

## Manifest

The manifest should follow the known-good native pattern:

```text
appname               = fnos-docker-manager
version               = 0.1.0
display_name          = Docker Manager
desc                  = Docker container startup order and monitoring manager
platform              = x86
arch                  = x86_64
source                = thirdparty
maintainer            = YM040923
distributor           = YM040923
desktop_uidir         = ui
desktop_applaunchname = fnos-docker-manager.Application
checkport             = false
```

If Node.js runtime is used from fnOS, add only the documented dependency field:

```text
install_dep_apps      = nodejs_v22
```

No independent service port should be declared for the UI.

## Unified Gateway UI

`packaging/fnos/app/ui/config` must use:

```json
{
  ".url": {
    "fnos-docker-manager.Application": {
      "title": "Docker Manager",
      "desc": "Docker container startup order and monitoring manager",
      "icon": "images/icon_{0}.png",
      "type": "iframe",
      "protocol": "",
      "gatewaySocket": "app.sock",
      "gatewayPrefix": "/app/fnos-docker-manager",
      "url": "/app/fnos-docker-manager",
      "allUsers": false
    }
  }
}
```

The frontend build must use `/app/fnos-docker-manager` as its base path. All asset URLs must work behind the unified gateway. There should be no hardcoded `localhost`, `127.0.0.1`, `:13000`, or similar port URL in production code.

## Runtime Architecture

Use a small server process that listens on a Unix socket:

```text
${TRIM_APPDEST}/app.sock
```

The `cmd/main` lifecycle script controls this server:

- `start`: create runtime directories, remove stale socket, start the server, write PID.
- `stop`: terminate the PID, remove socket.
- `status`: return `0` when running and `3` when stopped.

Runtime paths:

```text
TRIM_APPDEST/app.sock
TRIM_PKGVAR/config.json
TRIM_PKGVAR/logs/activity.log
TRIM_PKGVAR/run/app.pid
```

`install_init` and `install_callback` must avoid writing to appdata unless verified against the official template. Directory creation should happen in `main start` and runtime scripts, where App Center has prepared app paths.

## Server Technology

Use Node.js 22 with a minimal dependency set:

- HTTP server: Node built-in `http` or Express.
- Docker access: Docker Engine HTTP API over `/var/run/docker.sock`; avoid heavy abstractions unless they clearly reduce risk.
- Persistence: JSON file in `TRIM_PKGVAR/config.json`.
- Logs: append-only text or JSONL in `TRIM_PKGVAR/logs/activity.log`.

Avoid native Node modules in the first version. Do not use SQLite or MySQL. This keeps WSL/fnOS packaging simple and avoids native ABI issues.

## Docker Access

The app needs read and control access to the Docker daemon. It should first attempt to talk to:

```text
/var/run/docker.sock
```

If access fails, the UI must show a clear error state explaining that Docker socket access is unavailable under the current fnOS app permissions. This is a product state, not a crash.

The first implementation may use `run-as: package` in `config/privilege`. If this cannot access Docker on fnOS, the app must not silently switch to nonstandard root manifest fields. Instead, document the limitation and evaluate the official fnOS-supported privileged integration path.

## Data Model

`config.json` should be versioned:

```json
{
  "version": 1,
  "settings": {
    "checkIntervalSeconds": 60,
    "startupRetryDelaySeconds": 10,
    "startupTimeoutSeconds": 120
  },
  "containers": {
    "container-name": {
      "enabled": true,
      "startupOrder": 10,
      "startupDelaySeconds": 5,
      "monitor": true
    }
  }
}
```

Discovered containers that are not in config should appear in the UI with default values:

- `enabled`: `true`
- `startupOrder`: next available order
- `startupDelaySeconds`: `0`
- `monitor`: `true`

Container identity should prefer Docker container ID internally, but display the human-readable name. The config should tolerate renamed containers by showing unknown/stale entries separately instead of deleting them automatically.

## Startup Order Semantics

Startup order is ascending numeric order. Lower numbers start first.

For ordered startup:

1. Sort enabled containers by `startupOrder`, then by name.
2. For each container, ensure it is running.
3. If the current container is not running, attempt to start it.
4. Wait until Docker reports it as running and healthy enough to continue.
5. If it fails, retry the same container after `startupRetryDelaySeconds`.
6. Do not proceed to later containers until the current one is running.
7. After success, wait `startupDelaySeconds`, then continue to the next container.

Health decision:

- If the container has Docker health status, treat `healthy` as ready.
- If it has no health check, treat `running` as ready.
- If it is `unhealthy`, keep retrying according to policy.

## Monitoring Semantics

Periodic monitoring must preserve dependency order. On each tick:

1. Read configured containers in ascending startup order.
2. Ensure each monitored container is running before checking later containers.
3. If an earlier container is stopped or unhealthy, focus retries on it.
4. Do not restart later containers while an earlier dependency is unresolved.
5. Record each action and failure to the activity log.

Manual actions in the UI should be available, but automatic monitoring should remain order-aware.

## UI Design

The first screen should be the actual management surface, not a landing page.

Primary views:

- Dashboard: Docker access status, monitored container count, unhealthy/stopped count, last check time.
- Containers: table/list with name, image, status, health, order, delay, monitor toggle, manual actions.
- Startup Plan: editable ordered list for dependency management.
- Logs: recent app actions and Docker errors.
- Settings: check interval, retry delay, startup timeout.

Expected actions:

- Refresh container discovery.
- Save order/settings.
- Start selected container.
- Stop selected container.
- Restart selected container.
- Run ordered startup now.
- Enable or disable monitoring per container.

UI must include empty, loading, Docker unavailable, save success, save failure, and long log states. It must be usable inside the fnOS iframe and not assume a large desktop viewport.

## API Surface

Use simple JSON endpoints under the gateway:

```text
GET  /api/health
GET  /api/containers
GET  /api/config
PUT  /api/config
POST /api/actions/refresh
POST /api/actions/startup-run
POST /api/containers/:id/start
POST /api/containers/:id/stop
POST /api/containers/:id/restart
GET  /api/logs
```

All API handlers must return structured errors:

```json
{
  "error": {
    "code": "DOCKER_UNAVAILABLE",
    "message": "Cannot access /var/run/docker.sock"
  }
}
```

## Security

The app is reachable only through the fnOS unified gateway entry. The app should trust fnOS gateway authentication headers for user identity. Admin-only behavior should require the fnOS admin header if available.

The server must not bind to TCP in production. It must not expose a password page or a separate local port.

Request handlers must validate user inputs:

- startup order must be integer
- delay/interval values must be bounded
- container IDs must refer to discovered containers before actions run

## Build Workflow

Windows can be used for editing. Linux/WSL should be used for fnOS runtime preparation, packaging, and verification:

```bash
pnpm install
pnpm run build:web:fnos
wsl --cd C:\Users\ymzwh\Code\fnos-docker-manager bash -lc "./scripts/prepare-linux-runtime.sh"
wsl --cd C:\Users\ymzwh\Code\fnos-docker-manager bash -lc "./packaging/fnos/build-fpk.sh"
wsl --cd C:\Users\ymzwh\Code\fnos-docker-manager bash -lc "./scripts/verify-fnos-package.sh"
```

The scripts should keep build output under:

```text
dist/fnos/
```

The final artifact should be named:

```text
dist/fnos/DockerManager-0.1.0-x86_64.fpk
```

## Verification Requirements

`scripts/verify-fnos-package.sh` must:

- extract the `.fpk`
- verify required top-level files
- verify required `app.tgz` files
- verify icon files exist and are non-empty PNGs
- verify all `cmd` scripts are executable and have LF endings
- verify runtime scripts are executable and have LF endings
- verify JSON files parse and have no UTF-8 BOM
- verify manifest contains `checkport = false`
- verify manifest has no `install_type`
- verify `ui/config` contains the expected app id, gateway socket, and gateway prefix
- run `cmd/install_init` with a missing `TRIM_APPDEST`
- run `cmd/main status` against an extracted app and expect exit code `3`

When NAS access is available, final validation should run:

```bash
sudo appcenter-cli install-fpk <file.fpk>
```

If install fails, collect:

```bash
sudo journalctl --since "10 minutes ago" --no-pager -o cat
```

## Delivery Plan

Even though the selected scope is the full feature set, implementation should be staged with real verification after each stage:

1. Template-perfect installable shell app.
2. Unix socket server and gateway UI.
3. Docker discovery and Docker unavailable state.
4. Config persistence and UI editing.
5. Ordered startup engine.
6. Monitoring loop.
7. Logs and manual actions.
8. Full package verification and NAS install test.

No stage is considered complete until the verification script passes. The first stage is not allowed to contain Docker logic; it exists to prove the fnOS package structure before adding product complexity.

