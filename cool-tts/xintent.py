#!/usr/bin/env python3
"""
xintent.py - Re-export shared x11-promises/xintent.py client library.
"""
import sys
from pathlib import Path

x11_promises_dir = str(Path(__file__).resolve().parent.parent / "x11-promises")
if x11_promises_dir not in sys.path:
    sys.path.insert(0, x11_promises_dir)

from xintent import XIntentServer, XIntentXlibClient

__all__ = ["XIntentServer", "XIntentXlibClient"]
