import numpy as np
from ..conf import conf

class Qwen3TTS:
    def __init__(self, model_name: str = "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice"):
        import torch
        from qwen_tts import Qwen3TTSModel
        # CustomVoice supports built-in speaker presets like 'Ryan', 'Vivian', etc.
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = Qwen3TTSModel.from_pretrained(
            model_name, 
            device_map=self.device,
            dtype=torch.bfloat16 if self.device == "cuda" else torch.float32,
            attn_implementation="eager"  # Forces PyTorch native eager attention
        )
        self.sample_rate = 24000

    def get_sample_generator(self, text: str):
        """
        Yields audio chunks as streaming numpy float arrays.
        Matches self.kokoro.create_stream(...) behavior.
        """
        stream = self.model.generate_stream(
            text=text,
            speaker=Serena,    # e.g., "Ryan", "Vivian", "Serena"
            language="auto",       # Supports "en", "zh", etc.
            speed=conf.speed
        )
        for tensors, rate in stream:
            if(len(tensors)>1):
                print(len(tensors))
                raise ValueError('too many wavs')
            yield (tensors[0], rate)

    def generate_samples(self, text: str | list[str]):
        """
        Generates full audio array for the given text at once.
        Matches self.kokoro.create(...) behavior.
        """
        print("got text:", text)
        sampleses, rate = self.model.generate_custom_voice(
            text=text,
            speaker="Serena",
            language="auto",
            speed=conf.speed
        )
        return (np.concat([normalize(samples) for samples in sampleses]), rate)

def normalize(samples):
    max_val = np.max(np.abs(samples))
    if max_val > 0:
        return (samples / max_val * 32767 * 0.95).astype(np.int16)
    else:
        return samples.astype(np.int16)