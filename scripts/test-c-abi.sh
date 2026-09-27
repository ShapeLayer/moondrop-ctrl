#!/bin/sh
# Build libmoondrop_ctrl.a and run the C ABI smoke test against a fake HID transport.
set -eu
cd "$(dirname "$0")/.."
cargo build --release -p moondrop-ffi
OUT="target/release/c_abi_smoke"
LIBS=""
if [ "$(uname)" = "Darwin" ]; then LIBS="-framework IOKit -framework CoreFoundation"; fi
# shellcheck disable=SC2086
cc -std=c11 -Wall -Wextra -Icrates/moondrop-ffi/include crates/moondrop-ffi/tests/c_abi_smoke.c \
  target/release/libmoondrop_ctrl.a $LIBS -o "$OUT"
MOONDROP_CTRL_HOME="$(mktemp -d)" "$OUT"
