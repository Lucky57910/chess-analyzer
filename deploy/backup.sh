#!/bin/sh
# Nightly database dump with rotation. Wire it up with:
#   0 3 * * * /opt/chess-analyzer/deploy/backup.sh >> /var/log/chess-backup.log 2>&1
#
# The free Postgres this replaced was going to be deleted 30 days after
# creation. Self-hosting removes that clock but hands you the backups instead.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${BACKUP_DIR:-/var/backups/chess-analyzer}"
KEEP="${BACKUP_KEEP:-7}"

. "$DIR/.env"
mkdir -p "$DEST"

STAMP="$(date +%Y%m%d-%H%M%S)"
docker compose -f "$DIR/docker-compose.yml" exec -T db \
	pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges -Fc \
	> "$DEST/chess-$STAMP.pgc"

# A dump that cannot be listed is not a backup.
docker compose -f "$DIR/docker-compose.yml" exec -T db \
	pg_restore -l < "$DEST/chess-$STAMP.pgc" > /dev/null

ls -1t "$DEST"/chess-*.pgc | tail -n +$((KEEP + 1)) | xargs -r rm --
echo "$(date -Is) ok $DEST/chess-$STAMP.pgc"
