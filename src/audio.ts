import { PvRecorder } from "@picovoice/pvrecorder-node";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";
import { convertFrames } from "./pcm.js";

export { CAPTURE_SAMPLE_RATE } from "./audio-constants.js";

const FRAME_LENGTH = 512;

const execFileAsync = promisify(execFile);

interface CapturedAudio {
  pcm: Float32Array;
}

type SelectedMicrophone = {
  name: string;
  occurrence: number;
};

export class MicrophoneUnavailableError extends Error {
  constructor(name: string) {
    super(`Selected microphone is unavailable: ${name}. Open /voice and choose another microphone.`);
    this.name = "MicrophoneUnavailableError";
  }
}

export function getAvailableMicrophones(): string[] {
  return PvRecorder.getAvailableDevices();
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

type MicPermissionResult =
  | { status: "granted" }
  | { status: "denied"; message: string }
  | { status: "not-determined"; message: string }
  | { status: "error"; message: string };

const JXA_PERMISSION_SCRIPT = [
  "-l",
  "JavaScript",
  "-e",
  [
    "ObjC.import('Foundation');",
    "ObjC.import('AVFoundation');",
    "var captureDevice = $.NSClassFromString('AVCaptureDevice');",
    "if (!captureDevice) throw new Error('AVCaptureDevice is unavailable');",
    "var status = captureDevice.authorizationStatusForMediaType($.AVMediaTypeAudio);",
    "status.toString();",
  ].join("\n"),
];

const MACOS_PERMISSION_STATUS = {
  NOT_DETERMINED: 0,
  RESTRICTED: 1,
  DENIED: 2,
  AUTHORIZED: 3,
} as const;

export async function testMicrophonePermission(): Promise<MicPermissionResult> {
  if (process.platform !== "darwin") return { status: "granted" };

  try {
    const { stdout } = await execFileAsync("osascript", JXA_PERMISSION_SCRIPT, {
      timeout: 5000,
    });
    const code = parseInt(stdout.trim(), 10);

    switch (code) {
      case MACOS_PERMISSION_STATUS.AUTHORIZED:
        return { status: "granted" };
      case MACOS_PERMISSION_STATUS.DENIED:
        return { status: "denied", message: "Microphone access denied in System Settings" };
      case MACOS_PERMISSION_STATUS.RESTRICTED:
        return { status: "denied", message: "Microphone access restricted by system policy" };
      case MACOS_PERMISSION_STATUS.NOT_DETERMINED:
        return { status: "not-determined", message: "Microphone access not yet requested" };
      default:
        return { status: "error", message: `Unknown mic permission status code: ${code}` };
    }
  } catch (error) {
    return {
      status: "error",
      message: `Could not check mic permission: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function findDeviceIndex(devices: readonly string[], selected: SelectedMicrophone): number {
  let occurrence = 0;
  for (let index = 0; index < devices.length; index += 1) {
    if (devices[index] !== selected.name) continue;
    if (occurrence === selected.occurrence) return index;
    occurrence += 1;
  }
  return -1;
}

export class MicrophoneCapture {
  private recorder: PvRecorder | undefined;
  private frames: Int16Array[] = [];
  private readLoop: Promise<void> | undefined;
  private stopping = false;
  private readError: Error | undefined;
  onFrame?: (frame: Int16Array) => void;

  constructor(private readonly selectedDevice?: SelectedMicrophone) {}

  start(): void {
    if (this.recorder) throw new Error("Microphone capture is already active");

    const deviceIndex = this.selectedDevice
      ? findDeviceIndex(getAvailableMicrophones(), this.selectedDevice)
      : -1;
    if (this.selectedDevice && deviceIndex < 0) {
      throw new MicrophoneUnavailableError(this.selectedDevice.name);
    }

    // PvRecorder asks the native device for 16 kHz mono Int16 PCM. Its miniaudio
    // layer performs any device-rate resampling and channel conversion.
    const recorder = new PvRecorder(FRAME_LENGTH, deviceIndex);

    try {
      if (recorder.sampleRate !== CAPTURE_SAMPLE_RATE) {
        throw new Error(
          `PvRecorder reported ${recorder.sampleRate} Hz; expected ${CAPTURE_SAMPLE_RATE} Hz`,
        );
      }

      this.frames = [];
      this.stopping = false;
      this.readError = undefined;
      recorder.start();
      this.recorder = recorder;
      this.readLoop = this.readFrames(recorder);
    } catch (error) {
      recorder.release();
      throw error;
    }
  }

  async stop(): Promise<CapturedAudio> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("Microphone capture is not active");

    this.stopping = true;
    let stopError: Error | undefined;

    try {
      if (recorder.isRecording) recorder.stop();
    } catch (error) {
      stopError = toError(error);
    }

    try {
      await this.readLoop;
    } finally {
      recorder.release();
      this.recorder = undefined;
      this.readLoop = undefined;
    }

    if (stopError) throw stopError;
    if (this.readError) throw this.readError;
    return { pcm: convertFrames(this.frames) };
  }

  private async readFrames(recorder: PvRecorder): Promise<void> {
    try {
      while (!this.stopping && recorder.isRecording) {
        const frame = await recorder.read();
        if (this.stopping) continue;
        this.frames.push(frame);
        try {
          this.onFrame?.(frame);
        } catch {
          // Visualizer updates must not fail the recording.
        }
      }
    } catch (error) {
      if (!this.stopping) this.readError = toError(error);
    }
  }
}
