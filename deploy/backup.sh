#!/bin/sh
# Sauvegarde à chaud de la base SAN (pg_dump via `docker compose exec`).
#
#   deploy/backup.sh [dossier-de-sortie]        (défaut : ./backups)
#
# Planification (cron de l'hôte/VM, tous les jours à 3 h) :
#   0 3 * * * cd /opt/san && deploy/backup.sh /srv/backups/san >> /var/log/san-backup.log 2>&1
#
# Variables : COMPOSE_FILE (défaut docker-compose.yml), KEEP_DAYS (défaut 14).
# Les identifiants DB_USER/DB_NAME sont relus dans .env.
#
# RAPPEL : ce script ne sauvegarde PAS les fichiers audio (./data). Copiez-les
# aussi (rsync, snapshot de la VM, Hyper Backup...). Ne sauvegardez pas ./pgdata
# par copie de fichiers : seul le dump ci-dessous est cohérent (SPEC §13).
# Conservez aussi APP_SECRET (.env), sans lui les secrets en base sont illisibles.
set -eu

cd "$(dirname "$0")/.."
OUT="${1:-./backups}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
KEEP_DAYS="${KEEP_DAYS:-14}"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi
DB_USER="${DB_USER:-san}"
DB_NAME="${DB_NAME:-san}"

mkdir -p "$OUT"
FILE="$OUT/san-$(date +%Y%m%d-%H%M%S).sql.gz"

# -T : pas de TTY (nécessaire sous cron). Format SQL texte compressé.
docker compose -f "$COMPOSE_FILE" exec -T db \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --clean --if-exists \
  | gzip > "$FILE.tmp"
mv "$FILE.tmp" "$FILE"
echo "Dump écrit : $FILE ($(du -h "$FILE" | cut -f1))"

find "$OUT" -name 'san-*.sql.gz' -mtime "+$KEEP_DAYS" -delete

echo "Rappel : sauvegarder aussi $(pwd)/data (audio) et .env (APP_SECRET)."
