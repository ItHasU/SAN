/**
 * Formes JSON de l'API `/api/v1` telles que les reçoit le client (dates en
 * chaînes ISO 8601). Miroir de `server/src/san/*` ; le serveur reste la référence.
 */

export type AgentStatus = "idle" | "working" | "waiting" | "error" | "done";
export const AGENT_STATUS_VALUES: readonly AgentStatus[] = ["idle", "working", "waiting", "error", "done"];

export type NudgeType = "start" | "notification" | "question" | "done" | "error";
export type Priority = "normal" | "high";
export type SubscriptionMode = "auto" | "manual";
export type ViewerStatus = "pending" | "active" | "revoked";

//#region Viewer ---------------------------------------------------------------

export interface StateView {
    agent: string;
    name: string;
    status: AgentStatus;
    detail?: string | null;
    progress: number | null;
    stale: boolean;
    updated_at: string;
}

export interface ClipView {
    id: string;
    duration_ms: number | null;
    format?: string;
    sample_rate?: number;
    size?: number;
}

export interface EventView {
    id: number;
    agent: string;
    kind: "nudge" | "voice";
    priority?: Priority;
    type?: NudgeType;
    text?: string;
    clip?: ClipView;
    muted?: true;
    created_at: string;
}

export interface ConfigAgent {
    agent: string;
    name: string;
    subscribed: boolean;
    new: boolean;
    position: number | null;
    muted: boolean;
    can_send_voice: boolean;
}

export interface ViewerConfig {
    mode: SubscriptionMode;
    agents: ConfigAgent[];
}

export interface ConfigView {
    config_hash: string;
    config: ViewerConfig;
}

export interface SyncResponse {
    server_time: string;
    capabilities_required: boolean;
    config_hash: string;
    config: ViewerConfig | null;
    states: StateView[];
    events: EventView[];
    has_more: boolean;
    next_sync_s: number;
}

export interface SubscriptionPatch {
    agent: string;
    subscribed?: boolean;
    position?: number | null;
    muted?: boolean;
}

/** Corps d'un `409 config_conflict` */
export interface ConfigConflict {
    error: "config_conflict";
    message: string;
    config_hash: string;
    config: ViewerConfig;
}

//#endregion

//#region Administration -------------------------------------------------------

export interface AccessPair {
    viewer: string;
    viewer_name: string | null;
    agent: string;
}

export interface Impact {
    gained: AccessPair[];
    lost: AccessPair[];
}

export interface DryRunResult extends Impact {
    dry_run: true;
}

export interface AgentState {
    status: AgentStatus;
    detail: string | null;
    progress: number | null;
    ttl_s: number | null;
    updated_at: string;
    stale: boolean;
}

export interface AgentRecord {
    slug: string;
    name: string;
    description: string | null;
    created_at: string;
    revoked_at: string | null;
    revoked: boolean;
    groups: string[];
    state: AgentState | null;
}

export interface GroupRecord {
    slug: string;
    name: string;
    description: string | null;
    members: string[];
}

export interface ViewerRecord {
    id: string;
    kind: "device" | "web";
    name: string | null;
    status: ViewerStatus;
    subscription_mode: SubscriptionMode;
    hardware_id: string | null;
    model: string | null;
    registered_ip: string | null;
    pairing_code: string | null;
    capabilities: ViewerCapabilities | null;
    capabilities_hash: string | null;
    battery_pct: number | null;
    next_wake_at: string | null;
    last_seen_at: string | null;
    created_at: string;
    pending_since: string | null;
    activated_at: string | null;
    revoked_at: string | null;
}

export interface RuleRecord {
    id: number;
    viewer_id: string;
    scope: "agent" | "group";
    pattern: string;
    can_send_voice: boolean;
}

export interface RuleCoverage {
    rule: RuleRecord;
    agents: Array<{ slug: string, name: string }>;
    groups: Array<{ slug: string, name: string }>;
}

export interface AccessDetail {
    viewer: string;
    agent: string;
    access: boolean;
    agent_revoked: boolean;
    rules: Array<RuleRecord & { via_groups: string[] }>;
    rule_can_send_voice: boolean;
    audio_in: boolean;
    can_send_voice: boolean;
}

/** Document de capacités (SPEC §7) ; tous les champs sauf la version sont facultatifs */
export interface ViewerCapabilities {
    protocol_version: number;
    firmware?: string;
    display?: { width?: number, height?: number, color?: boolean, max_detail_chars?: number };
    audio_out?: { formats?: string[], sample_rates?: number[] };
    audio_in?: { formats?: string[], sample_rate?: number, max_duration_s?: number };
    nudge?: string[];
    input?: string[];
    battery?: boolean;
}

//#endregion
