import os
import urllib.request
from pathlib import Path
import numpy as np
from ..logger import Logger

BASE_DIR = Path(__file__).resolve().parent
MODEL_NAME = "en_US-libritts-high.onnx"
CONFIG_NAME = "en_US-libritts-high.onnx.json"

DEFAULT_MODEL_PATH = BASE_DIR / MODEL_NAME
DEFAULT_CONFIG_PATH = BASE_DIR / CONFIG_NAME

MODEL_URL = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/libritts/high/{MODEL_NAME}"
CONFIG_URL = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/libritts/high/{CONFIG_NAME}"

logger = Logger(module='tts_piper')

def ensure_model_files(m_path: Path, c_path: Path):
    if not m_path.exists() or not c_path.exists():
        logger.info("Piper model files missing. Downloading from Hugging Face...")
        m_path.parent.mkdir(parents=True, exist_ok=True)
        if not c_path.exists():
            logger.info(f"Downloading {c_path.name}...")
            urllib.request.urlretrieve(CONFIG_URL, c_path)
        if not m_path.exists():
            logger.info(f"Downloading {m_path.name}...")
            urllib.request.urlretrieve(MODEL_URL, m_path)
        logger.info("Piper model download complete.")

def normalize(samples):
    max_val = np.max(np.abs(samples))
    if max_val > 0:
        return (samples / max_val * 32767 * 0.95).astype(np.int16)
    else:
        return samples.astype(np.int16)


class PiperTTS:
    def __init__(self, model_path: str | Path | None = None, config_path: str | Path | None = None):
        from piper import PiperVoice

        m_path = Path(model_path) if model_path else DEFAULT_MODEL_PATH
        c_path = Path(config_path) if config_path else DEFAULT_CONFIG_PATH

        if not m_path.exists() and Path(MODEL_NAME).exists():
            m_path = Path(MODEL_NAME)
        if not c_path.exists() and Path(CONFIG_NAME).exists():
            c_path = Path(CONFIG_NAME)

        ensure_model_files(m_path, c_path)

        self.voice = PiperVoice.load(model_path=str(m_path), config_path=str(c_path))
        self.sample_rate = self.voice.config.sample_rate

    def generate_samples(self, text: str | list[str]):
        """
        Generates full audio array for the given text at once.
        Matches self.kokoro.create(...) behavior.
        """
        if isinstance(text, list):
            text = " ".join(text)

        logger.info("got text:", text)

        audio_chunks = []
        for chunk in self.voice.synthesize(text):
            samples = np.frombuffer(chunk.audio_int16_bytes, dtype=np.int16)
            
            audio_chunks.append(normalize(samples))

        if not audio_chunks:
            return np.array([], dtype=np.int16), self.sample_rate

        full_audio = np.concatenate(audio_chunks)
        return full_audio, self.sample_rate