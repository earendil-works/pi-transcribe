import type {
  EventBus,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createPiTranscribeEventBridge,
  PI_TRANSCRIBE_STATE_EVENT,
  PI_TRANSCRIBE_TOGGLE_EVENT,
} from "../src/events.js";

function createTestBus(): EventBus {
  const handlers = new Map<string, (data: unknown) => void>();
  return {
    emit: (channel, data) => handlers.get(channel)?.(data),
    on(channel, handler) {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    },
  };
}

test("toggle events are bound to the live session", () => {
  const bus = createTestBus();
  const context = {} as ExtensionContext;
  const toggled: ExtensionContext[] = [];
  const states: unknown[] = [];
  bus.on(PI_TRANSCRIBE_STATE_EVENT, (event) => states.push(event));
  const bridge = createPiTranscribeEventBridge(bus, (ctx) => toggled.push(ctx));

  bus.emit(PI_TRANSCRIBE_TOGGLE_EVENT, {});
  assert.deepEqual(toggled, []);

  bridge.sessionStarted(context);
  bus.emit(PI_TRANSCRIBE_TOGGLE_EVENT, {});
  assert.deepEqual(toggled, [context]);
  assert.deepEqual(states, [{ state: "idle" }]);

  bridge.shutdown();
  bus.emit(PI_TRANSCRIBE_TOGGLE_EVENT, {});
  assert.deepEqual(toggled, [context]);
});
