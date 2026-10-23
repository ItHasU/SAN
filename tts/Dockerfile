FROM python:3.12-slim

# Voix intégrée à l'image au build (le réseau de prod est `internal`, sans internet).
ARG PIPER_VOICE=fr_FR-siwis-medium
ARG PIPER_VERSION=1.8.0

ENV PIPER_VOICE=${PIPER_VOICE} \
    PIPER_VOICE_DIRS=/voices:/opt/voices \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN pip install "piper-tts==${PIPER_VERSION}" \
 && python -m piper.download_voices --download-dir /opt/voices "${PIPER_VOICE}" \
 && useradd --system --no-create-home --uid 10001 tts \
 && mkdir /voices

COPY server.py /app/server.py

USER tts
EXPOSE 5000
VOLUME ["/voices"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(urllib.request.urlopen('http://127.0.0.1:5000/health', timeout=3).status != 200)"]

CMD ["python", "/app/server.py"]
