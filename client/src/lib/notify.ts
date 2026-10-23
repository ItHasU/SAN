import { EventView } from "@san/shared/src/api/types";

/** Notifications système et vibration pour les nudges (action de l'utilisateur pour la permission) */

export function notificationsSupported(): boolean {
    return typeof Notification !== "undefined";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
    return notificationsSupported() ? Notification.permission : "unsupported";
}

/** À appeler depuis un geste (clic) : les navigateurs refusent sinon */
export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
    if (!notificationsSupported()) {
        return "unsupported";
    }
    return Notification.requestPermission();
}

/** Vibre pour un nudge `high` si l'appareil sait le faire */
export function vibrateFor(event: EventView): boolean {
    if (event.priority !== "high" || typeof navigator === "undefined" || typeof navigator.vibrate !== "function") {
        return false;
    }
    return navigator.vibrate([200, 100, 200]);
}

/** Notification système (page masquée, permission accordée) ; le texte est passé tel quel, jamais interprété comme HTML */
export function showSystemNotification(event: EventView, agentName: string): void {
    if (notificationPermission() !== "granted" || document.visibilityState === "visible") {
        return;
    }
    try {
        new Notification(`${event.priority === "high" ? "Urgent — " : ""}${agentName}`, {
            body: event.text ?? (event.kind === "voice" ? "Message vocal" : "Nudge"),
            tag: `san-${event.id}`
        });
    } catch {
        /* certains mobiles exigent un service worker : on s'en passe */
    }
}
