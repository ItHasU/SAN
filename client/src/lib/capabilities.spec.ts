import { describe, expect, it } from "vitest";
import { buildCapabilities, recordingType } from "./capabilities";

const recorder = (supported: string[]) => ({ isTypeSupported: (type: string) => supported.includes(type) });

describe("capacités du viewer web", () => {
    it("préfère webm/opus quand il est disponible", () => {
        expect(recordingType({ mediaRecorder: recorder(["audio/webm;codecs=opus", "audio/mp4"]), hasGetUserMedia: true })).toBe("audio/webm;codecs=opus");
    });
    it("se replie sur audio/mp4 (Safari iOS) et le déclare dans audio_in", () => {
        const env = { mediaRecorder: recorder(["audio/mp4"]), hasGetUserMedia: true };
        expect(recordingType(env)).toBe("audio/mp4");
        expect(buildCapabilities(env).audio_in?.formats).toEqual(["mp4"]);
    });
    it("ne déclare pas de micro sans MediaRecorder ou sans getUserMedia", () => {
        expect(buildCapabilities({ mediaRecorder: null, hasGetUserMedia: true }).audio_in).toBeUndefined();
        expect(buildCapabilities({ mediaRecorder: recorder(["audio/webm"]), hasGetUserMedia: false }).audio_in).toBeUndefined();
    });
});
