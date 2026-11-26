#!/bin/bash
# Backs up what cannot be rebuilt: the database, the bot data directory, the runtime python
# environments, and the env file (the encryption keys in it are needed to read the dump).
# Daily via LaunchAgent ai.rakazo.backup. Keeps 14 daily dumps and 4 weekly archives.
#
# Dumps and archives carry plaintext metadata (the weekly tar also carries browser profiles),
# so everything this script writes is owner-only: umask 077 for new files, plus a chmod pass
# over what earlier runs left group/world readable.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
umask 077

BACKUP_DIR="$ROOT/backups"
LOG="$ROOT/logs/backup.log"
PG_DUMP="$ROOT/postgres/bin/pg_dump"
SQLITE=/usr/bin/sqlite3
INDEX_DIR="$ROOT/data/semantic-memory-index"
INDEX_BACKUP="$BACKUP_DIR/semantic-memory-index"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { printf '%s [backup] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }
die() { log "ERROR: $*"; printf '%s\n' "$*" >&2; exit 1; }

mkdir -p "$BACKUP_DIR" || die "could not create backup directory"
chmod 700 "$BACKUP_DIR" || die "could not protect backup directory"

# Files from earlier runs were created before umask 077 existed, and rsync -a keeps the source
# modes of the mirrored tree, so both need a pass of their own.
restrict_existing() {
  chmod 600 "$BACKUP_DIR"/rakazo-*.dump "$BACKUP_DIR"/data-*.tar.gz "$BACKUP_DIR"/runtime-*.tar.gz 2>/dev/null
  [ -d "$INDEX_BACKUP" ] && chmod -R go-rwx "$INDEX_BACKUP"
  [ -d "$BACKUP_DIR/data-mirror" ] && chmod -R go-rwx "$BACKUP_DIR/data-mirror"
  # One-off dumps left in the root and in the delivery directories.
  find "$ROOT" -maxdepth 3 -type f \( -name '*.dump' -o -name 'dump-*.sql' \) \
    -not -path "$BACKUP_DIR/*" -exec chmod 600 {} + 2>/dev/null
  return 0
}
restrict_existing

# The app role lacks rights on migration tables; the owner role can dump the whole database.
DB_URL="$(grep -E '^DATABASE_MIGRATION_URL=' "$ROOT/env.native" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
[ -n "$DB_URL" ] || DB_URL="$(grep -E '^DATABASE_URL=' "$ROOT/env.native" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
[ -n "$DB_URL" ] || die "no database URL found in env.native"
[ -x "$PG_DUMP" ] || die "pg_dump missing at $PG_DUMP"

# 1. Database, custom format: restore with pg_restore -d <url> (see RUNBOOK.md §10).
if "$PG_DUMP" "$DB_URL" -Fc -f "$BACKUP_DIR/rakazo-$STAMP.dump"; then
  chmod 600 "$BACKUP_DIR/rakazo-$STAMP.dump"
  log "dumped database to rakazo-$STAMP.dump ($(du -h "$BACKUP_DIR/rakazo-$STAMP.dump" | cut -f1))"
else
  rm -f "$BACKUP_DIR/rakazo-$STAMP.dump"
  die "pg_dump failed"
fi
find "$BACKUP_DIR" -name 'rakazo-*.dump' -type f -mtime +14 -delete

# 2. The encryption keys the dump needs, alongside it.
# Publish each restore input only after a complete copy, keeping the last good copy on failure.
backup_config() {
  local source="$1" dest="$2" stage
  stage="$(mktemp "$dest.XXXXXX")" || die "could not stage $(basename "$dest")"
  if ! cp "$source" "$stage" || ! mv -f "$stage" "$dest"; then
    rm -f "$stage"
    die "could not back up $(basename "$dest")"
  fi
}

backup_config "$ROOT/env.native" "$BACKUP_DIR/env.native"
if [ -f "$ROOT/runtime/phone-access/config.json" ]; then
  mkdir -p "$BACKUP_DIR/phone-access" || die "could not create phone access backup directory"
  backup_config "$ROOT/runtime/phone-access/config.json" "$BACKUP_DIR/phone-access/config.json"
fi

# 3. Local memory index: a live WAL database, so take a consistent snapshot through SQLite's
# backup API instead of copying the .sqlite3/-wal pair while it is being written. The index is
# a projection that can be rebuilt, but a torn copy only shows up at restore time.
if [ -f "$INDEX_DIR/sqlite_exact.sqlite3" ]; then
  mkdir -p "$INDEX_BACKUP"
  stage="$INDEX_BACKUP/.sqlite_exact.sqlite3.new"
  rm -f "$stage"
  if ! "$SQLITE" "$INDEX_DIR/sqlite_exact.sqlite3" ".backup '$stage'"; then
    rm -f "$stage"
    die "SQLite snapshot of the local memory index failed"
  fi
  if [ "$("$SQLITE" "$stage" 'PRAGMA integrity_check;' 2>/dev/null)" != "ok" ]; then
    rm -f "$stage"
    die "SQLite snapshot of the local memory index failed its integrity check"
  fi
  chmod 600 "$stage" && mv "$stage" "$INDEX_BACKUP/sqlite_exact.sqlite3" ||
    die "could not publish the local memory index snapshot"
  # Service-owned marker and any config; the live database files stay out.
  rsync -a --delete --exclude 'sqlite_exact.sqlite3*' --exclude '.sqlite_exact.sqlite3.new' \
    "$INDEX_DIR/" "$INDEX_BACKUP/" && chmod -R go-rwx "$INDEX_BACKUP" ||
    die "could not back up local memory index metadata"
  log "snapshotted the local memory index ($(du -h "$INDEX_BACKUP/sqlite_exact.sqlite3" | cut -f1))"
else
  log "no local memory index at $INDEX_DIR; skipped"
fi

# 4. Bot files (desktop-computer homes), mirrored every day; a tar on Sundays.
rsync -a --delete-excluded --exclude 'semantic-memory-index' \
  "$ROOT/data/" "$BACKUP_DIR/data-mirror/" &&
  chmod -R go-rwx "$BACKUP_DIR/data-mirror" || die "could not mirror data/"
log "mirrored data/ ($(du -sh "$BACKUP_DIR/data-mirror" | cut -f1))"
if [ "$(date +%u)" = "7" ]; then
  # The live index is snapshotted above; a second copy inside the tar would be torn.
  tar -czf "$BACKUP_DIR/data-$STAMP.tar.gz" -C "$ROOT" --exclude 'data/semantic-memory-index' data &&
    chmod 600 "$BACKUP_DIR/data-$STAMP.tar.gz" &&
    log "archived data/ to data-$STAMP.tar.gz" || {
      rm -f "$BACKUP_DIR/data-$STAMP.tar.gz"
      die "data tar failed"
    }
  find "$BACKUP_DIR" -name 'data-*.tar.gz' -type f -mtime +35 -delete
  # runtime/ holds the memory extractor venv and memory-runtime/ the index python plus its
  # offline model; both are run-time dependencies that no build regenerates.
  tar -czf "$BACKUP_DIR/runtime-$STAMP.tar.gz" -C "$ROOT" runtime memory-runtime &&
    chmod 600 "$BACKUP_DIR/runtime-$STAMP.tar.gz" &&
    log "archived runtime/ and memory-runtime/ to runtime-$STAMP.tar.gz" || {
      rm -f "$BACKUP_DIR/runtime-$STAMP.tar.gz"
      die "runtime tar failed"
    }
  find "$BACKUP_DIR" -name 'runtime-*.tar.gz' -type f -mtime +35 -delete
fi

log "done"
