import { TestApp } from "./app.fixture";

/** Capacités minimales valides (DESIGN §7) */
export const CAPS = {
    protocol_version: 1,
    firmware: "san-test 0.0.1",
    display: { width: 135, height: 240, color: true, max_detail_chars: 80 },
    audio_out: { formats: ["pcm_s16le"], sample_rates: [16000] },
    nudge: ["sound", "screen"],
    battery: true
};

let counter = 0;

/** Efface les données métier (les comptes Dagda sont conservés) */
export async function resetData(t: TestApp): Promise<void> {
    await t.db.runner.run(`TRUNCATE events, agent_state, subscriptions, permission_rules, agent_group_members, agent_groups, agents, viewers, voice_clips CASCADE`);
}

/** Enrôle une carte et renvoie son jeton, son id et son code */
export async function registerDevice(t: TestApp, hardwareId = `hw-${++counter}`, headers: Record<string, string> = {}) {
    const response = await t.api("POST", "/device/register", { body: { hardware_id: hardwareId, model: "M5StickS3", capabilities: CAPS }, headers });
    if (response.status !== 201) {
        throw new Error(`register failed: ${response.status} ${JSON.stringify(response.json)}`);
    }
    return response.json as { token: string, pairing_code: string, viewer_id: string, status: string };
}

/**
 * Enrôle une carte puis l'active (session admin). Une carte est enrôlée en `auto` ;
 * `mode: "manual"` la passe en manuel via PATCH admin, avant toute règle.
 */
export async function activeDevice(t: TestApp, cookie: string, name = "Carte test", mode: "auto" | "manual" = "auto") {
    const device = await registerDevice(t);
    const response = await t.api("POST", `/admin/viewers/${device.viewer_id}/activate`, { cookie, body: { name } });
    if (response.status !== 200) {
        throw new Error(`activate failed: ${response.status}`);
    }
    if (mode === "manual") {
        const patch = await t.api("PATCH", `/admin/viewers/${device.viewer_id}`, { cookie, body: { subscription_mode: "manual" } });
        if (patch.status !== 200) {
            throw new Error(`patch mode failed: ${patch.status}`);
        }
    }
    return device;
}

/** Crée un agent via l'API d'administration */
export async function createAgent(t: TestApp, cookie: string, slug: string, name = slug) {
    const response = await t.api("POST", "/admin/agents", { cookie, body: { slug, name } });
    if (response.status !== 201) {
        throw new Error(`createAgent failed: ${response.status} ${JSON.stringify(response.json)}`);
    }
    return response.json as { agent: any, token: string };
}

/** Ajoute une règle de permission à un viewer (session admin) */
export async function addRule(t: TestApp, cookie: string, viewerId: string, pattern = "*", scope: "agent" | "group" = "agent", canSendVoice = false) {
    const response = await t.api("POST", `/admin/viewers/${viewerId}/rules`, { cookie, body: { scope, pattern, can_send_voice: canSendVoice } });
    if (response.status !== 201) {
        throw new Error(`addRule failed: ${response.status} ${JSON.stringify(response.json)}`);
    }
    return response.json.rule as { id: number };
}

/** Un flux SSE ouvert avec `fetch()` (Bearer), lu en continu */
export interface SseClient {
    status: number;
    /** Le serveur a fermé le flux */
    ended: boolean;
    /** Blocs reçus, dans l'ordre ({event, id, data} ; les commentaires ont event = ":") */
    messages: Array<{ event: string, id?: string, data: any }>;
    waitFor(predicate: (message: { event: string, id?: string, data: any }) => boolean, timeoutMs?: number): Promise<{ event: string, id?: string, data: any }>;
    close(): void;
}

export async function openSse(t: TestApp, token: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const controller = new AbortController();
    const response = await fetch(`${t.baseUrl}/api/v1/viewer/events`, { headers: { authorization: `Bearer ${token}`, ...headers }, signal: controller.signal });
    const messages: SseClient["messages"] = [];
    const client: SseClient = {
        status: response.status,
        ended: false,
        messages,
        close: () => controller.abort(),
        waitFor: async (predicate, timeoutMs = 3000) => {
            const start = Date.now();
            for (;;) {
                const found = messages.find(predicate);
                if (found != null) {
                    return found;
                }
                if (Date.now() - start > timeoutMs) {
                    throw new Error(`SSE: délai dépassé ; reçu ${JSON.stringify(messages)}`);
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
    };
    if (response.status === 200 && response.body != null) {
        void (async () => {
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }
                    buffer += decoder.decode(value, { stream: true });
                    let end: number;
                    while ((end = buffer.indexOf("\n\n")) >= 0) {
                        const block = buffer.slice(0, end);
                        buffer = buffer.slice(end + 2);
                        const message: SseClient["messages"][number] = { event: "message", data: null };
                        for (const line of block.split("\n")) {
                            if (line.startsWith(":")) {
                                message.event = ":";
                            } else if (line.startsWith("event: ")) {
                                message.event = line.slice(7);
                            } else if (line.startsWith("id: ")) {
                                message.id = line.slice(4);
                            } else if (line.startsWith("data: ")) {
                                message.data = JSON.parse(line.slice(6));
                            }
                        }
                        messages.push(message);
                    }
                }
            } catch {
                // flux interrompu (close)
            }
            client.ended = true;
        })();
    }
    return client;
}
