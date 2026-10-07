import asyncio
from collections import defaultdict
import json
import numpy as np
import os
import soundfile as sf
import tempfile
import time
from pathlib import Path
import sys

from .logger import logger
from .conf import conf
from .tts import TTS_REGISTRY
from xintent import XIntentServer

engine = None


def main():
    engine_cls = TTS_REGISTRY[conf.tts]
    global engine
    engine = engine_cls()
    if conf.intent_server:
        return intent_server()

    with open(conf.infile, "r", encoding="utf-8") as f:
        text = f.read().strip()

    os.makedirs(os.path.dirname(conf.outfile), exist_ok=True)
    with open(conf.outfile, "wb") as fd:
        generate_audio_data(engine, text, fd)


def intent_server():
    server = XIntentServer(app_id="cool-tts")

    @server.on_intent("ui.TextToSpeech")
    def handle_text_to_speech(frame):
        logger.info(f"got NNJSON frame: {frame}")

        payload = frame.get("payload", frame) if isinstance(frame.get("payload"), dict) else frame
        text = payload.get("text") or frame.get("text", "")

        if not text:
            return {"status": "error", "message": "No text provided for TTS"}

        file_id = f"tts_{int(time.time() * 1000)}.wav"
        out_path = os.path.join(tempfile.gettempdir(), file_id)

        try:
            with open(out_path, "wb") as fd:
                generate_audio_data(engine, text, fd)

            logger.info(f"[cool-tts] Audio generated successfully at {out_path}")
            return {
                "status": "ok",
                "file_name": file_id,
                "file_path": out_path,
                "disposition": "final",
            }
        except Exception as e:
            logger.info(f"[cool-tts] TTS generation failed: {e}")
            return {
                "status": "error",
                "message": str(e),
                "disposition": "error",
            }

    server.run()


def generate_audio_data(engine, text: str, output_fd) -> bool:
    samples, rate = engine.generate_samples(text)
    f = sf.SoundFile(
        output_fd,
        mode="w",
        samplerate=rate,
        channels=1,
        format="WAV",
        subtype="PCM_16",
        closefd=False,
    )
    f.write(samples)
    f.flush()
    f.close()


def format_time(seconds: float) -> str:
    """Formats seconds into MM:SS or HH:MM:SS string."""
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h:02d}h{m:02d}m{s:02d}s"
    return f"{m:02d}m{s:02d}s"


if __name__ == "__main__":
    main()
