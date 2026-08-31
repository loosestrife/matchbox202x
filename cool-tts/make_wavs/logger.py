import sys

class Logger:
  def info(*args):
    print(*args, file=sys.stderr)

logger = Logger()