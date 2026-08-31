import numpy as np

model_path = "en_US-libritts-high.onnx"
config_path = "en_US-libritts-high.onnx.json"


class PiperTTS:
    def __init__(self, model_path: str = model_path):
        from piper import PiperVoice
        # Piper models run natively via ONNX
        self.voice = PiperVoice.load(model_path=model_path, config_path=config_path, use_cuda=True)
        self.sample_rate = self.voice.config.sample_rate

    def generate_samples(self, text: str | list[str]):
        """
        Generates full audio array for the given text at once.
        Matches self.kokoro.create(...) behavior.
        """
        print("got text:", text)
        acs = self.voice.synthesize(text)
        for(ac in)
        return (np.concat([normalize(samples) for samples in sampleses]), rate)