#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")"
RUNTIME="$ROOT/dist/fnos/runtime"
WORK="$ROOT/dist/fnos/fpk-work"
OUT="$ROOT/dist/fnos/DockerManager-${VERSION}-x86_64.fpk"

resolve_fnpack() {
  if [ -n "${FNPACK:-}" ]; then
    printf '%s\n' "$FNPACK"
    return
  fi
  if [ -n "${FNOS_FNPACK:-}" ]; then
    printf '%s\n' "$FNOS_FNPACK"
    return
  fi
  if command -v fnpack >/dev/null 2>&1; then
    command -v fnpack
    return
  fi
  if [ -x "$ROOT/tools/fnpack/fnpack" ]; then
    printf '%s\n' "$ROOT/tools/fnpack/fnpack"
    return
  fi
  if [ -x "/mnt/c/Users/ymzwh/Code/docker-manager/docker_manager_ui/tools/fnpack/fnpack" ]; then
    printf '%s\n' "/mnt/c/Users/ymzwh/Code/docker-manager/docker_manager_ui/tools/fnpack/fnpack"
    return
  fi
  echo "Missing fnpack. Set FNPACK=/path/to/fnpack." >&2
  exit 1
}

if [ ! -d "$RUNTIME" ]; then
  echo "Missing runtime: $RUNTIME. Run scripts/prepare-linux-runtime.sh first." >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK/app"
cp -R "$RUNTIME"/. "$WORK/app/"
sed "s/__VERSION__/$VERSION/g" "$ROOT/packaging/fnos/manifest" > "$WORK/manifest"
cp -R "$ROOT/packaging/fnos/cmd" "$WORK/cmd"
cp -R "$ROOT/packaging/fnos/config" "$WORK/config"
cp -R "$ROOT/packaging/fnos/wizard" "$WORK/wizard"
cp "$RUNTIME/ui/images/icon_64.png" "$WORK/ICON.PNG"
cp "$RUNTIME/ui/images/icon_256.png" "$WORK/ICON_256.PNG"

find "$WORK/cmd" -type f -exec sed -i 's/\r$//' {} \;
find "$WORK/app/scripts" -type f -name "*.sh" -exec sed -i 's/\r$//' {} \;
find "$WORK/cmd" -type f -exec chmod +x {} \;
find "$WORK/app/scripts" -type f -name "*.sh" -exec chmod +x {} \;

(
  cd "$WORK"
  rm -f App.Native.DockerManager.fpk
  "$(resolve_fnpack)" build
)

if [ ! -f "$WORK/App.Native.DockerManager.fpk" ]; then
  echo "fnpack did not produce $WORK/App.Native.DockerManager.fpk" >&2
  exit 1
fi

rm -f "$OUT"
mv "$WORK/App.Native.DockerManager.fpk" "$OUT"
echo "Built $OUT"
