/**
 * « il y a 5 min », « dans 2 h »… `now` est injectable (tests).
 * Les dates invalides rendent un tiret.
 */
export function formatRelative(value: string | number | Date | null | undefined, now: number | Date = Date.now()): string {
    if (value == null) {
        return "—";
    }
    const time = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
    if (Number.isNaN(time)) {
        return "—";
    }
    const diffS = Math.round(((now instanceof Date ? now.getTime() : now) - time) / 1000);
    const future = diffS < 0;
    const abs = Math.abs(diffS);
    if (abs < 5) {
        return future ? "dans un instant" : "à l'instant";
    }
    const unit = abs < 60 ? `${abs} s`
        : abs < 3600 ? `${Math.floor(abs / 60)} min`
            : abs < 86400 ? `${Math.floor(abs / 3600)} h`
                : `${Math.floor(abs / 86400)} j`;
    return future ? `dans ${unit}` : `il y a ${unit}`;
}

/** Durée d'un clip ou d'un enregistrement : `0:04`, `1:05` */
export function formatClock(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms) || ms < 0) {
        return "0:00";
    }
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
