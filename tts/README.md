# Service TTS (Piper)

Service `tts` du projet SAN : synthèse vocale française, appelée par le serveur `api`
(`TTS_URL=http://tts:5000`) sur le réseau Docker `internal`.

## Contrat HTTP

| | |
|---|---|
| `POST /` | corps JSON `{"text": "..."}` (`Content-Type: application/json`) |
| Réponse 200 | `Content-Type: audio/wav`, WAV PCM s16le **mono**, fréquence = celle de la voix (22050 Hz pour `fr_FR-siwis-medium`) |
| Erreurs | 400 (JSON/`text` invalide ou vide), 413 (texte > `MAX_CHARS`, 1000 par défaut), 500 (échec de synthèse) |
| `GET /health` | 200 `ok` (utilisé par le `HEALTHCHECK`) |

Le serveur est `server.py` (stdlib `http.server` + API Python de `piper-tts`, synthèse
sérialisée). On n'utilise **pas** `python -m piper.http_server` : il existe (piper-tts 1.8.0)
mais sa route de synthèse est `POST /synthesize`, il exige Flask et expose `POST /download`
(téléchargement HuggingFace), inutile et indésirable sur un réseau sans internet.

Le serveur `api` rééchantillonne/convertit via ffmpeg : la fréquence native n'a pas d'importance.

## Choix de la voix

Mesures locales (CPU x86, texte de ~60 caractères puis ~130 caractères, après préchauffage) :

| Voix | Fichier | Fréquence | Synthèse (court / long) | Commentaire |
|---|---|---|---|---|
| **`fr_FR-siwis-medium`** (retenue) | 63 Mo | 22,05 kHz | 0,75 s / 1,3 s | voix féminine naturelle, bon compromis |
| `fr_FR-upmc-medium` | 77 Mo | 22,05 kHz | 0,6 s / 1,35 s | voix masculine, un peu plus synthétique |
| `fr_FR-tom-medium` | 64 Mo | 44,1 kHz | 1,1 s / 2,7 s | voix masculine, plus lourd, fréquence inutile (pivot 16 kHz) |
| `fr_FR-siwis-low` | 28 Mo | 16 kHz | 0,4 s / 0,95 s | plus rapide, qualité nettement inférieure |

Choix : `siwis-medium`. Changer de voix = argument de build `PIPER_VOICE` (ou variable
d'environnement `PIPER_VOICE` si le fichier est dans `/voices`).

## Provisionnement de la voix (prod sans internet)

La voix est **intégrée à l'image au build** (`/opt/voices`), aucun téléchargement au
démarrage. `/voices` (volume `./voices:/voices`) est cherché en premier : on peut y déposer
une autre voix (`PIPER_VOICE=<nom>`) sans reconstruire, avec `./download-voice.sh <voix> ./voices`
lancé une fois sur l'hôte connecté à internet. Un volume `/voices` vide n'est pas un problème
(repli sur `/opt/voices`).

## Construction et test

```sh
docker build -t san-tts ./tts                       # voix par défaut
docker build -t san-tts --build-arg PIPER_VOICE=fr_FR-upmc-medium ./tts
docker run --rm -p 5000:5000 san-tts
./tts/test.sh http://localhost:5000                 # vérifie code, type, WAV PCM mono, durée

curl -X POST -H 'Content-Type: application/json' \
  -d '{"text":"Bonjour tout le monde"}' http://localhost:5000/ -o out.wav
ffprobe out.wav
```

Le conteneur tourne en utilisateur non root (uid 10001). Variables : `PIPER_VOICE`,
`PIPER_VOICE_DIRS` (défaut `/voices:/opt/voices`), `PORT`, `HOST`, `MAX_CHARS`.
Dans Compose : `image: san-tts` (ou `build: ./tts`), `volumes: [./voices:/voices]`.

## Test sans Docker

```sh
python3 -m venv .venv && .venv/bin/pip install piper-tts==1.8.0
.venv/bin/python -m piper.download_voices --download-dir voices fr_FR-siwis-medium
PIPER_VOICE_DIRS=$PWD/voices .venv/bin/python server.py
```
