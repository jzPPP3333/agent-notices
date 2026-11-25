#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC_DIR="$ROOT_DIR/src/native/macos"
OUT_DIR="$ROOT_DIR/dist/macos"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Skipping macOS native build on non-macOS host."
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found; install Xcode Command Line Tools to build native macOS popups." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Building NoticesPopup..."
swiftc -O \
  -framework AppKit \
  -framework Foundation \
  -framework QuartzCore \
  "$SRC_DIR/NoticesPopup.swift" \
  -o "$OUT_DIR/NoticesPopup"

echo "Building NoticesMenuBar..."
swiftc -O \
  -framework AppKit \
  -framework Foundation \
  "$SRC_DIR/NoticesMenuBar.swift" \
  -o "$OUT_DIR/NoticesMenuBar"

echo "Built macOS native helpers:"
ls -lh "$OUT_DIR/NoticesPopup" "$OUT_DIR/NoticesMenuBar"
