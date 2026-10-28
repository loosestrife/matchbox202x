#!/usr/bin/env python3
"""
x11_promises.py - Python Xlib abstraction mirroring x11-promises.js.
Provides helper methods for atom interning, client messages, window properties,
and event handling over python-xlib.
"""

import os
import sys

try:
    from Xlib import X, display, Xatom, protocol
    HAS_XLIB = True
except ImportError:
    HAS_XLIB = False


def _decode_prop_value(val) -> str:
    if isinstance(val, str):
        return val
    if isinstance(val, bytes):
        return val.decode("utf-8", errors="replace")
    return bytes(val).decode("utf-8", errors="replace")


def _to_utf8_bytes(value_str) -> bytes:
    if isinstance(value_str, (bytes, bytearray)):
        return bytes(value_str)
    if isinstance(value_str, str):
        return value_str.encode("utf-8")
    return str(value_str).encode("utf-8")


class X11PromisesClient:
    """
    Python wrapper around python-xlib providing Promise-like helper utilities
    matching x11-promises.js.
    """

    def __init__(self, display_name=None):
        if not HAS_XLIB:
            raise ImportError(
                "python-xlib is required for X11PromisesClient. Install via 'pip install python-xlib' or 'uv add python-xlib'."
            )
        self.disp = display.Display(display_name)
        self.screen = self.disp.screen()
        self.root = self.screen.root
        self.atoms = {}

    def intern_atom(self, atom_name: str, only_if_exists: bool = False) -> int:
        if atom_name in self.atoms:
            return self.atoms[atom_name]
        res = self.disp.intern_atom(atom_name, only_if_exists)
        atom_id = int(res) if res else 0
        if atom_id:
            self.atoms[atom_name] = atom_id
        return atom_id

    def _lookup_cached_atom_name(self, atom_id: int):
        target = int(atom_id)
        for name, aid in self.atoms.items():
            if int(aid) == target:
                return name
        return None

    def get_atom_name(self, atom_id: int) -> str:
        cached = self._lookup_cached_atom_name(atom_id)
        if cached is not None:
            return cached
        try:
            name = self.disp.get_atom_name(int(atom_id))
            if name:
                decoded = _decode_prop_value(name)
                self.atoms[decoded] = int(atom_id)
                return decoded
        except Exception:
            pass
        return str(atom_id)

    def create_client_window(self, name: str = "xintent-client"):
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

        win.change_property(atom_pid, atom_cardinal, 32, [os.getpid()])

        wm_class_str = f"{name}\0{name}\0".encode("utf-8")
        win.change_property(Xatom.WM_CLASS, Xatom.STRING, 8, list(wm_class_str))

        self.disp.flush()
        return win

    def send_client_message(self, target_win_id: int, message_type_atom: int, data):
        """
        Constructs and dispatches a 32-byte X11 ClientMessage event.
        """
        target_win = self.disp.create_resource_object("window", target_win_id)
        items = list(data)[:5]
        data_5 = [int(x) & 0xFFFFFFFF for x in (items + [0] * (5 - len(items)))[:5]]

        event = protocol.event.ClientMessage(
            window=target_win,
            client_type=message_type_atom,
            data=(32, data_5),
        )
        target_win.send_event(event, event_mask=X.NoEventMask)
        self.disp.flush()

    def get_window_property_string(self, win_id: int, property_atom: int):
        """
        Reads string or binary window property across 32KB chunks.
        """
        try:
            win = self.disp.create_resource_object("window", win_id)
            prop = win.get_full_property(property_atom, 0)
            if not prop or not prop.value:
                prop = win.get_full_property(property_atom, Xatom.STRING)
            if prop and prop.value:
                return _decode_prop_value(prop.value)
        except Exception as e:
            sys.stderr.write(f"[x11_promises.py] get_window_property_string error on win {hex(win_id)} atom {hex(property_atom)}: {e}\n")
            sys.stderr.flush()
        return None

    def set_window_property_string(self, win_id: int, property_atom: int, value_str, type_atom=None):
        """
        Writes string or binary window property in 32KB chunks with optional custom type atom.
        """
        win = self.disp.create_resource_object("window", win_id)
        data_bytes = _to_utf8_bytes(value_str)
        prop_type = type_atom if type_atom else Xatom.STRING
        chunk_size = 32768
        for offset in range(0, len(data_bytes), chunk_size):
            chunk = data_bytes[offset : offset + chunk_size]
            mode = X.PropModeReplace if offset == 0 else X.PropModeAppend
            win.change_property(property_atom, prop_type, 8, list(chunk), mode=mode)
        self.disp.flush()

    def set_selection_owner(self, win_id: int, atom_id: int):
        win = self.disp.create_resource_object("window", win_id)
        win.set_selection_owner(atom_id, X.CurrentTime)
        self.disp.flush()

    def get_selection_owner(self, atom_id: int) -> int:
        owner = self.disp.get_selection_owner(atom_id)
        if not owner:
            return 0
        if hasattr(owner, "id"):
            return owner.id
        return owner if isinstance(owner, int) else 0
