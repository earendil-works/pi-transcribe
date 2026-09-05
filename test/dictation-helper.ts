import { Deferred } from "../src/deferred.js";
import type { DictationCapture } from "../src/dictation-controller.js";
import type { DictationReservation } from "../src/transcription-service.js";

export class FakeCapture implements DictationCapture {
  onFrame?: (frame: Int16Array) => void;
  starts = 0;
  stops = 0;
  startError: Error | undefined;
  stopError: Error | undefined;
  stopGate: Deferred<{ pcm: Float32Array }> | undefined;
  pcm = new Float32Array(16000);
  start(): void {
    this.starts++;
    if (this.startError) throw this.startError;
  }
  stop(): Promise<{ pcm: Float32Array }> {
    this.stops++;
    if (this.stopError) return Promise.reject(this.stopError);
    return this.stopGate?.promise ?? Promise.resolve({ pcm: this.pcm });
  }
}

export class FakeReservation implements DictationReservation {
  readonly prepared = new Deferred();
  readonly ready = this.prepared.promise;
  readonly result = new Deferred<string>();
  readonly chunks: Float32Array[] = [];
  cancelled = 0;
  submissions = 0;
  pcm: Float32Array | undefined;
  signal: AbortSignal | undefined;
  feed(chunk: Float32Array): void { this.chunks.push(chunk); }
  submit(pcm: Float32Array, signal?: AbortSignal): Promise<string> {
    this.submissions++;
    this.pcm = pcm;
    this.signal = signal;
    return this.result.promise;
  }
  cancel(): void { if (!this.submissions) this.cancelled++; }
}

export function fakeDictationService() {
  const reservations: FakeReservation[] = [];
  return {
    reservations,
    reserveDictation() {
      const reservation = new FakeReservation();
      reservations.push(reservation);
      return reservation;
    },
  };
}
