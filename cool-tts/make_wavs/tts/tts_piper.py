import numpy as np
from ..logger import Logger
model_path = "en_US-libritts-high.onnx"
config_path = "en_US-libritts-high.onnx.json"

logger = Logger(module='tts_piper')
def normalize(samples):
    max_val = np.max(np.abs(samples))
    if max_val > 0:
        return (samples / max_val * 32767 * 0.95).astype(np.int16)
    else:
        return samples.astype(np.int16)


class PiperTTS:
    def __init__(self, model_path: str = model_path, config_path: str = config_path):
        from piper import PiperVoice

        self.voice = PiperVoice.load(model_path=model_path, config_path=config_path)
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