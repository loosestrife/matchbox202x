import sys

class Logger:
  def __init__(self, **kwargs):
    pass

  def info(*args):
    print(*args, file=sys.stderr)

logger = Logger()