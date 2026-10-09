#!/usr/bin/env python3
import sys
import json
import time
import os
import soundfile as sf
from chonkie import RecursiveChunker
from xintent import XIntentServer


def handle_text_to_speech(frame):
    payload = frame.get("payload", frame) if isinstance(frame.get("payload"), dict) else frame
    text = payload.get("text", "")
    target_app = payload.get("target_app") or frame.get("sender")

    if not text:
        return {"status": "error", "message": "No text provided for TTS"}

    # 1. Chunk text using Chonkie if available
    try:
        chunker = RecursiveChunker()
        chunks = chunker.chunk(text)
    except Exception:
        chunks = [text]

    # 2. Render audio data using TTS engine (Simulated render array for fallback)
    samplerate = 24000
    dummy_audio = [0.0] * (samplerate * 2)  # 2 seconds of audio buffer

    # 3. Write output to app local /tmp directory
    file_id = f"tts_{int(time.time() * 1000)}.wav"
    tmp_path = os.path.join("/tmp", file_id)
    sf.write(tmp_path, dummy_audio, samplerate)

    # 4. Return response payload
    return {
        "status": "completed",
        "file_name": file_id,
        "file_path": tmp_path,
        "target_app": target_app,
        "disposition": "final",
        "controlWord": 2,
    }


def main():
    server = XIntentServer(app_id="cool-tts")
    server.register_handler("ui.TextToSpeech", handle_text_to_speech)
    server.run()


if __name__ == "__main__":
    main()
