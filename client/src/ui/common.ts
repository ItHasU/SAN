import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { AgentStatus, ViewerRecord } from "@san/shared/src/api/types";
import { ApiError } from "../lib/api";
import { Child, h, icon, Props } from "../lib/dom";

export const STATUS_LABELS: Record<AgentStatus, string> = {
    idle: "Au repos",
    working: "En cours",
    waiting: "En attente",
    error: "Erreur",
    done: "Terminé"
};

const STATUS_TAG: Record<AgentStatus, string> = {
    idle: "tag-neutral",
    working: "tag-info",
    waiting: "tag-warning",
    error: "tag-danger",
    done: "tag-success"
};

/** Pastille de statut : point coloré + libellé (jamais la couleur seule) ; `stale` ajoute « périmé » */
export function statusBadge(status: AgentStatus | string, stale: boolean): HTMLElement {
    const known = (Object.keys(STATUS_LABELS) as AgentStatus[]).includes(status as AgentStatus);
    const label = known ? STATUS_LABELS[status as AgentStatus] : String(status);
    return h("span", { class: `tag ${known ? STATUS_TAG[status as AgentStatus] : "tag-neutral"} san-status`, data: { status: String(status), stale: String(stale) } },
        h("span", { class: "san-dot", "aria-hidden": "true" }),
        label,
        stale ? h("span", { class: "san-stale", text: " · périmé" }) : null
    );
}

/** Barre de progression 0–100 */
export function progressBar(progress: number | null | undefined): HTMLElement | null {
    if (progress == null || !Number.isFinite(progress)) {
        return null;
    }
    const value = Math.max(0, Math.min(100, Math.round(progress)));
    const bar = h("div", { class: "san-progress-bar" });
    bar.style.width = `${value}%`;
    return h("div", { class: "san-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(value), "aria-label": `Progression ${value} %` }, bar);
}

/** Champ de formulaire étiqueté */
export function field(label: string, control: HTMLElement, hint?: Child): HTMLElement {
    const id = control.id !== "" ? control.id : `f${Math.random().toString(36).slice(2, 9)}`;
    control.id = id;
    return h("div", { class: "field" }, h("label", { for: id, text: label }), control, hint == null ? null : h("div", { class: "san-hint text-muted" }, hint));
}

export function textInput(props: Props = {}): HTMLInputElement {
    return h("input", { type: "text", class: "input", autocomplete: "off", ...props });
}

export function button(label: string, variant: string, onClick: (button: HTMLButtonElement) => void | Promise<void>, iconName?: string, props: Props = {}): HTMLButtonElement {
    const element: HTMLButtonElement = h("button", { type: "button", class: `btn ${variant}`, ...props },
        iconName == null ? null : icon(iconName), label === "" ? null : h("span", { text: label }));
    element.addEventListener("click", () => {
        if (element.disabled) {
            return;
        }
        const result = onClick(element);
        if (result instanceof Promise) {
            element.disabled = true;
            result.catch(reportError).finally(() => { element.disabled = false; });
        }
    });
    return element;
}

/** Bouton icône seul : le libellé accessible est obligatoire */
export function iconButton(label: string, iconName: string, onClick: () => void | Promise<void>, props: Props = {}): HTMLButtonElement {
    const element = button("", "btn-secondary btn-icon", onClick, iconName, { "aria-label": label, title: label, ...props });
    return element;
}

export function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void, props: { disabled?: boolean } = {}): HTMLElement {
    const input = h("input", { type: "checkbox", checked, disabled: props.disabled });
    input.addEventListener("change", () => onChange(input.checked));
    return h("label", { class: "checkbox" }, input, h("span", { class: "box", "aria-hidden": "true" }), h("span", { text: label }));
}

/** Contrôle segmenté (radio) */
export function segmented<T extends string>(name: string, options: Array<{ value: T, label: string }>, selected: T, onChange: (value: T) => void): HTMLElement {
    const group = h("div", { class: "seg", role: "radiogroup" });
    for (const option of options) {
        const input = h("input", { type: "radio", name, value: option.value, checked: option.value === selected });
        input.addEventListener("change", () => {
            if (input.checked) {
                onChange(option.value);
            }
        });
        group.appendChild(h("label", { class: "seg-opt" }, input, h("span", { text: option.label })));
    }
    return group;
}

export function errorMessage(error: unknown): string {
    if (error instanceof ApiError) {
        return error.message;
    }
    return error instanceof Error ? error.message : String(error);
}

/** Affiche l'erreur dans un toast (jamais de jeton dans le message : les erreurs de l'API n'en contiennent pas) */
export function reportError(error: unknown): void {
    console.warn("Erreur :", errorMessage(error));
    showToast(errorMessage(error), "danger");
}

export function emptyState(text: string, ...extra: Child[]): HTMLElement {
    return h("div", { class: "san-empty text-muted" }, h("p", { text }), ...extra);
}

/** Nom d'affichage d'un viewer */
export function viewerLabel(viewer: Pick<ViewerRecord, "id" | "name" | "model" | "kind">): string {
    return viewer.name ?? viewer.model ?? (viewer.kind === "web" ? "Navigateur web" : viewer.id);
}

/** Copie dans le presse-papiers ; rend false si le navigateur refuse */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

export function pageHeader(title: string, ...actions: Child[]): HTMLElement {
    return h("div", { class: "san-header" }, h("h2", { text: title }), h("div", { class: "san-actions" }, ...actions));
}

export function section(title: string, ...content: Child[]): HTMLElement {
    return h("section", { class: "san-section" }, h("h3", { text: title }), ...content);
}
