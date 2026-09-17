#!/usr/bin/env python3
"""Transcribe an already-decoded 16 kHz mono WAV with whisper. Prints the text.

Run with the interpreter of a venv that has openai-whisper installed (see
JEP_WHISPER_DIR); jep's src/core/transcribe.ts does the decoding first.

Why this exists rather than calling whisper with the file path: whisper's own
loader decodes audio by shelling out to ffmpeg, so on a machine without ffmpeg
it can read nothing at all. Samples handed in directly skip that entirely, and
macOS can do the decode with afconvert, which is always installed.
"""

import os
import sys
import wave


def read_wav(path):
    """16-bit PCM WAV -> float32 samples in [-1, 1], which is whisper's input."""
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            sys.exit(f"expected 16-bit PCM, got {w.getsampwidth() * 8}-bit")
        if w.getnchannels() != 1:
            sys.exit(f"expected mono, got {w.getnchannels()} channels")
        if w.getframerate() != 16000:
            sys.exit(f"expected 16 kHz, got {w.getframerate()} Hz")
        raw = w.readframes(w.getnframes())
    import numpy as np

    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: transcribe.py <16k-mono.wav>")
    path = sys.argv[1]
    samples = read_wav(path)
    if samples.size == 0:
        sys.exit("no audio in that file")

    import whisper

    model_name = os.environ.get("JEP_WHISPER_MODEL", "medium")
    # stderr, not stdout: stdout is the transcript and nothing else
    print(f"loading whisper '{model_name}'…", file=sys.stderr)
    model = whisper.load_model(model_name)
    result = model.transcribe(samples)
    lang = result.get("language")
    if lang:
        print(f"language: {lang}", file=sys.stderr)
    print(result["text"].strip())


if __name__ == "__main__":
    main()
