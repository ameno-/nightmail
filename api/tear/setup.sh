#!/usr/bin/env bash
# Install tear's TypeScript packages (@tear/mbt, @tear/host) into api/tear/node_modules/
# and build a revision-pinned `tear` CLI binary under ~/.cache/nightmail-tear/<TEAR_REV>/bin/tear.
#
# anomalyco/tear is private, so api/package.json stays free of it and CI never fetches it.
# Pass TEAR_DIR=/path/to/tear to reuse an existing checkout without modifying it (when TEAR_DIR
# is a git repository, its HEAD must equal TEAR_REV).
set -euo pipefail

TEAR_REV="97a42a263ccb8902f69daad185b0b558d1316277"
HERE="$(cd "$(dirname "$0")" && pwd)"
TEAR_DIR="${TEAR_DIR:-}"
PIN_ROOT="${TEAR_BIN_ROOT:-$HOME/.cache/nightmail-tear/$TEAR_REV}"
PIN_BIN="$PIN_ROOT/bin/tear"

if [[ -z "$TEAR_DIR" ]]; then
  CACHE="${TEAR_CACHE:-$HOME/.cache/nightmail-tear/tear}"
  if [[ ! -d "$CACHE/.git" ]]; then
    mkdir -p "$(dirname "$CACHE")"
    git clone https://github.com/anomalyco/tear "$CACHE"
  fi
  if ! git -C "$CACHE" cat-file -e "$TEAR_REV^{commit}" 2>/dev/null; then
    git -C "$CACHE" fetch origin
  fi
  git -C "$CACHE" checkout --detach "$TEAR_REV"
  TEAR_DIR="$CACHE"
elif [[ -d "$TEAR_DIR/.git" ]]; then
  ACTUAL_REV="$(git -C "$TEAR_DIR" rev-parse HEAD)"
  if [[ "$ACTUAL_REV" != "$TEAR_REV" ]]; then
    echo "error: TEAR_DIR ($TEAR_DIR) is at $ACTUAL_REV, expected pinned TEAR_REV $TEAR_REV" >&2
    exit 1
  fi
fi

if [[ ! -d "$TEAR_DIR/mbt/typescript/src" || ! -d "$TEAR_DIR/hosts/typescript/src" ]]; then
  echo "error: TEAR_DIR ($TEAR_DIR) does not look like a reworked tear checkout" >&2
  exit 1
fi

rm -rf "$HERE/node_modules/@tear"
mkdir -p "$HERE/node_modules/@tear/mbt" "$HERE/node_modules/@tear/host"
cp "$TEAR_DIR/mbt/typescript/package.json" "$HERE/node_modules/@tear/mbt/"
cp -R "$TEAR_DIR/mbt/typescript/src" "$HERE/node_modules/@tear/mbt/"
cp "$TEAR_DIR/hosts/typescript/package.json" "$HERE/node_modules/@tear/host/"
cp -R "$TEAR_DIR/hosts/typescript/src" "$HERE/node_modules/@tear/host/"
printf '%s\n' "$TEAR_REV" > "$HERE/node_modules/@tear/.rev"

if [[ ! -x "$PIN_BIN" ]]; then
  TARGET="${CARGO_TARGET_DIR:-$HOME/.cache/nightmail-tear/target}"
  mkdir -p "$TARGET" "$PIN_ROOT/bin"
  CARGO_TARGET_DIR="$TARGET" cargo install --locked --path "$TEAR_DIR/crates/tear-cli" --root "$PIN_ROOT"
fi

echo "tear ready: $PIN_BIN ($("$PIN_BIN" --version), rev ${TEAR_REV:0:12})"
echo "packages installed in $HERE/node_modules/@tear/{mbt,host}"
