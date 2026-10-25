import { openDialog } from "@dagda/client/src/components/dialog/dialog.component";
import { showToast } from "@dagda/client/src/components/toast/toast.component";
import { AccessPair, Impact } from "@san/shared/src/api/types";
import { Mutation, API_BASE } from "../lib/api";
import { h, icon } from "../lib/dom";
import { button, copyText, field, reportError, textInput } from "./common";

/** Regroupe les couples (viewer, agent) par viewer */
export function groupByViewer(pairs: AccessPair[]): Array<{ viewer: string, name: string, agents: string[] }> {
    const groups = new Map<string, { viewer: string, name: string, agents: string[] }>();
    for (const pair of pairs) {
        const entry = groups.get(pair.viewer) ?? { viewer: pair.viewer, name: pair.viewer_name ?? pair.viewer, agents: [] };
        entry.agents.push(pair.agent);
        groups.set(pair.viewer, entry);
    }
    return [...groups.values()];
}

function impactList(title: string, kind: "gained" | "lost", pairs: AccessPair[]): HTMLElement | null {
    if (pairs.length === 0) {
        return null;
    }
    const list = h("ul", { class: "san-impact-list" });
    for (const group of groupByViewer(pairs)) {
        list.appendChild(h("li", {}, h("strong", { text: group.name }), h("span", { text: ` → ${group.agents.join(", ")}` })));
    }
    return h("div", { class: `san-impact san-impact-${kind}`, data: { impact: kind } },
        h("h4", {}, icon(kind === "gained" ? "ph-plus-circle" : "ph-minus-circle"), ` ${title} (${pairs.length})`), list);
}

/** Corps d'un dialogue d'impact : qui gagne ou perd l'accès à quoi */
export function impactBody(impact: Impact, intro?: string): HTMLElement {
    const body = h("div", { class: "san-dialog-body" });
    if (intro != null) {
        body.appendChild(h("p", { text: intro }));
    }
    const gained = impactList("Gagnent l'accès", "gained", impact.gained);
    const lost = impactList("Perdent l'accès", "lost", impact.lost);
    if (gained == null && lost == null) {
        body.appendChild(h("p", { class: "text-muted", data: { impact: "none" }, text: "Aucun changement d'accès pour les viewers actifs." }));
    }
    body.append(...[gained, lost].filter((node): node is HTMLElement => node != null));
    return body;
}

export interface ConfirmImpactOptions<T> {
    title: string;
    intro?: string;
    mutation: Mutation<T>;
    confirmLabel: string;
    danger?: boolean;
    /** Rend `false` si elle ouvre un autre dialogue (qui ne doit pas être refermé) */
    onApplied: (result: T) => void | false | Promise<void | false>;
}

/**
 * Toute action qui modifie la couverture : aperçu (`?dry_run=1`), confirmation
 * listant les viewers qui gagnent ou perdent l'accès, puis application (SPEC §11).
 */
export async function confirmImpact<T>(options: ConfirmImpactOptions<T>): Promise<void> {
    let impact: Impact;
    try {
        impact = await options.mutation.preview();
    } catch (error) {
        reportError(error);
        return;
    }
    openDialog({
        title: options.title,
        body: impactBody(impact, options.intro),
        actions: [
            { label: "Annuler", className: "btn-secondary" },
            {
                label: options.confirmLabel,
                className: options.danger === true ? "btn-danger" : "btn-primary",
                onClick: async () => {
                    const result = await options.mutation.apply();
                    return options.onApplied(result);
                }
            }
        ]
    });
}

export interface PromptField {
    key: string;
    label: string;
    value?: string;
    hint?: string;
    /** Rend un message d'erreur ou null */
    validate?: (value: string) => string | null;
}

/**
 * Dialogue de saisie ; `onSubmit` reçoit les valeurs validées. Si `onSubmit`
 * ouvre un autre dialogue, il rend `false` pour que celui-ci ne soit pas refermé.
 */
export function promptDialog(title: string, fields: PromptField[], submitLabel: string, onSubmit: (values: Record<string, string>) => Promise<void | false> | void | false, intro?: string): void {
    const inputs = new Map<string, HTMLInputElement>();
    const errors = new Map<string, HTMLElement>();
    const body = h("form", { class: "san-dialog-body" });
    body.addEventListener("submit", (event) => event.preventDefault());
    if (intro != null) {
        body.appendChild(h("p", { text: intro }));
    }
    for (const spec of fields) {
        const input = textInput({ value: spec.value ?? "", name: spec.key });
        const error = h("div", { class: "san-error", role: "alert" });
        inputs.set(spec.key, input);
        errors.set(spec.key, error);
        if (spec.validate != null) {
            const validate = spec.validate;
            input.addEventListener("input", () => { error.textContent = validate(input.value.trim()) ?? ""; });
        }
        body.append(field(spec.label, input, spec.hint), error);
    }
    openDialog({
        title,
        body,
        actions: [
            { label: "Annuler", className: "btn-secondary" },
            {
                label: submitLabel,
                className: "btn-primary",
                onClick: () => {
                    const values: Record<string, string> = {};
                    let invalid = false;
                    for (const spec of fields) {
                        const value = inputs.get(spec.key)!.value.trim();
                        const message = spec.validate?.(value) ?? null;
                        errors.get(spec.key)!.textContent = message ?? "";
                        invalid ||= message != null;
                        values[spec.key] = value;
                    }
                    if (invalid) {
                        return false;
                    }
                    return onSubmit(values);
                }
            }
        ]
    });
    setTimeout(() => inputs.values().next().value?.focus(), 0);
}

/** Zone de texte en lecture seule avec bouton de copie */
function copyBlock(label: string, text: string, multiline: boolean): HTMLElement {
    const control = multiline
        ? h("textarea", { class: "input san-code", value: text, "aria-label": label, data: { copy: label } })
        : h("input", { type: "text", class: "input san-code", value: text, "aria-label": label, data: { copy: label } });
    (control as HTMLInputElement | HTMLTextAreaElement).readOnly = true;
    if (multiline) {
        (control as HTMLTextAreaElement).rows = 6;
    }
    control.addEventListener("focus", () => (control as HTMLInputElement).select());
    const copy = button("Copier", "btn-secondary", async () => {
        showToast(await copyText(text) ? "Copié." : "Copie impossible : sélectionnez le texte.", "info");
    }, "ph-copy");
    return h("div", { class: "san-copy" }, h("h4", { text: label }), control, copy);
}

/** Exemple `curl` prêt à copier pour publier l'état d'un agent */
export function curlExample(token: string, origin: string = window.location.origin): string {
    return [
        `API=${origin}${API_BASE}`,
        `TOKEN=${token}`,
        ``,
        `curl -sX POST $API/agent/state -H "Authorization: Bearer $TOKEN" \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '{"status":"working","detail":"Analyse du dépôt","progress":40,"ttl_s":900}'`
    ].join("\n");
}

/** Affiche un jeton d'agent UNE SEULE FOIS, dans une boîte copiable avec avertissement */
export function showAgentToken(agentName: string, token: string): void {
    const body = h("div", { class: "san-dialog-body", data: { secret: "agent-token" } },
        h("p", { class: "san-warning" }, icon("ph-warning"), " Ce jeton ne sera plus jamais affiché. Copiez-le maintenant et conservez-le en lieu sûr : en cas de perte, il faudra en générer un nouveau."),
        copyBlock("Jeton de l'agent", token, false),
        copyBlock("Exemple curl", curlExample(token), true));
    openDialog({ title: `Jeton de ${agentName}`, body, actions: [{ label: "J'ai copié le jeton", className: "btn-primary" }] });
}

/** Exemple `curl` d'enrôlement automatique d'un agent avec un jeton d'enrôlement (SPEC §4bis) */
export function enrollmentCurlExample(enrollmentToken: string, origin: string = window.location.origin): string {
    return [
        `API=${origin}${API_BASE}`,
        `ENROLLMENT_TOKEN=${enrollmentToken}`,
        ``,
        `# Réponse 201 : {"slug","status":"active","token":"agt_…","group"} — le jeton d'agent n'est renvoyé qu'une fois`,
        `curl -sX POST $API/agent/register -H 'Content-Type: application/json' \\`,
        `  -d '{"slug":"mon-agent","name":"Mon agent","enrollment_token":"'"$ENROLLMENT_TOKEN"'"}'`
    ].join("\n");
}

/**
 * Affiche un jeton d'enrôlement UNE SEULE FOIS. `onDone` s'exécute à la fermeture
 * (ex. rouvrir la liste des jetons du groupe).
 */
export function showEnrollmentToken(groupName: string, token: string, onDone?: () => void): void {
    const body = h("div", { class: "san-dialog-body", data: { secret: "enrollment-token" } },
        h("p", { class: "san-warning" }, icon("ph-warning"), " Ce jeton ne sera plus jamais affiché. Quiconque le détient peut créer des agents actifs dans ce groupe : conservez-le en lieu sûr, et révoquez-le en cas de fuite."),
        copyBlock("Jeton d'enrôlement", token, false),
        copyBlock("Exemple curl", enrollmentCurlExample(token), true));
    openDialog({
        title: `Jeton d'enrôlement de ${groupName}`,
        body,
        actions: [{ label: "J'ai copié le jeton", className: "btn-primary", onClick: () => { onDone?.(); return onDone == null ? undefined : false; } }]
    });
}
