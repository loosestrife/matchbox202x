#!/usr/bin/env python3
"""
x11_promises.py - Python Xlib abstraction mirroring x11-promises.js.
Provides helper methods for atom interning, client messages, window properties,
and event handling over python-xlib.
"""

import os
import random
import time
from typing import Dict, Any, Optional, Callable, List

try:
    from Xlib import X, display, Xatom, protocol
    HAS_XLIB = True
except ImportError:
    HAS_XLIB = False


class X11PromisesClient:
    """
    Python wrapper around python-xlib providing Promise-like helper utilities
    matching x11-promises.js.
    """

    def __init__(self, display_name: Optional[str] = None):
        if not HAS_XLIB:
            raise ImportError(
                "python-xlib is required for X11PromisesClient. Install via 'pip install python-xlib' or 'uv add python-xlib'."
            )
        self.disp = display.Display(display_name)
        self.screen = self.disp.screen()
        self.root = self.screen.root
        self.atoms: Dict[str, int] = {}

    def intern_atom(self, atom_name: str, only_if_exists: bool = False) -> int:
        if atom_name in self.atoms:
            return self.atoms[atom_name]
        atom_id = self.disp.intern_atom(atom_name, only_if_exists)
        if atom_id:
            self.atoms[atom_name] = atom_id
        return atom_id

    def create_client_window(self, name: str = "xintent-client") -> Any:
        """
        Creates an unmapped 1x1 IPC window with _NET_WM_PID and WM_CLASS set.
        """
        win = self.root.create_window(
            0,
            0,
            1,
            1,
            0,
            X.CopyFromParent,
            X.CopyFromParent,
            X.CopyFromParent,
            event_mask=X.PropertyChangeMask,
        )
        atom_pid = self.intern_atom("_NET_WM_PID")
        atom_cardinal = self.intern_atom("CARDINAL")
        atom_wm_class = Xatom.WM_CLASS

        # Set _NET_WM_PID for XSECURE credentials verification
        win.change_property(atom_pid, atom_cardinal, 32, [os.getpid()])

        # Set WM_CLASS
        wm_class_str = f"{name}\0{name}\0".encode("utf-8")
        win.change_property(atom_wm_class, Xatom.STRING, 8, list(wm_class_str))

        self.disp.flush()
        return win

    def send_client_message(
        self, target_win_id: int, message_type_atom: int, data: List[int]
    ):
        """
        Constructs and dispatches a 32-byte X11 ClientMessage event.
        """
        target_win = self.disp.create_resource_object("window", target_win_id)
        data_5 = (data[:5] + [0] * (5 - len(data)))[:5]

        event = protocol.event.ClientMessage(
            window=target_win,
            client_type=message_type_atom,
            data=(32, data_5),
        )
        target_win.send_event(event, event_mask=X.NoEventMask)
        self.disp.flush()

    def get_window_property_string(
        self, win_id: int, property_atom: int
    ) -> Optional[str]:
        """
        Reads string window property across 32KB chunks.
        """
        win = self.disp.create_resource_object("window", win_id)
        prop = win.get_full_property(property_atom, Xatom.STRING)
        if prop and prop.value:
            return bytes(prop.value).decode("utf-8", errors="replace")
        return None

    def set_window_property_string(
        self, win_id: int, property_atom: int, value_str: str
    ):
        """
        Writes string window property in 32KB chunks.
        """
        win = self.disp.create_resource_object("window", win_id)
        data_bytes = value_str.encode("utf-8")
        CHUNK_SIZE = 32768
        for offset in range(0, len(data_bytes), CHUNK_SIZE):
            chunk = data_bytes[offset : offset + CHUNK_SIZE]
            mode = X.PropModeReplace if offset == 0 else X.PropModeAppend
            win.change_property(
                property_atom, Xatom.STRING, 8, list(chunk), mode=mode
            )
        self.disp.flush()

    def set_selection_owner(self, win_id: int, atom_id: int):
        win = self.disp.create_resource_object("window", win_id)
        win.set_selection_owner(atom_id, X.CurrentTime)
        self.disp.flush()

    def get_selection_owner(self, atom_id: int) -> int:
        return self.disp.get_selection_owner(atom_id)
