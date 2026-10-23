import { describe, expect, it } from "vitest";
import { SseParser } from "./sse";

describe("SseParser", () => {
    it("rend un message complet avec type, données et id", () => {
        const parser = new SseParser();
        expect(parser.feed("id: 7\nevent: event\ndata: {\"a\":1}\n\n")).toEqual([{ event: "event", data: "{\"a\":1}", id: "7" }]);
        expect(parser.lastEventId).toBe("7");
    });

    it("recolle les fragments coupés n'importe où", () => {
        const parser = new SseParser();
        const stream = "id: 12\nevent: state\ndata: {\"x\":\"é\"}\n\n";
        const out = [];
        for (const char of stream) {
            out.push(...parser.feed(char));
        }
        expect(out).toEqual([{ event: "state", data: "{\"x\":\"é\"}", id: "12" }]);
    });

    it("joint les lignes data multiples par un saut de ligne", () => {
        expect(new SseParser().feed("data: a\ndata: b\ndata:\ndata: c\n\n")).toEqual([{ event: "message", data: "a\nb\n\nc" }]);
    });

    it("ignore les battements et commentaires", () => {
        const parser = new SseParser();
        expect(parser.feed(":\n\n")).toEqual([]);
        expect(parser.feed(": ping\n\n:\n\n")).toEqual([]);
        expect(parser.feed("event: hello\ndata: {}\n\n")).toHaveLength(1);
    });

    it("gère \\r\\n, \\r seul et un \\r\\n coupé entre deux fragments", () => {
        const parser = new SseParser();
        expect(parser.feed("event: a\r\ndata: 1\r\n\r\n")).toEqual([{ event: "a", data: "1" }]);
        expect(parser.feed("data: 2\r\r")).toEqual([]);
        expect(parser.feed("\n")).toEqual([{ event: "message", data: "2" }]);
        expect(parser.feed("data: 3\r")).toEqual([]);
        expect(parser.feed("\n\r\n")).toEqual([{ event: "message", data: "3" }]);
    });

    it("garde l'id d'un message à l'autre, comme lastEventId", () => {
        const parser = new SseParser();
        const messages = parser.feed("id: 1\ndata: a\n\ndata: b\n\nid: 3\ndata: c\n\n");
        expect(messages.map((m) => m.id)).toEqual(["1", "1", "3"]);
    });

    it("n'émet rien sans data (un id seul met seulement à jour le curseur)", () => {
        const parser = new SseParser();
        expect(parser.feed("id: 9\n\n")).toEqual([]);
        expect(parser.lastEventId).toBe("9");
    });

    it("retire l'espace unique après les deux-points et le BOM", () => {
        expect(new SseParser().feed("\uFEFFdata:  x\n\n")).toEqual([{ event: "message", data: " x" }]);
    });

    it("ignore retry et les champs inconnus", () => {
        expect(new SseParser().feed("retry: 1000\nfoo: bar\ndata: ok\n\n")).toEqual([{ event: "message", data: "ok" }]);
    });
});
