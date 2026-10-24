#!/usr/bin/env python3
"""Simulateur de carte M5StickS3 pour le serveur SAN (stdlib uniquement).

Reproduit le protocole du firmware (SAN_viewer-M5StickS3, src/main.cpp et
lib/san_core/src/san_protocol.cpp) : mêmes URL, paramètres, en-têtes, corps et
ordre des appels. L'état durable (jeton, curseur, hashes, configuration) est
conservé dans un fichier JSON, comme la mémoire RTC de la carte.

Sous-commandes (--url et --state sont communs) :
  register              POST /device/register (jeton + code d'appairage)
  status                GET  /device/status
  caps                  PUT  /viewer/capabilities (corps exact du firmware + hash)
  sync                  un réveil complet : sync, capacités si demandées, clips, ack
  config                GET  /viewer/config
  config-put [--toggle AGENT] [--mute AGENT] [--stale-hash]
                        PUT  /viewer/config (base_hash ; --stale-hash force un 409)
  download CLIP         GET  /viewer/voice/CLIP (WAV décodé et vérifié)
  upload AGENT          POST /viewer/voice?to=AGENT (WAV PCM 16 kHz mono)
  caps-json             affiche le document de capacités (exactement ce que la carte envoie)
  full                  scénario complet (équivaut à --scenario full)

Scénario : `device-sim.py --scenario full --url URL --admin-user admin
--admin-password admin --agent robot` enrôle, active (via l'API admin), crée la
règle can_send_voice, puis déroule sync / config / upload.

Sortie : une ligne de journal par requête sur stderr, résultat JSON sur stdout.
Code de retour non nul à la première divergence de protocole.
"""
import argparse
import hashlib
import http.client
import http.cookiejar
import json
import math
import os
import re
import struct
import sys
import urllib.parse

FIRMWARE = "san-m5sticks3 0.1.0"   # cfg::kFirmware ("san-m5sticks3 " SAN_FIRMWARE_VERSION)
MODEL = "M5StickS3"                # cfg::kModel
HTTP_TIMEOUT_S = 15                # cfg::kHttpTimeoutMs
MAX_JSON_RESP = 96 * 1024          # cfg::kMaxJsonResp
MAX_CLIP_BYTES = 2 * 1024 * 1024   # cfg::kMaxClipBytes
MAX_SYNC_PAGES = 5                 # cfg::kMaxSyncPages
REC_RATE = 16000                   # cfg::kRecRate
REC_MAX_S = 10                     # cfg::kRecMaxS
ACCEPT = "application/json, audio/wav, */*"
API = "/api/v1"


class ProtocolError(Exception):
    """Divergence entre le comportement attendu par le firmware et le serveur."""


def log(message):
    print(f"[device-sim] {message}", file=sys.stderr, flush=True)


def expect(condition, message):
    if not condition:
        raise ProtocolError(message)


# ---------------------------------------------------------------------------
# Protocole : copie fidèle de san_protocol.cpp
# ---------------------------------------------------------------------------

def normalize_base(url):
    url = url.rstrip("/ ")
    if url.endswith("/api/v1"):
        url = url[: -len("/api/v1")]
    return url.rstrip("/")


def url_encode(value):
    return urllib.parse.quote(value, safe="-_.~")


def build_capabilities_json():
    """Document compact, ordre stable : le hash est calculé sur cette chaîne exacte."""
    doc = {
        "protocol_version": 1,
        "firmware": FIRMWARE,
        "display": {"width": 135, "height": 240, "color": True, "max_detail_chars": 80},
        "audio_out": {"formats": ["ima_adpcm", "pcm_s16le"], "sample_rates": [8000, 16000]},
        "audio_in": {"formats": ["pcm_s16le"], "sample_rate": 16000, "max_duration_s": 10},
        "nudge": ["sound", "screen"],
        "input": ["buttons"],
        "battery": True,
    }
    return json.dumps(doc, separators=(",", ":"))


def caps_hash(raw):
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def sync_url(ack, config_hash, chash, battery):
    params = []
    if ack >= 0:
        params.append(f"ack={ack}")
    if config_hash:
        params.append(f"config_hash={url_encode(config_hash)}")
    if chash:
        params.append(f"caps_hash={url_encode(chash)}")
    if battery >= 0:
        params.append(f"battery={battery}")
    return "/viewer/sync" + ("?" + "&".join(params) if params else "")


def build_register_body(hardware_id, caps):
    # capabilities est inséré tel quel (ArduinoJson serialized())
    return '{"hardware_id":%s,"model":%s,"capabilities":%s}' % (
        json.dumps(hardware_id), json.dumps(MODEL), caps)


def build_config_put_body(base_hash, config):
    subs = []
    for pos, a in enumerate(config["agents"]):
        subs.append({
            "agent": a["agent"],
            "subscribed": a["subscribed"],
            "position": a["position"] if a.get("position") is not None and a["position"] >= 0 else pos,
            "muted": a["muted"],
        })
    return json.dumps({"base_hash": base_hash, "subscriptions": subs}, separators=(",", ":"))


def read_config(obj):
    """readConfig() du firmware : champs absents → valeurs par défaut."""
    agents = []
    for a in obj.get("agents") or []:
        agent = a.get("agent") if isinstance(a.get("agent"), str) else ""
        if not agent:
            continue
        name = a.get("name") if isinstance(a.get("name"), str) and a.get("name") else agent
        position = a.get("position")
        agents.append({
            "agent": agent, "name": name,
            "subscribed": a.get("subscribed") is True,
            "new": a.get("new") is True,
            "muted": a.get("muted") is True,
            "can_send_voice": a.get("can_send_voice") is True,
            "position": position if isinstance(position, int) and not isinstance(position, bool) else -1,
        })
    mode = obj.get("mode") if isinstance(obj.get("mode"), str) else ""
    return {"mode": mode, "agents": agents}


# ---------------------------------------------------------------------------
# WAV : parseWav / imaDecode du firmware
# ---------------------------------------------------------------------------

IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]
IMA_STEP = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
    73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449,
    494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767]


def parse_wav(data):
    if len(data) < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        return None
    w = {"format": 0, "channels": 0, "rate": 0, "block_align": 0, "bits": 0, "spb": 0}
    p, have_fmt = 12, False
    while p + 8 <= len(data):
        cid = data[p:p + 4]
        sz = struct.unpack_from("<I", data, p + 4)[0]
        c = p + 8
        if cid == b"fmt " and sz >= 16:
            w["format"], w["channels"], w["rate"] = struct.unpack_from("<HHI", data, c)
            w["block_align"], w["bits"] = struct.unpack_from("<HH", data, c + 12)
            if w["format"] == 0x11 and sz >= 20:
                w["spb"] = struct.unpack_from("<H", data, c + 18)[0]
            if w["format"] == 0x11 and w["spb"] == 0 and w["block_align"] > 4:
                w["spb"] = (w["block_align"] - 4) * 2 + 1
            have_fmt = True
        elif cid == b"data":
            if not have_fmt:
                return None
            w["offset"] = c
            w["length"] = min(sz, len(data) - c)  # gère aussi 0xFFFFFFFF
            return w if w["format"] in (1, 0x11) and w["channels"] >= 1 else None
        adv = 8 + sz + (sz & 1)
        if adv > len(data) - p:
            break
        p += adv
    return None


def ima_decode(w, data):
    out = []
    ba = w["block_align"]
    off = 0
    while off + 4 < w["length"]:
        bl = min(ba, w["length"] - off)
        if bl <= 4:
            break
        b = data[w["offset"] + off: w["offset"] + off + bl]
        pred = struct.unpack_from("<h", b, 0)[0]
        idx = min(b[2], 88)
        out.append(pred)
        for byte in b[4:]:
            for nib in (byte & 0x0F, byte >> 4):
                s = IMA_STEP[idx]
                diff = s >> 3
                if nib & 4: diff += s
                if nib & 2: diff += s >> 1
                if nib & 1: diff += s >> 2
                pred += -diff if nib & 8 else diff
                pred = max(-32768, min(32767, pred))
                idx = max(0, min(88, idx + IMA_INDEX[nib]))
                out.append(pred)
        off += bl
    return out


def decode_clip(data):
    """Décode un clip comme playWav() : renvoie (échantillons, fréquence, format)."""
    w = parse_wav(data)
    expect(w is not None, "le clip n'est pas un WAV lisible par le firmware")
    expect(w["channels"] == 1, f"le firmware n'accepte que le mono ({w['channels']} canaux)")
    if w["format"] == 1 and w["bits"] == 16:
        n = w["length"] // 2
        samples = list(struct.unpack_from(f"<{n}h", data, w["offset"]))
        return samples, w["rate"], "pcm_s16le"
    expect(w["format"] == 0x11, f"format WAV 0x{w['format']:x}/{w['bits']} bits non géré par le firmware")
    return ima_decode(w, data), w["rate"], "ima_adpcm"


def build_wav(samples, rate):
    """buildWavHeader() : en-tête de 44 octets, PCM s16le mono."""
    n = len(samples) * 2
    header = (b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
              + b"data" + struct.pack("<I", n))
    return header + struct.pack(f"<{len(samples)}h", *samples)


def sine(seconds, rate=REC_RATE, freq=440.0, amp=12000):
    return [int(amp * math.sin(2 * math.pi * freq * i / rate)) for i in range(int(seconds * rate))]


def rms(samples):
    return math.sqrt(sum(s * s for s in samples) / len(samples)) if samples else 0.0


# ---------------------------------------------------------------------------
# Transport : net::request()
# ---------------------------------------------------------------------------

class _Headers:
    def __init__(self, response):
        self._r = response

    def getheader(self, name):
        return self._r.getheader(name)


class Response:
    def __init__(self, code, headers, body):
        self.code, self.headers, self.body = code, _Headers(headers), body

    def json(self):
        try:
            value = json.loads(self.body.decode("utf-8"))
        except ValueError:
            raise ProtocolError(f"réponse non JSON (HTTP {self.code}) : {self.body[:120]!r}")
        return value


class Device:
    def __init__(self, base, state_path, battery=87):
        self.base = normalize_base(base)
        self.state_path = state_path
        self.battery = battery
        self.save_clips = None  # dossier où écrire les clips reçus (vérification externe, ffprobe)
        self.state = {
            "hardware_id": "m5sticks3-" + hashlib.sha256(os.urandom(8)).hexdigest()[:12],
            "token": "", "pairing_code": "", "active": False,
            "last_ack": 0, "config_hash": "", "caps_hash": "", "config": {"mode": "", "agents": []},
            "last_clip": "", "last_clip_agent": "",
        }
        if state_path and os.path.exists(state_path):
            with open(state_path) as f:
                self.state.update(json.load(f))
        parsed = urllib.parse.urlsplit(self.base)
        self.scheme, self.netloc = parsed.scheme, parsed.netloc
        self.prefix = parsed.path.rstrip("/")

    def save(self):
        if self.state_path:
            with open(self.state_path, "w") as f:
                json.dump(self.state, f, indent=1)

    def request(self, method, path, body=None, ctype=None, token=True, max_body=None):
        """Une requête, avec les en-têtes du firmware (Authorization, Accept, Content-Type)."""
        headers = {"Accept": ACCEPT}
        if token and self.state["token"]:
            headers["Authorization"] = "Bearer " + self.state["token"]
        if ctype:
            headers["Content-Type"] = ctype
        data = body.encode("utf-8") if isinstance(body, str) else body
        if data is not None and not data:
            data = None
        conn_class = http.client.HTTPSConnection if self.scheme == "https" else http.client.HTTPConnection
        conn = conn_class(self.netloc, timeout=HTTP_TIMEOUT_S)
        try:
            conn.request(method, self.prefix + API + path, body=data, headers=headers)
            r = conn.getresponse()
            payload = r.read()
        finally:
            conn.close()
        log(f"{method} {path[:90]} -> {r.status}" + (f" ({len(payload)} o)" if payload else ""))
        if max_body is not None and len(payload) > max_body:
            raise ProtocolError(f"réponse de {len(payload)} octets > limite du firmware ({max_body})")
        return Response(r.status, r, payload)

    # -- auth : handleAuth() --------------------------------------------------
    def handle_auth(self, response):
        """401 : le firmware efface le jeton et repart de REGISTER. Renvoie True si la carte doit s'enrôler."""
        if response.code == 401:
            log("401 : jeton effacé, retour à REGISTER")
            for k in ("token", "pairing_code", "config_hash", "caps_hash"):
                self.state[k] = ""
            self.state.update(active=False, last_ack=0, config={"mode": "", "agents": []})
            self.save()
            return True
        return False

    def adopt_config(self, config, config_hash):
        self.state["config"] = config
        if config_hash:
            self.state["config_hash"] = config_hash
        self.save()

    # -- phases ---------------------------------------------------------------
    def register(self):
        caps = build_capabilities_json()
        body = build_register_body(self.state["hardware_id"], caps)
        r = self.request("POST", "/device/register", body, "application/json", token=False)
        expect(r.code == 201, f"register : HTTP {r.code} (attendu 201) {r.body[:200]!r}")
        d = r.json()
        expect(isinstance(d.get("token"), str) and d["token"].startswith("dev_"), "register : token dev_ absent")
        expect(re.fullmatch(r"[A-Z][0-9A-Z]-\d\d", d.get("pairing_code", "")), f"register : pairing_code inattendu {d.get('pairing_code')!r}")
        expect(d.get("status") == "pending", "register : status != pending")
        self.state.update(token=d["token"], pairing_code=d["pairing_code"], active=False, last_ack=0,
                          config_hash="", caps_hash="")
        self.save()
        return {"pairing_code": d["pairing_code"], "viewer_id": d.get("viewer_id")}

    def status(self):
        r = self.request("GET", "/device/status")
        if self.handle_auth(r):
            return {"status": "unauthorized"}
        expect(r.code == 200, f"status : HTTP {r.code}")
        st = r.json().get("status")
        expect(st in ("pending", "active"), f"status : valeur inattendue {st!r}")
        self.state["active"] = st == "active"
        self.save()
        return {"status": st}

    def put_capabilities(self):
        body = build_capabilities_json()
        r = self.request("PUT", "/viewer/capabilities", body, "application/json")
        if self.handle_auth(r):
            return False
        expect(r.code == 200, f"PUT capabilities : HTTP {r.code} {r.body[:200]!r}")
        served = r.json().get("caps_hash")
        expect(served == caps_hash(body), f"hash de capacités divergent : serveur {served!r}, carte {caps_hash(body)!r}")
        self.state["caps_hash"] = caps_hash(body)
        self.save()
        return True

    def download(self, clip_id):
        """downloadAndPlay() : 404/410 → clip purgé (traité), sinon décodage."""
        r = self.request("GET", f"/viewer/voice/{url_encode(clip_id)}", max_body=MAX_CLIP_BYTES)
        if self.handle_auth(r):
            return None
        if r.code in (404, 410):
            return {"clip": clip_id, "purged": True}
        expect(r.code in (200, 206), f"clip {clip_id} : HTTP {r.code} {r.body[:200]!r}")
        samples, rate, fmt = decode_clip(r.body)
        pad = (parse_wav(r.body) or {}).get("spb", 0)
        if self.save_clips:
            os.makedirs(self.save_clips, exist_ok=True)
            with open(os.path.join(self.save_clips, clip_id + ".wav"), "wb") as f:
                f.write(r.body)
        expect(rate in (8000, 16000), f"fréquence {rate} hors des capacités déclarées")
        served = r.headers.getheader("X-Audio-Format")
        expect(served == f"{fmt}; rate={rate}", f"X-Audio-Format {served!r} ne correspond pas au contenu ({fmt}; rate={rate})")
        self.state["last_clip"], self.state["last_clip_agent"] = clip_id, ""
        return {"clip": clip_id, "format": fmt, "rate": rate, "samples": len(samples),
                "duration_ms": round(len(samples) * 1000 / rate), "pad_ms": round(pad * 1000 / rate), "rms": round(rms(samples)),
                "content_type": r.headers.getheader("Content-Type"), "bytes": len(r.body)}

    def sync_cycle(self):
        """doRun() : un réveil. Renvoie un résumé (états, événements, clips téléchargés)."""
        summary = {"events": [], "clips": [], "states": [], "pages": 0, "capabilities_sent": False,
                   "config_changed": False, "next_sync_s": None}
        caps_sent = False
        page = 0
        while page < MAX_SYNC_PAGES:
            r = self.request("GET", sync_url(self.state["last_ack"], self.state["config_hash"], self.state["caps_hash"], self.battery),
                             max_body=MAX_JSON_RESP)
            if self.handle_auth(r):
                summary["unauthorized"] = True
                return summary
            if r.code == 403:
                err = r.json()
                expect(err.get("error") == "viewer_pending", f"403 inattendu : {err}")
                self.state["active"] = False
                self.save()
                summary["pending"] = True
                return summary
            expect(r.code == 200, f"sync : HTTP {r.code} {r.body[:200]!r}")
            d = r.json()
            for key in ("server_time", "capabilities_required", "config_hash", "states", "events", "has_more", "next_sync_s"):
                expect(key in d, f"sync : champ {key} absent")
            expect("config" in d, "sync : champ config absent (null attendu quand le hash est à jour)")
            if d["capabilities_required"] and not caps_sent:
                caps_sent = True
                summary["capabilities_sent"] = True
                if not self.put_capabilities():
                    return summary
                continue  # nouvelle synchronisation immédiate, sans consommer de page
            if isinstance(d["config"], dict):
                expect(d["config"].get("mode") in ("auto", "manual"), "sync.config.mode invalide")
                self.adopt_config(read_config(d["config"]), d["config_hash"])
                summary["config_changed"] = True
            else:
                expect(d["config"] is None and d["config_hash"] == self.state["config_hash"],
                       "sync : config absente mais config_hash différent de celui de la carte")
            summary["states"] = d["states"]
            summary["next_sync_s"] = d["next_sync_s"]
            done = 0
            for e in d["events"]:
                expect(isinstance(e.get("id"), int) and e["id"] > 0, "événement sans id")
                expect(e.get("kind") in ("nudge", "voice"), f"événement kind inattendu {e.get('kind')!r}")
                cfg = next((a for a in self.state["config"]["agents"] if a["agent"] == e.get("agent")), None)
                summary["events"].append(e)
                if cfg and cfg["muted"]:
                    done += 1
                    continue
                if e["kind"] == "voice" and isinstance(e.get("clip"), dict) and e["clip"].get("id"):
                    clip = e["clip"]
                    expect(clip.get("format") in ("ima_adpcm", "pcm_s16le"), f"clip.format {clip.get('format')!r}")
                    expect(clip.get("sample_rate") in (8000, 16000), f"clip.sample_rate {clip.get('sample_rate')!r}")
                    result = self.download(clip["id"])
                    if result is None:
                        return summary
                    self.state["last_clip_agent"] = e.get("agent", "")
                    if not result.get("purged"):
                        expect(result["format"] == clip["format"], f"clip annoncé {clip['format']}, reçu {result['format']}")
                        expect(result["rate"] == clip["sample_rate"], f"clip annoncé à {clip['sample_rate']} Hz, reçu à {result['rate']}")
                        expect(result["bytes"] == clip.get("size"), f"clip.size {clip.get('size')} != {result['bytes']} octets reçus")
                        # l'encodeur ADPCM complète le dernier bloc (jusqu'à samples_per_block échantillons de silence)
                        pad_ms = result["pad_ms"] if result["format"] == "ima_adpcm" else 5
                        expect(-5 <= result["duration_ms"] - clip["duration_ms"] <= pad_ms + 5,
                               f"durée décodée {result['duration_ms']} ms != clip.duration_ms {clip['duration_ms']} (marge {pad_ms} ms)")
                    summary["clips"].append(result)
                done += 1
            for e in d["events"][:done]:
                self.state["last_ack"] = max(self.state["last_ack"], e["id"])
            self.save()
            summary["pages"] += 1
            page += 1
            if done < len(d["events"]) or not d["has_more"]:
                break
        return summary

    def config_get(self):
        r = self.request("GET", "/viewer/config", max_body=MAX_JSON_RESP)
        if self.handle_auth(r):
            return None
        expect(r.code == 200, f"GET config : HTTP {r.code}")
        d = r.json()
        expect(isinstance(d.get("config_hash"), str) and isinstance(d.get("config"), dict), "GET config : forme {config_hash, config} attendue")
        expect(d["config"].get("mode") in ("auto", "manual") and isinstance(d["config"].get("agents"), list), "GET config : {mode, agents} attendu")
        self.adopt_config(read_config(d["config"]), d["config_hash"])
        return d

    def config_put(self, toggle=(), mute=(), stale_hash=False):
        """configMenu() : GET puis PUT avec base_hash = dernier hash connu."""
        self.config_get()
        work = json.loads(json.dumps(self.state["config"]))
        for a in work["agents"]:
            if a["agent"] in toggle and work["mode"] != "auto":
                a["subscribed"] = not a["subscribed"]
                a["new"] = False
            if a["agent"] in mute:
                a["muted"] = not a["muted"]
        base = "0000000000000000" if stale_hash else self.state["config_hash"]
        r = self.request("PUT", "/viewer/config", build_config_put_body(base, work), "application/json", max_body=MAX_JSON_RESP)
        if self.handle_auth(r):
            return None
        d = r.json()
        if r.code == 409:
            expect(d.get("error") == "config_conflict", f"409 : error {d.get('error')!r}")
            expect(isinstance(d.get("config_hash"), str) and isinstance(d.get("config"), dict), "409 : {config_hash, config} attendu à la racine")
            self.adopt_config(read_config(d["config"]), d["config_hash"])
            return {"conflict": True, "config_hash": d["config_hash"]}
        expect(r.code == 200, f"PUT config : HTTP {r.code} {d}")
        expect(isinstance(d.get("config_hash"), str) and isinstance(d.get("config"), dict), "PUT config : {config_hash, config} attendu")
        self.adopt_config(read_config(d["config"]), d["config_hash"])
        return {"conflict": False, "config_hash": d["config_hash"], "config": d["config"]}

    def upload(self, agent, seconds=1.5, freq=440.0):
        """doRecord() : WAV PCM s16le mono 16 kHz, Content-Type audio/wav."""
        a = next((x for x in self.state["config"]["agents"] if x["agent"] == agent), None)
        can = a is not None and a["can_send_voice"]
        wav = build_wav(sine(seconds, REC_RATE, freq), REC_RATE)
        r = self.request("POST", f"/viewer/voice?to={url_encode(agent)}", wav, "audio/wav")
        if self.handle_auth(r):
            return None
        d = r.json() if r.body else {}
        if r.code == 403:
            expect(d.get("error") == "voice_not_allowed", f"403 : {d}")
            return {"refused": True, "carte_autorisait": can}
        expect(r.code == 201, f"upload : HTTP {r.code} {d}")
        expect(re.fullmatch(r"c_[0-9A-Z]{26}", d.get("clip_id", "")) and isinstance(d.get("event_id"), int), f"upload : forme inattendue {d}")
        return {"refused": False, "clip_id": d["clip_id"], "event_id": d["event_id"], "bytes": len(wav)}


# ---------------------------------------------------------------------------
# Administration (uniquement pour --scenario full)
# ---------------------------------------------------------------------------

class Admin:
    def __init__(self, base, user, password):
        self.base = normalize_base(base)
        self.jar = http.cookiejar.CookieJar()
        import urllib.request
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), _NoRedirect())
        form = urllib.parse.urlencode({"login": user, "password": password}).encode()
        try:
            self.opener.open(urllib.request.Request(self.base + "/login", data=form), timeout=15)
        except urllib.error.HTTPError as e:
            expect(e.code in (302, 303), f"login admin : HTTP {e.code}")
        expect(any(c.name for c in self.jar), "login admin : pas de cookie de session")

    def call(self, method, path, body=None):
        import urllib.request
        req = urllib.request.Request(self.base + API + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
        with self.opener.open(req, timeout=15) as r:
            return json.loads(r.read() or b"{}")


import urllib.error  # noqa: E402
import urllib.request  # noqa: E402


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


# ---------------------------------------------------------------------------
# Scénario complet
# ---------------------------------------------------------------------------

def scenario_full(dev, args):
    out = {}
    out["register"] = dev.register()
    out["status_pending"] = dev.status()
    expect(out["status_pending"]["status"] == "pending", "la carte devrait être pending")
    sync = dev.sync_cycle()
    expect(sync.get("pending"), "sync d'une carte pending : 403 viewer_pending attendu")
    out["sync_pending"] = "403 viewer_pending"
    # Les routes viewer hors /device/status sont refusées tant que la carte est pending
    r = dev.request("PUT", "/viewer/capabilities", build_capabilities_json(), "application/json")
    expect(r.code == 403, f"PUT capabilities d'une carte pending : HTTP {r.code} (403 attendu)")
    if args.admin_user:
        admin = Admin(dev.base, args.admin_user, args.admin_password)
        viewer_id = out["register"]["viewer_id"]
        if args.agent:
            try:
                admin.call("POST", "/admin/agents", {"slug": args.agent, "name": args.agent.capitalize()})
            except urllib.error.HTTPError as e:
                expect(e.code == 409, f"création de l'agent : HTTP {e.code}")
        admin.call("POST", f"/admin/viewers/{viewer_id}/activate", {"name": "device-sim"})
        if args.agent:
            admin.call("POST", f"/admin/viewers/{viewer_id}/rules",
                       {"scope": "agent", "pattern": args.agent, "can_send_voice": True})
    else:
        log("pas d'identifiants admin : activez la carte à la main puis relancez `sync`")
        return out
    out["status_active"] = dev.status()
    expect(out["status_active"]["status"] == "active", "la carte devrait être active")
    first = dev.sync_cycle()
    expect(first["capabilities_sent"], "le premier sync aurait dû demander les capacités")
    expect(first["config_changed"], "le premier sync aurait dû renvoyer la configuration")
    second = dev.sync_cycle()
    expect(not second["capabilities_sent"] and not second["config_changed"], "le second sync devrait être sans capacités ni config")
    out["sync"] = {"pages": second["pages"], "states": len(second["states"]), "events": len(second["events"])}
    cfg = dev.config_get()
    out["config"] = cfg["config"]
    if args.agent:
        agents = [a["agent"] for a in cfg["config"]["agents"]]
        expect(args.agent in agents, f"agent {args.agent} absent de la config")
        stale = dev.config_put(stale_hash=True)
        expect(stale["conflict"], "un base_hash périmé devrait provoquer un 409")
        put = dev.config_put(toggle=[args.agent], mute=[args.agent])
        expect(not put["conflict"], "PUT config : conflit inattendu")
        out["config_put"] = put["config_hash"]
        out["upload"] = dev.upload(args.agent)
        expect(not out["upload"]["refused"], "upload refusé alors que can_send_voice est accordé")
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", nargs="?", choices=["register", "status", "caps", "sync", "config", "config-put", "download",
                                                  "upload", "caps-json", "full"])
    p.add_argument("target", nargs="?", help="clip (download) ou agent (upload)")
    p.add_argument("--url", default=os.environ.get("SAN_URL", "http://127.0.0.1:3000"))
    p.add_argument("--state", default=os.environ.get("SAN_SIM_STATE", "device-sim.json"))
    p.add_argument("--scenario", choices=["full"])
    p.add_argument("--battery", type=int, default=87)
    p.add_argument("--toggle", action="append", default=[], help="config-put : bascule l'abonnement de cet agent")
    p.add_argument("--mute", action="append", default=[], help="config-put : bascule le mode muet de cet agent")
    p.add_argument("--stale-hash", action="store_true", help="config-put : base_hash périmé (409 attendu)")
    p.add_argument("--seconds", type=float, default=1.5, help="upload : durée de la sinusoïde")
    p.add_argument("--admin-user")
    p.add_argument("--admin-password", default="admin")
    p.add_argument("--agent", help="scénario full : agent à créer et vers lequel envoyer un vocal")
    p.add_argument("--save-clips", metavar="DIR", help="écrit les clips téléchargés dans ce dossier")
    p.add_argument("--fresh", action="store_true", help="oublie l'état enregistré")
    args = p.parse_args(argv)
    command = "full" if args.scenario == "full" else args.command
    if command is None:
        p.error("une sous-commande ou --scenario full est requis")
    if command == "caps-json":
        print(build_capabilities_json())
        return 0
    if args.fresh and os.path.exists(args.state):
        os.remove(args.state)
    dev = Device(args.url, args.state, args.battery)
    dev.save_clips = args.save_clips
    try:
        if command == "register":
            result = dev.register()
        elif command == "status":
            result = dev.status()
        elif command == "caps":
            result = {"ok": dev.put_capabilities(), "caps_hash": caps_hash(build_capabilities_json())}
        elif command == "sync":
            result = dev.sync_cycle()
        elif command == "config":
            result = dev.config_get()
        elif command == "config-put":
            result = dev.config_put(args.toggle, args.mute, args.stale_hash)
        elif command == "download":
            result = dev.download(args.target)
        elif command == "upload":
            result = dev.upload(args.target, args.seconds)
        else:
            result = scenario_full(dev, args)
    except ProtocolError as e:
        log(f"DIVERGENCE : {e}")
        return 1
    finally:
        dev.save()
    json.dump(result, sys.stdout, indent=1, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
