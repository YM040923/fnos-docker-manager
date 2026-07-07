# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS builder

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o /out/docker-manager ./cmd/docker-manager

FROM alpine:3.22

RUN addgroup -S dockerstart && adduser -S -G dockerstart dockerstart

WORKDIR /app
COPY --from=builder /out/docker-manager /app/docker-manager
COPY src/web /app/web

ENV APP_LISTEN_ADDR=0.0.0.0:13000 \
    TRIM_APPDEST=/app \
    TRIM_PKGVAR=/data \
    FNOS_WEB_DIR=/app/web \
    DOCKER_SOCKET=/var/run/docker.sock

VOLUME ["/data"]
EXPOSE 13000

ENTRYPOINT ["/app/docker-manager"]
