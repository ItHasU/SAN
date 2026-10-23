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

/** Enrôle une carte puis l'active (session admin) */
export async function activeDevice(t: TestApp, cookie: string, name = "Carte test") {
    const device = await registerDevice(t);
    const response = await t.api("POST", `/admin/viewers/${device.viewer_id}/activate`, { cookie, body: { name } });
    if (response.status !== 200) {
        throw new Error(`activate failed: ${response.status}`);
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
