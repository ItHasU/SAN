import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { MAX_RECORDING_S } from "../../lib/capabilities";
import { h, icon } from "../../lib/dom";
import { VoiceRecorder } from "../../lib/recorder";
import { TrackedAgent } from "../../lib/store";
import { formatClock, formatRelative } from "../../lib/time";
import { button, progressBar, reportError, statusBadge, statusIcon } from "../../ui/common";

export interface AgentCardContext {
    /** Le navigateur sait enregistrer (MediaRecorder + getUserMedia) */
    canRecord: boolean;
    sendVoice(agent: string, audio: Blob): Promise<void>;
}

/**
 * Carte d'un agent suivi. Les éléments sont créés une fois ; `update()` ne
 * touche que ce qui change, pour ne pas couper un enregistrement en cours.
 */
export class AgentCard {

    public readonly element: HTMLElement;
    protected readonly _head = h("div", { class: "san-row san-row-between" });
    protected readonly _icon = h("div", { class: "san-agent-icon" });
    protected readonly _title = h("div", { class: "san-title" });
    protected readonly _badge = h("div");
    protected readonly _detail = h("p", { class: "san-detail" });
    protected readonly _progress = h("div");
    protected readonly _meta = h("p", { class: "san-meta" });
    protected readonly _voice = h("div", { class: "san-row" });
    protected readonly _recorder = new VoiceRecorder();
    protected _recordTimer: ReturnType<typeof setInterval> | null = null;
    protected _slug = "";
    protected _micButton!: HTMLButtonElement;
    protected _cancelButton!: HTMLButtonElement;

    constructor(protected readonly _context: AgentCardContext) {
        this._head.append(h("div", { class: "san-row san-agent-name" }, this._icon, this._title), this._badge);
        this.element = h("article", { class: "san-card san-agent" }, this._head, this._detail, this._progress, this._meta, this._voice);
        this._micButton = button("Parler", "btn-secondary san-rec", () => this._toggleRecording(), "ph-microphone");
        this._cancelButton = button("Annuler", "btn-ghost", () => this._cancel());
        this._cancelButton.hidden = true;
        this._voice.append(this._micButton, this._cancelButton);
    }

    public update(tracked: TrackedAgent, now: number): void {
        const { config, state } = tracked;
        this._slug = config.agent;
        this.element.dataset["agent"] = config.agent;
        this.element.dataset["stale"] = String(state?.stale === true);
        this.element.dataset["muted"] = String(config.muted);
        this._title.textContent = config.name;
        if (config.muted) {
            this._title.appendChild(h("span", { class: "tag tag-outline", text: "muet" }));
        }
        this._icon.replaceChildren(statusIcon(state?.status ?? null));
        const badge = state == null ? h("span", { class: "tag tag-neutral", text: "Aucun état" }) : statusBadge(state.status, state.stale);
        this._badge.replaceChildren(badge);
        const detail = state?.detail ?? "";
        this._detail.textContent = detail;
        this._detail.hidden = detail === "";
        const bar = progressBar(state?.progress);
        this._progress.replaceChildren(...(bar == null ? [] : [bar]));
        this._meta.textContent = state == null ? "" : `mis à jour ${formatRelative(state.updated_at, now)}`;
        this._voice.hidden = !(config.can_send_voice && this._context.canRecord);
    }

    protected async _toggleRecording(): Promise<void> {
        if (this._recorder.recording) {
            await this._finish(true);
            return;
        }
        try {
            await this._recorder.start(() => { void this._finish(true); });
        } catch (error) {
            showToast(error instanceof DOMException && error.name === "NotAllowedError" ? "Accès au micro refusé." : "Micro indisponible.", "danger");
            return;
        }
        this._micButton.dataset["recording"] = "true";
        this._cancelButton.hidden = false;
        this._renderRecording();
        this._recordTimer = setInterval(() => this._renderRecording(), 250);
    }

    protected _renderRecording(): void {
        const label = this._micButton.querySelector("span");
        const icone = this._micButton.querySelector("i");
        if (label != null) {
            label.textContent = `Envoyer ${formatClock(this._recorder.elapsedMs)} / ${formatClock(MAX_RECORDING_S * 1000)}`;
        }
        icone?.setAttribute("class", "ph ph-paper-plane-tilt");
    }

    protected _reset(): void {
        if (this._recordTimer != null) {
            clearInterval(this._recordTimer);
            this._recordTimer = null;
        }
        delete this._micButton.dataset["recording"];
        this._cancelButton.hidden = true;
        this._micButton.replaceChildren(icon("ph-microphone"), h("span", { text: "Parler" }));
    }

    protected async _finish(send: boolean): Promise<void> {
        if (this._recordTimer == null && !this._recorder.recording) {
            return;
        }
        try {
            const result = await this._recorder.stop();
            this._reset();
            if (send && result.blob.size > 0) {
                await this._context.sendVoice(this._slug, result.blob);
                showToast("Message vocal envoyé.", "success");
            }
        } catch (error) {
            this._reset();
            reportError(error);
        }
    }

    protected _cancel(): void {
        this._recorder.cancel();
        this._reset();
    }

    public dispose(): void {
        this._recorder.cancel();
        this._reset();
    }

}
