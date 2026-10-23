#!/bin/sh
# Télécharge une voix Piper dans un dossier (à lancer UNE fois sur l'hôte, avec internet).
# Usage : ./download-voice.sh [voix] [dossier]   (défaut : fr_FR-siwis-medium ./voices)
# Utilise le venv/python courant s'il a piper-tts, sinon un conteneur.
set -eu
VOICE="${1:-fr_FR-siwis-medium}"
DIR="${2:-./voices}"
mkdir -p "$DIR"
if python3 -c "import piper" 2>/dev/null; then
  python3 -m piper.download_voices --download-dir "$DIR" "$VOICE"
else
  docker run --rm -v "$(cd "$DIR" && pwd):/voices" --entrypoint python \
    "${TTS_IMAGE:-san-tts}" -m piper.download_voices --download-dir /voices "$VOICE"
fi
ls -l "$DIR/$VOICE".onnx*
