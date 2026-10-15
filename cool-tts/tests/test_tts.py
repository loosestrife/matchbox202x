import os
import sys
import unittest
from pathlib import Path

# Add make_wavs and x11-promises to module path
make_wavs_dir = str(Path(__file__).resolve().parent.parent / "make_wavs")
x11_promises_dir = str(Path(__file__).resolve().parent.parent.parent / "x11-promises")

if make_wavs_dir not in sys.path:
    sys.path.insert(0, make_wavs_dir)
if x11_promises_dir not in sys.path:
    sys.path.insert(0, x11_promises_dir)

from logger import Logger


class TestCoolTTSLogger(unittest.TestCase):

    def test_logger_levels(self):
        log = Logger(module="test")
        log.info("info test")
        log.error("error test")
        log.warn("warn test")
        log.warning("warning test")
        log.debug("debug test")
        log.trace("trace test")

    def test_logger_exception_formatting(self):
        log = Logger(module="test")
        try:
            raise ValueError("Test error formatting")
        except Exception as e:
            log.error(f"Captured expected exception: {e}", exc_info=True)


if __name__ == "__main__":
    unittest.main()
