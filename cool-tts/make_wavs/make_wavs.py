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
import tempfile

from .logger import logger
from .conf import conf
from .tts import TTS_REGISTRY

engine = None
def main():
    engine_cls = TTS_REGISTRY[conf.tts]
    global engine
    engine= engine_cls()
    if conf.intent_server:
        return intent_server()
    with open(conf.infile, "r", encoding="utf-8") as f:
        text = f.read().strip()

    os.makedirs(os.path.dirname(conf.outfile), exist_ok=True)
    fd = os.open(conf.outFile, "wb")
    generate_audio_data(engine, text, fd)


def intent_server():
    buf = ""
    for line in sys.stdin:
        if line.strip():
            buf += line + '\n'
        else:
            obj = json.loads(buf)
            buf = ""
            process_stdin(obj)

def process_stdin(obj):
    logger.info("got NNJSON frame", obj)
    if(obj["intent"] == "ui.TextToSpeech"):
        # haha were not doing anonymous file descriptors if /tmp isnt enough we do shm
        # fd = os.open("/tmp", os.O_TMPFILE | os.O_RDWR, 0o600)
        generate_audio_data(engine, obj["text"], fd)
        print(json.dumps({"intent":"ui.TextToSpeechResponse", "disposition": "final", "fd": fd, "channel": obj["channel"]}), '\n\n')

def generate_audio_data(engine, text: str, output_fd: int) -> bool:
    samples, rate = engine.generate_samples(text)
    f = sf.SoundFile(output_fd, mode="w", samplerate=rate, channels=1, format="WAV", subtype="PCM_16", closefd=False)
    f.write(samples)
    f.flush()
    f.close() # this soundfile api name is misleading

def format_time(seconds: float) -> str:
    """Formats seconds into MM:SS or HH:MM:SS string."""
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h:02d}h{m:02d}m{s:02d}s"
    return f"{m:02d}m{s:02d}s"

if __name__ == "__main__":
    main()
