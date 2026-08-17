# pi-transcribe

Local speech-to-text dictation for Pi.

## Install

Install directly from GitHub:

```bash
pi install ssh://git@github.com/earendil-works/pi-transcribe
```

After the first npm release, it can also be installed with:

```bash
pi install npm:@earendil-works/pi-transcribe
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- `/transcribe` for model, transcription-language, microphone, and shortcut settings.

To develop or run it from a checkout:

```bash
npm install --ignore-scripts
pi -e /absolute/path/to/pi-transcribe
```

Press the shortcut while Pi has focus, speak, then press it again. A live level meter appears above the editor while recording. `Esc` cancels. Audio is transcribed locally and inserted at the editor cursor. The shortcut is a Pi terminal binding, not a global OS hotkey.

## Cleanup

Cleanup is **off by default**. When you turn it on, a model fixes the transcript before it is inserted: punctuation, filler words, and misheard words.

To turn it on: open `/transcribe`, choose **Cleanup**, and pick a model. Each dictation then takes a few seconds longer.

### Glossary

Speech recognition may mishear project words, like "pie thorn" instead of "Python". Add the words you care about to a glossary, and cleanup fixes them:

- Run `/transcribe-glossary` to generate suggestions from your project, or
- edit `.pi/transcribe.glossary` by hand (one term per line; lines starting with `#` are comments).

Your curated terms are always kept; new ones are added after review. The file is git-ignored by default; share it with your team however you like (copy it, or remove the ignore entry).

**Privacy**: audio capture and recognition are 100% local — the recording never leaves your machine. With cleanup off, nothing else does either. With cleanup on, the transcript, the glossary terms, your editor text, and the project root path are sent to the chosen model, which may be a cloud provider. The glossary command sends project files and the recent conversation to the active model. Only enable these if that is acceptable.

Cleanup requires pi 0.84 or newer; on older pi versions the raw transcript is inserted instead.
