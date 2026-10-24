import { EventView, NudgeType } from "@san/shared/src/api/types";
import { h, icon } from "../../lib/dom";
import { formatClock, formatRelative } from "../../lib/time";
import { button, reportError } from "../../ui/common";

export interface EventItemContext {
    agentName(slug: string): string;
    clip(clipId: string): Promise<Blob>;
    /** L'événement est affiché ou lu : à acquitter */
    seen(eventId: number): void;
}

/** Icône et libellé par type de nudge ; `notification` (défaut) n'a pas de libellé */
const NUDGE_TYPES: Record<NudgeType, { icon: string, label: string | null }> = {
    start: { icon: "ph-play-circle", label: "Démarrage" },
    notification: { icon: "ph-bell", label: null },
    question: { icon: "ph-question", label: "Question" },
    done: { icon: "ph-check-circle", label: "Terminé" },
    error: { icon: "ph-x-circle", label: "Erreur" }
};

/** Un nudge ou un message vocal de l'historique ; tout le texte passe par `textContent` */
export class EventItem {

    public readonly element: HTMLElement;
    protected readonly _time = h("span", { class: "san-meta" });
    protected readonly _player = h("div");
    protected _objectUrl: string | null = null;

    constructor(public readonly event: EventView, protected readonly _context: EventItemContext) {
        const high = event.priority === "high";
        const voice = event.kind === "voice";
        const type = voice ? null : NUDGE_TYPES[event.type ?? "notification"] ?? NUDGE_TYPES.notification;
        const head = h("div", { class: "san-row san-row-between" },
            h("div", { class: "san-row" },
                icon(type == null ? "ph-speaker-high" : high && (event.type ?? "notification") === "notification" ? "ph-warning-octagon" : type.icon),
                h("span", { class: "san-title", text: _context.agentName(event.agent) }),
                type?.label != null ? h("span", { class: `tag ${event.type === "error" ? "tag-danger" : "tag-outline"}`, text: type.label, data: { type: event.type! } }) : null,
                high ? h("span", { class: "tag tag-danger", text: "Urgent" }) : null,
                event.muted === true ? h("span", { class: "tag tag-outline", text: "muet" }) : null),
            this._time);
        const text = event.text != null && event.text !== "" ? h("p", { class: "san-detail", text: event.text }) : null;
        this.element = h("article", { class: "san-card san-event", data: { priority: event.priority ?? "normal", type: event.type ?? "", kind: event.kind, id: String(event.id), muted: String(event.muted === true) } },
            head, text, this._player);
        if (voice) {
            this._renderPlayer();
        }
        this.updateTime(Date.now());
    }

    public updateTime(now: number): void {
        this._time.textContent = formatRelative(this.event.created_at, now);
    }

    protected _renderPlayer(): void {
        const clip = this.event.clip;
        if (clip == null) {
            this._player.replaceChildren(h("p", { class: "san-meta", text: "Audio indisponible : texte seul." }));
            return;
        }
        this._player.replaceChildren(button(`Écouter (${formatClock(clip.duration_ms)})`, "btn-secondary", async (play) => {
            try {
                const blob = await this._context.clip(clip.id);
                this._objectUrl = URL.createObjectURL(blob);
                const audio = h("audio", { src: this._objectUrl });
                audio.controls = true;
                audio.addEventListener("play", () => this._context.seen(this.event.id));
                this._player.replaceChildren(audio);
                audio.play().catch(() => { /* lecture refusée : les commandes restent affichées */ });
            } catch (error) {
                play.disabled = false;
                reportError(error);
            }
        }, "ph-play"));
    }

    public dispose(): void {
        if (this._objectUrl != null) {
            URL.revokeObjectURL(this._objectUrl);
            this._objectUrl = null;
        }
    }

}
