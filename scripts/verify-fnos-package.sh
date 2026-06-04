#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")"
FPK="${1:-$ROOT/dist/fnos/DockerManager-${VERSION}-x86_64.fpk}"
WORK="$ROOT/dist/fnos/verify-fpk"

if [ ! -f "$FPK" ]; then
  echo "Missing fpk: $FPK" >&2
  exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK"
tar -xzf "$FPK" -C "$WORK"

required=(
  manifest app.tgz config/privilege config/resource wizard/install wizard/uninstall
  cmd/common cmd/main cmd/install_init cmd/install_callback cmd/uninstall_init cmd/uninstall_callback
  cmd/upgrade_init cmd/upgrade_callback cmd/config_init cmd/config_callback ICON.PNG ICON_256.PNG
)
for item in "${required[@]}"; do
  [ -e "$WORK/$item" ] || { echo "fpk missing $item" >&2; exit 1; }
done

mkdir -p "$WORK/app-extract"
tar -xzf "$WORK/app.tgz" -C "$WORK/app-extract"
app_required=(
  server/index.js shared/defaults.js web/index.html web/styles.css web/app.js
  ui/config ui/images/icon.png ui/images/icon_64.png ui/images/icon_256.png
  scripts/start.sh scripts/stop.sh scripts/status.sh config/env.example README.md package.json
)
for item in "${app_required[@]}"; do
  [ -e "$WORK/app-extract/$item" ] || { echo "app.tgz missing $item" >&2; exit 1; }
done

for script in main install_init install_callback uninstall_init uninstall_callback upgrade_init upgrade_callback config_init config_callback; do
  [ -x "$WORK/cmd/$script" ] || { echo "cmd script not executable: $script" >&2; exit 1; }
  ! grep -q $'\r' "$WORK/cmd/$script" || { echo "cmd script has CRLF: $script" >&2; exit 1; }
done
for script in start.sh stop.sh status.sh; do
  [ -x "$WORK/app-extract/scripts/$script" ] || { echo "runtime script not executable: $script" >&2; exit 1; }
  ! grep -q $'\r' "$WORK/app-extract/scripts/$script" || { echo "runtime script has CRLF: $script" >&2; exit 1; }
done

python3 -m json.tool "$WORK/config/privilege" >/dev/null
python3 -m json.tool "$WORK/config/resource" >/dev/null
python3 -m json.tool "$WORK/wizard/install" >/dev/null
python3 -m json.tool "$WORK/wizard/uninstall" >/dev/null
python3 -m json.tool "$WORK/app-extract/ui/config" >/dev/null

! grep -q "install_type" "$WORK/manifest" || { echo "manifest contains install_type" >&2; exit 1; }
! grep -q "checkport[[:space:]]*=" "$WORK/manifest" || { echo "manifest contains non-template checkport field" >&2; exit 1; }
grep -q "appname[[:space:]]*=[[:space:]]*App.Native.DockerManager" "$WORK/manifest" || { echo "manifest missing template-style appname" >&2; exit 1; }
grep -q '"App.Native.DockerManager.Application"' "$WORK/app-extract/ui/config" || { echo "ui config missing app id" >&2; exit 1; }
grep -q '"gatewaySocket"[[:space:]]*:[[:space:]]*"app.sock"' "$WORK/app-extract/ui/config" || { echo "ui config missing gatewaySocket" >&2; exit 1; }
grep -q '"gatewayPrefix"[[:space:]]*:[[:space:]]*"/app/App-Native-DockerManager"' "$WORK/app-extract/ui/config" || { echo "ui config missing gatewayPrefix" >&2; exit 1; }

for icon in ICON.PNG ICON_256.PNG app-extract/ui/images/icon.png app-extract/ui/images/icon_64.png app-extract/ui/images/icon_256.png; do
  [ -s "$WORK/$icon" ] || { echo "empty icon: $icon" >&2; exit 1; }
done

missing_dest="$WORK/missing-install-dest"
rm -rf "$missing_dest"
TRIM_APPDEST="$missing_dest" "$WORK/cmd/install_init" >/dev/null

installed_app="$WORK/installed-app"
var_dir="$WORK/var"
rm -rf "$installed_app" "$var_dir"
mkdir -p "$installed_app" "$var_dir"
tar -xzf "$WORK/app.tgz" -C "$installed_app"
set +e
TRIM_APPDEST="$installed_app" TRIM_PKGVAR="$var_dir" "$WORK/cmd/main" status >/dev/null
status_code="$?"
set -e
[ "$status_code" -eq 3 ] || { echo "cmd/main status expected 3, got $status_code" >&2; exit 1; }

echo "fnOS fpk verified: $FPK"
