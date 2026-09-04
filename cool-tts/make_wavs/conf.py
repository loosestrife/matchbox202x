#todo: allow env vars and .env files

import argparse

#todo: generate list of keys for --tts

parser = argparse.ArgumentParser(description="Generate WAV files from text via TTS engines.")
parser.add_argument("infile", type=str, nargs="?", help="Input text file")
parser.add_argument("-o", "--outfile", help="Output WAV path")
parser.add_argument("--tts", default="piper", choices=["kokoro", "qwen3", "piper"], help="TTS backend")
parser.add_argument("--voice", default="af_nova", help="Voice model/preset")
parser.add_argument("--rate", type=float, default=24000, help="Sampling rate in Hz")
parser.add_argument("--speed", type=float, default=1, help="Speed multiplier number")
parser.add_argument("--chunker", default="chonkie", help="Use this chunker instead of the builtin")
parser.add_argument("--math", action="store_true", help="math needs to be read in smaller chunks")
parser.add_argument("--intent-server", action="store_true", help="matchbox202x intent server")

conf = parser.parse_args()

if not conf.intent_server:
    missing = []
    if not conf.infile:
        missing.append("infile")
    if not conf.outfile:
        missing.append("-o/--outfile")
    if missing:
        parser.error(f"the following arguments are required unless --intent-server is set: {', '.join(missing)}")