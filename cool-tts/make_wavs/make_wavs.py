import asyncio
import base64
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

x11_promises_dir = str(Path(__file__).resolve().parent.parent.parent / "x11-promises")
if x11_promises_dir not in sys.path:
    sys.path.insert(0, x11_promises_dir)

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
            wav_bytes = b""
            with open(out_path, "wb") as fd:
                generate_audio_data(engine, text, fd)

            with open(out_path, "rb") as f:
                wav_bytes = f.read()

            blob_id = 0
            if server.x11_client and wav_bytes:
                try:
                    blob_payload = {
                        "type": "audio/wav",
                        "data": wav_bytes,
                        "_dataType": "binary",
                        "xblobType": "Blob"
                    }
                    blob_id = server.x11_client.blob_create(blob_payload)
                except Exception as blob_err:
                    logger.error(f"[cool-tts] Failed to create WAV XBlob: {blob_err}")

            byte_count = len(wav_bytes)
            channel = frame.get("channel", 0)
            logger.info(f"[cool-tts] Sent ui.TextToSpeechResponse on channel {channel} with data_blob={blob_id} ({byte_count} bytes WAV)")

            res_payload = {
                "event": "ui.TextToSpeechResponse",
                "status": "ok",
                "disposition": "final",
                "controlWord": 2,
                "data_blob": blob_id,
            }
            if not blob_id and wav_bytes:
                res_payload["data"] = base64.b64encode(wav_bytes).decode("ascii")
                res_payload["type"] = "audio/wav"
                res_payload["_dataType"] = "base64"
            return res_payload
        except Exception as e:
            logger.error(f"[cool-tts] TTS generation failed: {e}", exc_info=True)
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
