#!/usr/bin/env bash
# Run a heavy job (browser run, Blender, production build, texture / mesh encoding, terrain bake) while holding the
# machine-wide lock, so only one of them runs at a time across every agent working on the island.
#   usage: bash tools/heavy.sh <owner> <command...>
# Waits until no other heavy job runs; breaks a stale lock older than 25 minutes.
# `bash tools/heavy.sh --status` prints the current holder.
LOCK="E:/tmp/island/heavy.lock"
mkdir -p "$(dirname "$LOCK")"
if [ "$1" = "--status" ]; then
  if [ -f "$LOCK/owner" ]; then cat "$LOCK/owner"; else echo "free"; fi
  exit 0
fi
owner="$1"; shift
waited=0
while ! mkdir "$LOCK" 2>/dev/null; do
  if [ -f "$LOCK/owner" ] && [ $(( $(date +%s) - $(stat -c %Y "$LOCK/owner") )) -gt 1500 ]; then
    echo "[heavy] breaking stale lock: $(cat "$LOCK/owner")"; rm -rf "$LOCK"; continue
  fi
  if [ $((waited % 60)) -eq 0 ] && [ -f "$LOCK/owner" ]; then echo "[heavy] waiting for: $(cat "$LOCK/owner")"; fi
  sleep 5; waited=$((waited + 5))
done
echo "$owner $(date +%T) $*" > "$LOCK/owner"
trap 'rm -rf "$LOCK"' EXIT INT TERM
"$@"
