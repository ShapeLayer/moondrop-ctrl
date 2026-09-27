#!/bin/sh
# Build the Tauri desktop app bundle (target/release/bundle/macos/Moondrop Ctrl.app).
set -eu
cd "$(dirname "$0")/../app"
[ -d node_modules ] || npm ci
npm run tauri build -- --bundles app
printf '%s\n' "$(cd .. && pwd)/target/release/bundle/macos/Moondrop Ctrl.app"
