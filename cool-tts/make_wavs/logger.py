import sys
import traceback

class Logger:
    def __init__(self, module=None, **kwargs):
        self.module = module

    def _log(self, level: str, args, kwargs):
        exc_info = kwargs.pop("exc_info", False)
        prefix = f"[{self.module}] " if self.module else ""
        msg_str = " ".join(str(a) for a in args)
        sys.stderr.write(f"[{level.upper()}] {prefix}{msg_str}\n")
        if exc_info:
            if isinstance(exc_info, tuple):
                traceback.print_exception(*exc_info, file=sys.stderr)
            elif exc_info is True:
                traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()

    def info(self, *args, **kwargs):
        self._log("info", args, kwargs)

    def error(self, *args, **kwargs):
        self._log("error", args, kwargs)

    def warn(self, *args, **kwargs):
        self._log("warn", args, kwargs)

    def warning(self, *args, **kwargs):
        self._log("warn", args, kwargs)

    def debug(self, *args, **kwargs):
        self._log("debug", args, kwargs)

    def trace(self, *args, **kwargs):
        self._log("trace", args, kwargs)

logger = Logger(module='cool-tts')
