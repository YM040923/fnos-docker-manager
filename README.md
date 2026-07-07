# DockerStart

DockerStart is a container startup orchestration and guard tool for fnOS/NAS hosts.

It provides two deployment modes:

- fnOS native app package (`.fpk`) with the fnOS unified gateway and Unix socket UI.
- Docker container image for hosts where a normal container deployment is preferred.

## Features

- Discover local Docker containers through `/var/run/docker.sock`.
- Select which containers join startup orchestration.
- Start selected containers in order after NAS boot.
- Wait for each container to become ready before continuing to the next one.
- Set per-container delay before the next container starts.
- Select which containers join background guard monitoring.
- Preserve configuration and event logs.

## fnOS Native App

Download the latest `.fpk` package from:

<https://github.com/YM040923/fnos-docker-manager/releases>

Install it from fnOS App Center manual install.

The native app uses:

- app name: `dockerstart`
- gateway path: `/app/dockerstart`
- socket: `app.sock`
- background service: `dockerstart.service`

## Docker Container

Use the published GHCR image:

```yaml
services:
  dockerstart:
    image: ghcr.io/ym040923/fnos-docker-manager:latest
    container_name: dockerstart
    restart: unless-stopped
    ports:
      - "13000:13000"
    volumes:
      - dockerstart_data:/data
      - /var/run/docker.sock:/var/run/docker.sock

volumes:
  dockerstart_data:
```

Then open:

```text
http://<nas-ip>:13000
```

The container stores configuration and logs in `/data`.

## Important Startup Policy Note

For containers managed by DockerStart startup orchestration, set their Docker restart policy to `no`.

If a container still uses `always` or `unless-stopped`, Docker may start it before DockerStart can enforce the configured order.

## Build Locally

Build the fnOS package:

```bash
npm run build:fpk:official
npm run verify:fpk:native -- dist/fnos/DockerStart-0.6.1-fnpack-fixed-x86_64.fpk
```

Build the Docker image:

```bash
docker build -t dockerstart:local .
docker compose up -d
```
