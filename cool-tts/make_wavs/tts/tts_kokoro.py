# n.b. in rocm on consumer rdna4 it is often necessary to
# export MIOPEN_FIND_MODE=2

from ..conf import conf

class KokoroTTS:
  def __init__(self):
    import onnxruntime as ort
    from kokoro_onnx import Kokoro
    model_path = "kokoro-v1.0.onnx"
    voices_path = "voices-v1.0.bin"
    providers = ort.get_available_providers()
    for i, provider in enumerate(providers):
      if provider == 'ROCMExecutionProvider':
        providers[i] = ('ROCMExecutionProvider', {
          'tunable_op_enable': '1',         # Enables ONNX ROCm's internal fast operator tuning
          'tunable_op_tuning_enable': '1',  # Allows ONNX to benchmark GEMM shapes locally
          'miopen_conv_exhaustive_search': '1',  # Benchmark MIOpen convolutions
        })
    session = ort.InferenceSession(
        "kokoro-v1.0.onnx", 
        providers=providers
    )
    opts = ort.SessionOptions()
    opts.enable_profiling = True
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(model_path, sess_options=opts, providers=providers)
    self.kokoro = Kokoro.from_session(session, voices_path=voices_path)

  def get_sample_generator(self, text: str) -> bool:
    return self.kokoro.create_stream(
      text,
      voice=conf.voice,
      speed=conf.speed,
      lang="en-us"
    )

  def generate_samples(self, text: str) -> bool:
    return self.kokoro.create(text, voice=conf.voice, speed=conf.speed, lang="en-us")