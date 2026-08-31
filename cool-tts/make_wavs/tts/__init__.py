from .tts_kokoro import KokoroTTS
from .tts_qwen3 import Qwen3TTS
from .tts_piper import PiperTTS

TTS_REGISTRY = {
  'kokoro': KokoroTTS,
  'qwen3': Qwen3TTS,
  'piper': PiperTTS
}