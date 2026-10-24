#!/bin/sh
# Teste un service TTS : ./test.sh [URL] [texte]   (défaut http://localhost:5000)
set -eu
URL="${1:-http://localhost:5000}"
TEXT="${2:-Bonjour, ceci est un test de synthèse vocale en français.}"
OUT="$(mktemp --suffix=.wav)"
trap 'rm -f "$OUT"' EXIT
BODY="$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$TEXT")"
RES="$(curl -sS -o "$OUT" -w '%{http_code} %{content_type} %{time_total}' \
  -X POST -H 'Content-Type: application/json' -d "$BODY" "$URL/")"
set -- $RES
[ "$1" = 200 ] || { echo "ECHEC: HTTP $1"; exit 1; }
case "$2" in audio/wav*) ;; *) echo "ECHEC: content-type $2"; exit 1;; esac
INFO="$(ffprobe -v error -show_entries stream=codec_name,sample_rate,channels:format=duration \
  -of default=nw=1 "$OUT")"
echo "$INFO"
echo "$INFO" | grep -q 'codec_name=pcm_s16le' && echo "$INFO" | grep -q 'channels=1' \
  || { echo "ECHEC: WAV non PCM s16le mono"; exit 1; }
echo "OK: HTTP $1, $2, synthèse en ${3}s"
