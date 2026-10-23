/** Un message SSE complet (WHATWG « Server-sent events », §9.2) */
export interface SseMessage {
    /** Type de l'événement ; `message` par défaut */
    event: string;
    /** Lignes `data:` jointes par `\n` */
    data: string;
    /** Dernier `id:` reçu sur ce flux (persiste d'un message à l'autre, comme `lastEventId`) */
    id?: string;
}

/**
 * Analyseur incrémental d'un flux `text/event-stream`, indépendant du transport :
 * on lui passe les fragments décodés, il rend les messages complets. Gère les
 * fragments coupés n'importe où (y compris entre `\r` et `\n`), les fins de
 * ligne `\n`, `\r\n` et `\r`, les commentaires (battements `:`) et les
 * données sur plusieurs lignes.
 */
export class SseParser {

    protected _buffer = "";
    protected _event = "";
    protected _data: string[] = [];
    protected _hasData = false;
    protected _lastId: string | undefined;
    protected _started = false;

    /** Dernier identifiant reçu (pour `Last-Event-ID`) */
    public get lastEventId(): string | undefined {
        return this._lastId;
    }

    /** Indique l'identifiant de reprise connu avant le premier fragment */
    public setLastEventId(id: string | undefined): void {
        this._lastId = id;
    }

    /** Ajoute un fragment ; rend les messages devenus complets */
    public feed(chunk: string): SseMessage[] {
        this._buffer += chunk;
        if (!this._started && this._buffer.length > 0) {
            this._started = true;
            if (this._buffer.charCodeAt(0) === 0xFEFF) {
                this._buffer = this._buffer.slice(1);
            }
        }
        const messages: SseMessage[] = [];
        let start = 0;
        for (;;) {
            const end = this._lineEnd(start);
            if (end == null) {
                break;
            }
            const line = this._buffer.slice(start, end.index);
            start = end.next;
            const message = this._line(line);
            if (message != null) {
                messages.push(message);
            }
        }
        this._buffer = this._buffer.slice(start);
        return messages;
    }

    /** Position de la prochaine fin de ligne complète à partir de `from` ; null si le tampon n'en contient pas */
    protected _lineEnd(from: number): { index: number, next: number } | null {
        for (let i = from; i < this._buffer.length; i++) {
            const char = this._buffer[i];
            if (char === "\n") {
                return { index: i, next: i + 1 };
            }
            if (char === "\r") {
                if (i + 1 >= this._buffer.length) {
                    // Peut-être un `\r\n` coupé : attendre le fragment suivant
                    return null;
                }
                return { index: i, next: this._buffer[i + 1] === "\n" ? i + 2 : i + 1 };
            }
        }
        return null;
    }

    protected _line(line: string): SseMessage | null {
        if (line === "") {
            return this._dispatch();
        }
        if (line.startsWith(":")) {
            return null;
        }
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) {
            value = value.slice(1);
        }
        switch (field) {
            case "event":
                this._event = value;
                break;
            case "data":
                this._data.push(value);
                this._hasData = true;
                break;
            case "id":
                if (!value.includes("\0")) {
                    this._lastId = value;
                }
                break;
            default:
                // `retry` et champs inconnus : ignorés (la reconnexion a son propre backoff)
                break;
        }
        return null;
    }

    protected _dispatch(): SseMessage | null {
        const hadData = this._hasData;
        const message: SseMessage = { event: this._event === "" ? "message" : this._event, data: this._data.join("\n") };
        if (this._lastId !== undefined) {
            message.id = this._lastId;
        }
        this._event = "";
        this._data = [];
        this._hasData = false;
        return hadData ? message : null;
    }

}
