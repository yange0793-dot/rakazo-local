#!/bin/bash
# Rotates the stack's logs without restarting anything. Each live .log is gzipped into
# logs/archive/, then truncated in place: the services append through file descriptors they
# opened at start, so a rename would leave them writing to the rotated file forever.
# Archives older than 14 days are deleted. Daily via LaunchAgent ai.rakazo.logrotate.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

LOG_DIR="$ROOT/logs"
ARCHIVE="$LOG_DIR/archive"
KEEP_DAYS=14
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '%s [logrotate] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

mkdir -p "$ARCHIVE"

rotated=0
failed=0
shopt -s nullglob
for file in "$LOG_DIR"/*.log; do
  [ -f "$file" ] || continue
  [ "$(stat -f %z "$file" 2>/dev/null || echo 0)" -gt 0 ] || continue
  base="$(basename "$file" .log)"
  target="$ARCHIVE/$base-$STAMP.log.gz"
  # gzip first, truncate second: a failure above leaves the live log untouched.
  if gzip -c "$file" >"$target" 2>/dev/null; then
    : >"$file"
    rotated=$((rotated + 1))
  else
    rm -f "$target"
    failed=$((failed + 1))
    say "could not rotate $file"
  fi
done

find "$ARCHIVE" -name '*.gz' -type f -mtime +"$KEEP_DAYS" -delete

say "rotated $rotated log(s) into $ARCHIVE, $failed failed"
