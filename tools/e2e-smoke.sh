#!/usr/bin/env bash
# Test de bout en bout : vrai serveur (server/dist/main.js), vraie base PostgreSQL
# dédiée (san_smoke, recréée à chaque lancement), vrai bin/san de SAN_agent-claude_code
# et carte simulée (tools/device-sim.py, qui reproduit le firmware).
#
#   tools/e2e-smoke.sh [--piper] [--keep] [--no-build]
#   tools/e2e-smoke.sh --url URL [--keep]
#
#   --piper     démarre le vrai serveur Piper (tts/server.py) au lieu de TTS_ENGINE=fake
#   --keep      conserve le répertoire temporaire (journaux, clips) à la fin
#   --no-build  ne recompile pas le serveur
#   --url URL   vise un serveur SAN déjà en marche (ex. stack Docker,
#               http://localhost:3300, admin/admin) : ni build, ni base, ni Piper,
#               ni démarrage de serveur (--piper/--no-build sont ignorés). Rejouable :
#               l'agent a un slug unique (smoke-XXXXXX) ; à la fin l'agent est purgé
#               et la carte révoquée. Le serveur lui-même n'est jamais arrêté.
#               Identifiants : SAN_ADMIN_LOGIN / SAN_ADMIN_PASSWORD (admin/admin).
#
# Variables : AGENT_REPO (défaut ../../SAN_agent-claude_code), PIPER_VENV, PIPER_VOICES
# (sinon recherchés ; à défaut, créés selon tts/README.md), SMOKE_DB (san_smoke).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_REPO="${AGENT_REPO:-$ROOT/../SAN_agent-claude_code}"
DB="${SMOKE_DB:-san_smoke}"
PIPER=0 KEEP=0 BUILD=1 REMOTE_URL=""
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --url) [ $# -gt 0 ] || { echo "--url demande une valeur" >&2; exit 2; }; REMOTE_URL="${1%/}"; shift ;;
    --url=*) REMOTE_URL="${a#--url=}"; REMOTE_URL="${REMOTE_URL%/}" ;;
    --piper) PIPER=1 ;;
    --keep) KEEP=1 ;;
    --no-build) BUILD=0 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "option inconnue : $a" >&2; exit 2 ;;
  esac
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/san-smoke.XXXXXX")"
PIDS=()
SLUG="smoke-agent"; VID=""
if [ -n "$REMOTE_URL" ]; then # slug unique : rejouable sur un serveur déjà utilisé
  SLUG="smoke-$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 6 || true)"
fi
REVOKED=0
cleanup() {
  local rc=$?
  trap - EXIT
  if [ -n "$REMOTE_URL" ] && [ -f "${JAR:-/nonexistent}" ]; then # nettoyage de ce que le script a créé
    [ -n "$VID" ] && [ "$REVOKED" = 0 ] && curl -s -o /dev/null -b "$JAR" -X POST "$URL/api/v1/admin/viewers/$VID/revoke" || true
    curl -s -o /dev/null -b "$JAR" -X DELETE "$URL/api/v1/admin/agents/$SLUG?purge=true" || true
  fi
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [ $rc -ne 0 ]; then
    echo "--- journal de la carte (fin) ---" >&2; tail -n 12 "$TMP/sim.log" 2>/dev/null >&2 || true
    echo "--- journal du serveur (fin) ---" >&2; tail -n 25 "$TMP/server.log" 2>/dev/null >&2 || true
  fi
  if [ "$KEEP" = 1 ] || [ $rc -ne 0 ]; then echo "répertoire temporaire conservé : $TMP" >&2; else rm -rf "$TMP"; fi
  exit $rc
}
trap cleanup EXIT

pass=0
step() { printf '\n== %s\n' "$*"; }
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$*"; }
die() { printf '  ECHEC %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "commande requise introuvable : $1"; }
if [ -n "$REMOTE_URL" ]; then BUILD=0; PIPER=0; REQ=(curl python3 ffprobe ffmpeg jq)
else REQ=(node npm curl python3 ffprobe ffmpeg jq sudo); fi
for c in "${REQ[@]}"; do need "$c"; done
[ -x "$AGENT_REPO/bin/san" ] || die "bin/san introuvable dans $AGENT_REPO"

# check "description" valeur-attendue valeur-obtenue
check() { [ "$2" = "$3" ] && ok "$1" || die "$1 : attendu « $2 », obtenu « $3 »"; }
# truthy "description" expression-jq json
truthy() { printf '%s' "$3" | jq -e "$2" >/dev/null 2>&1 && ok "$1" || die "$1 : $2 faux sur $3"; }

free_port() { python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
wait_http() { # url secondes
  local n=$(($2 * 10)); while [ $n -gt 0 ]; do curl -fs -o /dev/null "$1" 2>/dev/null && return 0; sleep 0.1; n=$((n - 1)); done; return 1
}
probe() { # fichier champ... → ffprobe en valeurs séparées par des espaces
  ffprobe -v error -select_streams a:0 -show_entries "stream=$1" -of default=nw=1:nk=1 "$2" | paste -sd' ' -
}
duration() { ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$1"; }
near() { python3 -I -c "import sys; a,b,t=map(float,sys.argv[1:]); sys.exit(0 if abs(a-b)<=t else 1)" "$1" "$2" "$3"; }

if [ -n "$REMOTE_URL" ]; then
  step "Serveur existant"
  URL="$REMOTE_URL"
  TTS_ENV=(TTS_ENGINE=externe)
  wait_http "$URL/api/v1/health" 15 || die "le serveur ne répond pas sur $URL"
  ok "serveur joignable sur $URL (aucun démarrage, aucune base touchée)"
else
# --- 1. Construction -------------------------------------------------------
if [ "$BUILD" = 1 ]; then
  step "Construction du serveur"
  (cd "$ROOT" && npm run build -w @san/shared -w @san/server >"$TMP/build.log" 2>&1) || { cat "$TMP/build.log" >&2; die "build"; }
  ok "npm run build (shared + server)"
fi
[ -f "$ROOT/server/dist/main.js" ] || die "server/dist/main.js absent"

# --- 2. Base, TTS, serveur ---------------------------------------------------
step "Base PostgreSQL « $DB » recréée"
sudo -n -u postgres dropdb --if-exists --force "$DB" 2>&1 | grep -v '^NOTICE\|^perl\|LC_\|LANG\|LANGUAGE\|are supported' || true
sudo -n -u postgres createdb -O dagda "$DB" 2>&1 | grep -v '^perl\|LC_\|LANG\|LANGUAGE\|are supported' || true
ok "dropdb / createdb $DB"

TTS_ENV=(TTS_ENGINE=fake)
if [ "$PIPER" = 1 ]; then
  step "Serveur Piper"
  VENV="${PIPER_VENV:-}"; VOICES="${PIPER_VOICES:-}"
  if [ -z "$VENV" ]; then
    for c in /tmp/claude-1000/v/venv "$HOME/.venvs/piper" "$HOME/.cache/san-smoke/venv"; do
      [ -x "$c/bin/python" ] && "$c/bin/python" -c 'import piper' 2>/dev/null && { VENV="$c"; break; }
    done
  fi
  if [ -z "$VOICES" ]; then
    for c in /tmp/claude-1000/v/voices "$HOME/.cache/san-smoke/voices"; do
      [ -f "$c/fr_FR-siwis-medium.onnx" ] && [ -f "$c/fr_FR-siwis-medium.onnx.json" ] && { VOICES="$c"; break; }
    done
  fi
  if [ -z "$VENV" ]; then # recréation selon tts/README.md
    VENV="$HOME/.cache/san-smoke/venv"; echo "  création du venv Piper : $VENV"
    python3 -m venv "$VENV" && "$VENV/bin/pip" install -q "piper-tts==1.8.0" || die "installation de piper-tts"
  fi
  if [ -z "$VOICES" ]; then
    VOICES="$HOME/.cache/san-smoke/voices"; echo "  téléchargement de la voix : $VOICES"
    "$VENV/bin/python" -m piper.download_voices --download-dir "$VOICES" fr_FR-siwis-medium || die "téléchargement de la voix"
  fi
  TTS_PORT="$(free_port)"
  PORT=$TTS_PORT HOST=127.0.0.1 PIPER_VOICE=fr_FR-siwis-medium PIPER_VOICE_DIRS="$VOICES" \
    "$VENV/bin/python" "$ROOT/tts/server.py" >"$TMP/tts.log" 2>&1 &
  PIDS+=($!)
  wait_http "http://127.0.0.1:$TTS_PORT/health" 90 || { cat "$TMP/tts.log" >&2; die "Piper ne répond pas"; }
  ok "Piper démarré (voix $VOICES, port $TTS_PORT)"
  TTS_ENV=(TTS_ENGINE=piper "TTS_URL=http://127.0.0.1:$TTS_PORT")
fi

step "Serveur SAN"
PORT="$(free_port)"
URL="http://127.0.0.1:$PORT"
mkdir -p "$TMP/data"
(cd "$ROOT/server" && exec env APP_PORT="$PORT" APP_BASE_URL="$URL" \
  APP_DATABASE_URL="postgresql://dagda:dagda@localhost:5432/$DB" \
  APP_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")" \
  DATA_DIR="$TMP/data" "${TTS_ENV[@]}" node dist/main.js >"$TMP/server.log" 2>&1) &
PIDS+=($!)
wait_http "$URL/api/v1/health" 60 || die "le serveur ne répond pas sur $URL"
ok "serveur démarré sur $URL (${TTS_ENV[0]})"
fi

# --- 3. Administrateur -------------------------------------------------------
step "Connexion administrateur (formulaire /login de Dagda)"
JAR="$TMP/jar"
code="$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" --data-urlencode "login=${SAN_ADMIN_LOGIN:-admin}" --data-urlencode "password=${SAN_ADMIN_PASSWORD:-admin}" "$URL/login")"
check "POST /login → 302" 302 "$code"
admin() { # METHOD chemin [json] → corps ; échoue si HTTP >= 400
  local m="$1" p="$2" out
  out="$(curl -sS -w '\n%{http_code}' -b "$JAR" -X "$m" -H 'Content-Type: application/json' ${3:+--data "$3"} "$URL/api/v1$p")"
  local c="${out##*$'\n'}"; [ "$c" -lt 400 ] || die "admin $m $p → HTTP $c : ${out%$'\n'*}"
  printf '%s' "${out%$'\n'*}"
}
anon="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/v1/admin/agents")"
check "admin sans session → 401" 401 "$anon"

# --- 4. Agent ----------------------------------------------------------------
step "Agent"
created="$(admin POST /admin/agents '{"slug":"'"$SLUG"'","name":"Smoke"}')"
AGT="$(printf '%s' "$created" | jq -r .token)"
case "$AGT" in agt_*) ok "agent créé, jeton agt_…" ;; *) die "jeton agent absent : $created" ;; esac

export HOME="$TMP/home"; mkdir -p "$HOME"
export SAN_URL="$URL" SAN_TOKEN="$AGT" SAN_STRICT=1 SAN_ENV_FILE=/nonexistent
SAN="$AGENT_REPO/bin/san"

# --- 5. Carte ----------------------------------------------------------------
step "Carte simulée : enrôlement et activation"
SIM=(python3 -I "$ROOT/tools/device-sim.py" --url "$URL" --state "$TMP/card.json" --save-clips "$TMP/clips")
sim() { "${SIM[@]}" "$@" 2>>"$TMP/sim.log"; }
reg="$(sim register)"
CODE="$(printf '%s' "$reg" | jq -r .pairing_code)"; VID="$(printf '%s' "$reg" | jq -r .viewer_id)"
[[ "$CODE" =~ ^[A-Z][0-9A-Z]-[0-9]{2}$ ]] && ok "register → code $CODE ($VID)" || die "code d'appairage : $reg"
check "status pending" pending "$(sim status | jq -r .status)"
pending="$(admin GET "/admin/viewers?status=pending")"
truthy "la carte figure parmi les viewers en attente" ".viewers[] | select(.id==\"$VID\")" "$pending"
admin POST "/admin/viewers/$VID/activate" '{"name":"Carte test"}' >/dev/null
check "status active" active "$(sim status | jq -r .status)"
admin POST "/admin/viewers/$VID/rules" '{"scope":"agent","pattern":"'"$SLUG"'","can_send_voice":true}' >/dev/null
ok "règle $SLUG (can_send_voice) créée"

s="$(sim sync)"
check "premier réveil : capacités envoyées" true "$(printf '%s' "$s" | jq -r .capabilities_sent)"
check "premier réveil : configuration reçue" true "$(printf '%s' "$s" | jq -r .config_changed)"
cfg="$(sim config)"
check "config.mode" manual "$(printf '%s' "$cfg" | jq -r .config.mode)"
truthy "agent visible, marqué new, can_send_voice" ".config.agents[0] | .agent==\"$SLUG\" and .new==true and .can_send_voice==true" "$cfg"
st="$(sim config-put --toggle "$SLUG" --stale-hash)"
check "PUT config avec base_hash périmé → 409" true "$(printf '%s' "$st" | jq -r .conflict)"
put="$(sim config-put --toggle "$SLUG")"
check "PUT config → abonné" true "$(printf '%s' "$put" | jq -r '.config.agents[0].subscribed')"

# --- 6. Agent → carte --------------------------------------------------------
step "Agent réel (bin/san) → carte"
"$SAN" state working "Compilation du firmware" --progress 40 --ttl 300 >/dev/null
s="$(sim sync)"
truthy "état reçu (working, 40 %, détail)" ".states[] | select(.agent==\"$SLUG\") | .status==\"working\" and .progress==40 and .detail==\"Compilation du firmware\" and .stale==false" "$s"
check "sync sans capacités ni config à renvoyer" "false false" "$(printf '%s' "$s" | jq -r '"\(.capabilities_sent) \(.config_changed)"')"

"$SAN" nudge "Échec des tests" --high >/dev/null
s="$(sim sync)"
truthy "nudge high reçu avec son texte" ".events[] | select(.kind==\"nudge\") | .priority==\"high\" and .text==\"Échec des tests\" and .agent==\"$SLUG\"" "$s"

TEXT="Bonjour, ceci est un test de synthèse vocale."
t0=$SECONDS
"$SAN" say "$TEXT" >/dev/null
wait_clip() { # nombre de clips attendus (cumul depuis le début) → dernier résumé dans $s
  local want="$1" n=$((${2:-60} * 2))
  while [ $n -gt 0 ]; do
    s="$(sim sync)"; got=$((got + $(printf '%s' "$s" | jq '.clips | length')))
    [ "$got" -ge "$want" ] && return 0
    sleep 0.5; n=$((n - 1))
  done
  return 1
}
got=0
wait_clip 1 90 || die "le clip TTS n'est jamais arrivé"
TTS_S=$((SECONDS - t0))
CLIP="$(printf '%s' "$s" | jq -r '.clips[0].clip')"
F="$TMP/clips/$CLIP.wav"
[ -s "$F" ] || die "clip non enregistré par la carte"
check "clip : codec" adpcm_ima_wav "$(probe codec_name "$F")"
check "clip : 16000 Hz mono" "16000 1" "$(probe sample_rate,channels "$F")"
D="$(duration "$F")"
if [ -n "$REMOTE_URL" ]; then near "$D" 3.0 2.5 && ok "clip du serveur : durée ${D}s plausible (synthèse+livraison ${TTS_S}s)" || die "durée du clip ${D}s"
elif [ "$PIPER" = 1 ]; then near "$D" 3.0 2.5 && ok "clip Piper : durée ${D}s plausible (synthèse+livraison ${TTS_S}s)" || die "durée Piper ${D}s"
else near "$D" 2.25 0.1 && ok "clip fake : durée ${D}s (45 caractères × 0,05 s)" || die "durée fake ${D}s"; fi
truthy "la carte a décodé l'ADPCM et obtenu un signal non nul" '.clips[0] | .format=="ima_adpcm" and .rms>500 and .rate==16000' "$s"
ve="$(printf '%s' "$s" | jq -c '.events[] | select(.kind=="voice")')"
truthy "événement voice : texte source et clip.size" ".text==\"$TEXT\" and .clip.size>0" "$ve"

step "Faux agent (--once)"
(cd "$AGENT_REPO" && bash tools/fake-agent.sh --once --interval 0.2 >"$TMP/fake-agent.log" 2>&1) || { cat "$TMP/fake-agent.log" >&2; die "fake-agent"; }
ok "fake-agent.sh --once terminé"
got=0
wait_clip 2 90 || die "les deux clips du faux agent ne sont pas arrivés"
s="$(sim sync)"
truthy "dernier état = idle « Faux agent terminé »" ".states[] | select(.agent==\"$SLUG\") | .status==\"idle\" and .detail==\"Faux agent terminé\"" "$s"
check "le curseur de la carte a avancé jusqu'au dernier événement" 0 "$(printf '%s' "$(sim sync)" | jq '.events | length')"

# --- 7. Carte → agent --------------------------------------------------------
step "Carte → agent (vocal)"
up="$(sim upload "$SLUG" --seconds 1.5)"
check "upload accepté" false "$(printf '%s' "$up" | jq -r .refused)"
UPCLIP="$(printf '%s' "$up" | jq -r .clip_id)"
inbox="$("$SAN" inbox)"
ev="$(printf '%s' "$inbox" | jq -c ".events[] | select(.clip.id==\"$UPCLIP\")")"
[ -n "$ev" ] && ok "bin/san inbox liste le vocal" || die "vocal absent de l'inbox : $inbox"
truthy "inbox : kind voice, from.viewer, durée ≈ 1,5 s" ".kind==\"voice\" and .from.viewer==\"$VID\" and (.clip.duration_ms|. > 1400 and . < 1700)" "$ev"
OUT="$("$SAN" fetch-voice "$UPCLIP" --format mp3 -o "$TMP/recu.mp3")"
check "fetch-voice écrit le fichier" "$TMP/recu.mp3" "$OUT"
check "mp3 : codec" mp3 "$(probe codec_name "$TMP/recu.mp3")"
near "$(duration "$TMP/recu.mp3")" 1.5 0.2 && ok "mp3 : durée ≈ 1,5 s" || die "durée mp3 $(duration "$TMP/recu.mp3")"
"$SAN" fetch-voice "$UPCLIP" -o "$TMP/recu.wav" >/dev/null
check "wav : pcm_s16le 16 kHz" "pcm_s16le 16000" "$(probe codec_name,sample_rate "$TMP/recu.wav")"
last="$(printf '%s' "$inbox" | jq '.events[-1].id')"
check "inbox --ack vide la boîte" 0 "$("$SAN" inbox --ack "$last" | jq '.events | length')"

# --- 8. Garde-fous -----------------------------------------------------------
step "Garde-fous"
check "jeton inconnu → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer dev_inconnu' "$URL/api/v1/viewer/sync")"
admin POST "/admin/viewers/$VID/revoke" >/dev/null; REVOKED=1
check "carte révoquée → 401 (le firmware repasse en REGISTER)" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(jq -r .token "$TMP/card.json")" "$URL/api/v1/viewer/sync")"
s="$(sim sync)"
check "device-sim efface son jeton après 401" true "$(printf '%s' "$s" | jq -r .unauthorized)"

printf '\nTous les contrôles sont passés : %d vérifications (TTS %s, synthèse %ss).\n' "$pass" "${TTS_ENV[0]#TTS_ENGINE=}" "$TTS_S"
