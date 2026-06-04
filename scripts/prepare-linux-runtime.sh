#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/dist/fnos/runtime"

"$ROOT/scripts/build-web-fnos.sh"
rm -rf "$RUNTIME"
mkdir -p "$RUNTIME/server" "$RUNTIME/web" "$RUNTIME/ui/images" "$RUNTIME/scripts" "$RUNTIME/config"

cp "$ROOT/src/server"/*.js "$RUNTIME/server/"
rm -f "$RUNTIME/server"/*.test.js
cp -R "$ROOT/src/shared" "$RUNTIME/shared"
cp "$ROOT/package.json" "$RUNTIME/package.json"
cp -R "$ROOT/dist/fnos/web"/. "$RUNTIME/web/"
cp "$ROOT/packaging/fnos/app/ui/config" "$RUNTIME/ui/config"
cp "$ROOT/packaging/fnos/app/config/env.example" "$RUNTIME/config/env.example"
cp "$ROOT/packaging/fnos/app/README.md" "$RUNTIME/README.md"
node "$ROOT/scripts/generate-icons.mjs" "$RUNTIME/ui/images"

cat > "$RUNTIME/scripts/start.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$DIR/server/index.js"
SCRIPT

cat > "$RUNTIME/scripts/stop.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
echo "Stop is controlled by fnOS cmd/main"
SCRIPT

cat > "$RUNTIME/scripts/status.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
echo "Status is controlled by fnOS cmd/main"
SCRIPT

chmod +x "$RUNTIME/scripts/"*.sh
echo "Prepared runtime at $RUNTIME"
