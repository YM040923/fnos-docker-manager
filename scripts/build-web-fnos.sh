#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_OUT="$ROOT/dist/fnos/web"

rm -rf "$WEB_OUT"
mkdir -p "$WEB_OUT"
cp "$ROOT/src/web/index.html" "$WEB_OUT/index.html"
cp "$ROOT/src/web/styles.css" "$WEB_OUT/styles.css"
cp "$ROOT/src/web/app.js" "$WEB_OUT/app.js"
echo "Built web assets at $WEB_OUT"

