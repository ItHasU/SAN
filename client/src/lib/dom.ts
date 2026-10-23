/**
 * Construction du DOM sans `innerHTML` : tout texte passe par `textContent`
 * (SPEC §14 — l'application web échappe tous les textes affichés).
 */

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
    class?: string;
    text?: string;
    type?: string;
    value?: string;
    title?: string;
    hidden?: boolean;
    disabled?: boolean;
    checked?: boolean;
    placeholder?: string;
    href?: string;
    src?: string;
    list?: string;
    role?: string;
    for?: string;
    id?: string;
    name?: string;
    min?: string;
    max?: string;
    step?: string;
    autocomplete?: string;
    inputMode?: string;
    "aria-label"?: string;
    "aria-hidden"?: string;
    "aria-current"?: string;
    "aria-expanded"?: string;
    "aria-live"?: string;
    "aria-pressed"?: string;
    "aria-valuenow"?: string;
    "aria-valuemin"?: string;
    "aria-valuemax"?: string;
    data?: Record<string, string>;
    on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
}

function append(parent: Node, child: Child): void {
    if (child == null || child === false) {
        return;
    }
    if (Array.isArray(child)) {
        for (const item of child) {
            append(parent, item);
        }
    } else if (typeof child === "string" || typeof child === "number") {
        parent.appendChild(document.createTextNode(String(child)));
    } else {
        parent.appendChild(child);
    }
}

/** Crée un élément ; les chaînes passées en enfant deviennent des nœuds texte */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null) {
            continue;
        }
        switch (key) {
            case "class": element.className = value as string; break;
            case "text": element.textContent = value as string; break;
            case "data":
                for (const [name, item] of Object.entries(value as Record<string, string>)) {
                    element.dataset[name] = item;
                }
                break;
            case "on":
                for (const [name, handler] of Object.entries(value as Record<string, EventListener>)) {
                    element.addEventListener(name, handler);
                }
                break;
            case "hidden": element.hidden = value as boolean; break;
            case "disabled": (element as HTMLButtonElement).disabled = value as boolean; break;
            case "checked": (element as HTMLInputElement).checked = value as boolean; break;
            case "value": (element as HTMLInputElement).value = value as string; break;
            case "for": element.setAttribute("for", value as string); break;
            default: element.setAttribute(key, String(value));
        }
    }
    append(element, children);
    return element;
}

/** Remplace le contenu d'un conteneur */
export function setChildren(parent: Element, ...children: Child[]): void {
    parent.replaceChildren();
    append(parent, children);
}

/** Icône Phosphor décorative (`name` : « ph-x », jamais une donnée serveur) */
export function icon(name: string): HTMLElement {
    return h("i", { class: `ph ${name}`, "aria-hidden": "true" } as Props);
}
