#todo: allow env vars and .env files

import argparse

#todo: generate list of keys for --tts

parser = argparse.ArgumentParser(description="Generate WAV files from text via TTS engines.")
parser.add_argument("infile", type=str, help="Input text file")
parser.add_argument("-o", "--outfile", required=True, help="Output WAV path")
parser.add_argument("--tts", default="kokoro", choices=["kokoro", "qwen3", "piper"], help="TTS backend")
parser.add_argument("--voice", default="af_nova", help="Voice model/preset")
parser.add_argument("--rate", type=float, default=24000, help="Sampling rate in Hz")
parser.add_argument("--tts-params", type=dict, default={}, help="TTS engine params")
parser.add_argument("--speed", type=float, default=1, help="Speed multiplier number")
parser.add_argument("--chunker", default="chonkie", help="Use this chunker instead of the builtin")
parser.add_argument("--math", default=False, help="math needs to be read in smaller chunks")
parser.add_argument("--intent-server", default=False, help="matchbox202x intent server")
conf = parser.parse_args()