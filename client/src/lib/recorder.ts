import { MAX_RECORDING_S, recordingType, browserEnv } from "./capabilities";

export interface RecordingResult {
    blob: Blob;
    durationMs: number;
}

/**
 * Enregistrement d'un message vocal via MediaRecorder. Une instance = un
 * enregistrement ; le micro est libéré dès l'arrêt (le navigateur éteint son voyant).
 */
export class VoiceRecorder {

    protected _recorder: MediaRecorder | null = null;
    protected _stream: MediaStream | null = null;
    protected _chunks: Blob[] = [];
    protected _startedAt = 0;
    protected _timer: ReturnType<typeof setTimeout> | null = null;
    protected _done: Promise<RecordingResult> | null = null;

    public get recording(): boolean {
        return this._recorder?.state === "recording";
    }

    public get elapsedMs(): number {
        return this.recording ? Date.now() - this._startedAt : 0;
    }

    /** Démarre ; `onLimit` est appelé quand la durée maximale arrête l'enregistrement */
    public async start(onLimit?: () => void): Promise<void> {
        const type = recordingType(browserEnv());
        if (type == null) {
            throw new Error("Enregistrement audio non pris en charge par ce navigateur.");
        }
        this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(this._stream, { mimeType: type });
        this._recorder = recorder;
        this._chunks = [];
        this._done = new Promise<RecordingResult>((resolve, reject) => {
            recorder.addEventListener("dataavailable", (event) => {
                if (event.data.size > 0) {
                    this._chunks.push(event.data);
                }
            });
            recorder.addEventListener("error", () => reject(new Error("Erreur d'enregistrement.")));
            recorder.addEventListener("stop", () => {
                this._release();
                resolve({ blob: new Blob(this._chunks, { type: recorder.mimeType || type }), durationMs: Date.now() - this._startedAt });
            });
        });
        this._startedAt = Date.now();
        recorder.start();
        this._timer = setTimeout(() => {
            this.stop().catch(() => { /* déjà arrêté */ });
            onLimit?.();
        }, MAX_RECORDING_S * 1000);
    }

    /** Arrête et rend l'enregistrement */
    public async stop(): Promise<RecordingResult> {
        if (this._recorder == null || this._done == null) {
            throw new Error("Aucun enregistrement en cours.");
        }
        if (this._recorder.state !== "inactive") {
            this._recorder.stop();
        }
        return this._done;
    }

    /** Abandonne sans rien produire */
    public cancel(): void {
        if (this._recorder != null && this._recorder.state !== "inactive") {
            this._recorder.stop();
        }
        this._release();
    }

    protected _release(): void {
        if (this._timer != null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._stream?.getTracks().forEach((track) => track.stop());
        this._stream = null;
    }

}
