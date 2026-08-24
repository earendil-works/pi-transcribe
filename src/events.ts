import type {
  EventBus,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const PI_TRANSCRIBE_TOGGLE_EVENT = "pi-transcribe:toggle";
export const PI_TRANSCRIBE_STATE_EVENT = "pi-transcribe:state";

export type PiTranscribeState = "starting" | "recording" | "transcribing" | "idle";

export type PiTranscribeStateEvent = { state: PiTranscribeState };

export function emitPiTranscribeState(
  events: EventBus,
  state: PiTranscribeState,
): void {
  events.emit(PI_TRANSCRIBE_STATE_EVENT, { state } satisfies PiTranscribeStateEvent);
}

/** Keep toggle events bound to the context for the live session only. */
export function createPiTranscribeEventBridge(
  events: EventBus,
  toggle: (ctx: ExtensionContext) => void,
): {
  sessionStarted(ctx: ExtensionContext): void;
  shutdown(): void;
} {
  let currentContext: ExtensionContext | undefined;
  const stopListening = events.on(PI_TRANSCRIBE_TOGGLE_EVENT, () => {
    if (currentContext) toggle(currentContext);
  });

  return {
    sessionStarted(ctx): void {
      currentContext = ctx;
      emitPiTranscribeState(events, "idle");
    },
    shutdown(): void {
      currentContext = undefined;
      stopListening();
    },
  };
}
