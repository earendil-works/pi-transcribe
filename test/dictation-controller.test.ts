import { test } from "node:test";
import assert from "node:assert/strict";
import { DictationController, type DictationState } from "../src/dictation-controller.js";
import { Deferred } from "../src/deferred.js";
import { settingsForModel } from "../src/settings.js";
import { TranscriptionService } from "../src/transcription-service.js";
import { FakeCapture, fakeDictationService } from "./dictation-helper.js";
import { nextTurn } from "./helpers.js";

const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/test-model");

function harness() {
  const service = fakeDictationService();
  const captures: FakeCapture[] = [];
  const states: DictationState[] = [];
  let now = 0;
  const controller = new DictationController(service, {
    createCapture: () => { const capture = new FakeCapture(); captures.push(capture); return capture; },
    now: () => now,
    onChange: (state) => states.push(state),
  });
  return { controller, service, captures, states, time: (value: number) => { now = value; } };
}

test("prewarming, streaming chunks, final tail and timing have one lifecycle", async () => {
  const h = harness();
  h.controller.prepare(settings);
  const reservation = h.service.reservations[0]!;
  assert.equal(h.captures.length, 0);
  reservation.prepared.resolve();
  await nextTurn();
  assert.equal(h.controller.modelState, "ready");
  await h.controller.start(settings);
  assert.equal(h.service.reservations.length, 1);
  const capture = h.captures[0]!;
  capture.onFrame!(new Int16Array(8000).fill(100));
  capture.onFrame!(new Int16Array(512).fill(200));
  assert.equal(reservation.chunks.length, 1);
  h.time(60000); // Wall-clock recording time must not be reported as PCM duration.
  const submission = h.controller.stop();
  assert.equal(h.controller.stop(), submission);
  await nextTurn();
  assert.deepEqual(reservation.chunks.map((chunk) => chunk.length), [8000, 512]);
  assert.equal(reservation.pcm, capture.pcm);
  h.time(61500);
  reservation.result.resolve("hello");
  assert.deepEqual(await submission, { text: "hello", speechSeconds: 1, transcribeSeconds: 1.5 });
  assert.equal(capture.stops, 1);
  assert.equal(h.controller.state.phase, "result");
  await h.controller.dispose();
});

test("duplicate starts cannot open two microphones", async () => {
  const h = harness();
  await Promise.all([h.controller.start(settings), h.controller.start(settings)]);
  assert.equal(h.captures.length, 1);
  assert.equal(h.service.reservations.length, 1);
  await h.controller.dispose();
});

test("capture cancellation discards the tail and waits for native teardown", async () => {
  const h = harness();
  await h.controller.start(settings);
  const capture = h.captures[0]!;
  capture.stopGate = new Deferred();
  capture.onFrame!(new Int16Array(512));
  const oldCallback = capture.onFrame!;
  const cancelling = h.controller.cancel();
  assert.equal(h.controller.state.phase, "cancelling");
  await h.controller.start(settings);
  assert.equal(h.captures.length, 1);
  oldCallback(new Int16Array(8000));
  assert.equal(h.service.reservations[0]!.chunks.length, 0);
  capture.stopGate.resolve({ pcm: capture.pcm });
  await cancelling;
  assert.equal(h.controller.state.phase, "idle");
  await h.controller.start(settings);
  assert.equal(h.captures.length, 2);
  assert.equal(h.service.reservations[0]!.submissions, 0);
  await h.controller.dispose();
});

test("cancelling while stop is pending never submits the discarded recording", async () => {
  const h = harness();
  await h.controller.start(settings);
  h.captures[0]!.stopGate = new Deferred();
  const submission = h.controller.stop();
  const cancelling = h.controller.cancel();
  h.captures[0]!.stopGate.resolve({ pcm: new Float32Array(16000) });
  assert.equal(await submission, undefined);
  await cancelling;
  assert.equal(h.service.reservations[0]!.submissions, 0);
  assert.equal(h.captures[0]!.stops, 1);
  await h.controller.dispose();
});

test("a cancelled transcription cannot publish a late successful result", async () => {
  const h = harness();
  await h.controller.start(settings);
  const submission = h.controller.stop();
  await nextTurn();
  const reservation = h.service.reservations[0]!;
  const cancelling = h.controller.cancel();
  assert.equal(reservation.signal?.aborted, true);
  reservation.result.resolve("late text");
  assert.equal(await submission, undefined);
  await cancelling;
  assert.equal(h.states.some((state) => state.phase === "result"), false);
  await h.controller.dispose();
});

test("model preparation failure is retryable and stale readiness is ignored", async () => {
  const h = harness();
  h.controller.prepare(settings);
  h.service.reservations[0]!.prepared.reject(new Error("load failed"));
  await nextTurn();
  assert.equal(h.controller.state.phase, "error");
  await h.controller.start(settings);
  assert.equal(h.service.reservations[0]!.cancelled, 1);
  assert.equal(h.service.reservations.length, 2);
  assert.equal(h.controller.state.phase, "listening");
  await h.controller.cancel();
  const paints = h.states.length;
  h.service.reservations[1]!.prepared.resolve();
  await nextTurn();
  assert.equal(h.states.length, paints);
  await h.controller.dispose();
});

for (const failure of ["start", "stop"] as const) {
  test(`microphone ${failure} failure releases the reservation and allows retry`, async () => {
    const service = fakeDictationService();
    const capture = new FakeCapture();
    if (failure === "start") capture.startError = new Error("permission denied");
    else capture.stopError = new Error("device disconnected");
    const controller = new DictationController(service, { createCapture: () => capture });
    await controller.start(settings);
    if (failure === "stop") await controller.stop();
    assert.equal(controller.state.phase, "error");
    assert.equal(service.reservations[0]!.cancelled, 1);
    capture.startError = capture.stopError = undefined;
    await controller.start(settings);
    assert.equal(controller.state.phase, "listening");
    await controller.dispose();
  });
}

test("disposal is idempotent and silences pending preparation and capture callbacks", async () => {
  const h = harness();
  await h.controller.start(settings);
  const frame = h.captures[0]!.onFrame!;
  await Promise.all([h.controller.dispose(), h.controller.dispose()]);
  const before = h.states.length;
  h.service.reservations[0]!.prepared.resolve();
  frame(new Int16Array(8000));
  await h.controller.start(settings);
  await nextTurn();
  assert.equal(h.controller.state.phase, "disposed");
  assert.equal(h.states.length, before);
  assert.equal(h.captures[0]!.stops, 1);
  assert.equal(h.service.reservations[0]!.chunks.length, 0);
});

test("disposal before microphone startup never opens a device", async () => {
  const h = harness();
  const starting = h.controller.start(settings);
  await h.controller.dispose();
  await starting;
  assert.equal(h.captures.length, 0);
});

test("controller disposal resets streams and leaves the injected service usable", async () => {
  let resets = 0;
  const service = new TranscriptionService(() => ({
    async prepare() {},
    async startStream() {
      return { async feed() {}, async finalize() { return "streamed"; }, reset() { resets++; } };
    },
    async transcribe() { return "file text"; },
    async dispose() {},
  }));
  const controller = new DictationController(service, { createCapture: () => new FakeCapture() });
  controller.prepare(settings);
  await nextTurn();
  await controller.start(settings);
  await controller.dispose();
  assert.ok(resets > 0);
  assert.equal(await service.transcribeFile(settings, Float32Array.of(1)), "file text");
  await service.shutdown();
});

test("display failures do not interrupt feeding, submission, or cleanup", async () => {
  const service = fakeDictationService();
  const capture = new FakeCapture();
  const controller = new DictationController(service, {
    createCapture: () => capture,
    onChange: () => { throw new Error("render failed"); },
    onFrame: () => { throw new Error("meter failed"); },
  });
  await controller.start(settings);
  capture.onFrame!(new Int16Array(8000));
  assert.equal(service.reservations[0]!.chunks.length, 1);
  const submission = controller.stop();
  service.reservations[0]!.result.resolve("still works");
  assert.equal((await submission)?.text, "still works");
  await controller.dispose();
});
