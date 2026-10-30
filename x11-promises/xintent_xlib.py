#!/usr/bin/env python3
"""
xintent_xlib.py - Native X11 XIntent Client using python-xlib.
Implements the full X11 IPC protocol from x11-promises/xintent.js in Python.
"""

import logging
import os
import socket
import sys
import time

from x11_promises import X11PromisesClient, HAS_XLIB
import xintent_at_rest as _at_rest
import xintent_blob_http as _blob_http
import xintent_protocol as _protocol

if HAS_XLIB:
    from Xlib import X, Xatom

logger = logging.getLogger("xintent_xlib")

SYN = _protocol.SYN
FIN = _protocol.FIN
SYN_FIN = _protocol.SYN_FIN
_extract_event_data = _protocol._extract_event_data
format_xblob_at_rest = _at_rest.format_xblob_at_rest
parse_xblob_at_rest = _at_rest.parse_xblob_at_rest
_http_put_blobs_unix_socket = _blob_http._http_put_blobs_unix_socket
_http_put_blobs_http = _blob_http._http_put_blobs_http
_http_get_blob_unix_socket = _blob_http._http_get_blob_unix_socket


class XIntentXlibClient:
    """
    X11-native XIntent Client mirroring xintent.js.
    Connects to xintent-router over X11 IPC, handles XBlobs, registers matchbox.toml,
    and sends/receives xintents and xevents over native X11 window events.
    """

    PROTOCOL_ATOMS = _protocol.PROTOCOL_ATOMS

    def __init__(self, app_id: str = "cool-tts", display_name=None):
        self.app_id = app_id
        self.x11 = X11PromisesClient(display_name)
        self.x11.root.change_attributes(event_mask=X.PropertyChangeMask)
        self.atoms = {}
        self.router_win_id: int = 0
        self.client_win = None
        self.sub_windows = {}
        self.handlers = {}
        self.window_handlers = {}
        self.pending_events_queue = []

        self._intern_all_atoms()
        self.connect_to_router()
        self.client_win = self.x11.create_client_window(name=app_id)
        if self.client_win and hasattr(self.client_win, "id"):
            self.sub_windows[self.client_win.id] = self.client_win

    def create_sub_window(self, app_id: str, manifest=None):
        """Creates an IPC sub-window on this client's shared X11 connection."""
        win = self.x11.create_client_window(name=app_id)
        if win and hasattr(win, "id"):
            self.sub_windows[win.id] = win
            if manifest:
                self.register_matchbox_toml(manifest, win_id=win.id)
        return win

    def _intern_all_atoms(self):
        for atom_name in self.PROTOCOL_ATOMS:
            self.atoms[atom_name] = self.x11.intern_atom(atom_name)

    def get_atom_name(self, atom_id: int) -> str:
        for name, aid in self.atoms.items():
            if int(aid) == int(atom_id):
                return name
        name = self.x11.get_atom_name(atom_id)
        if name and name != str(atom_id):
            self.atoms[name] = int(atom_id)
        return name

    def connect_to_router(self) -> int:
        """Finds xintent-router or xbus-daemon window ID from X11 selection owner for XCHANNEL / XINTENT."""
        candidate_id = self.x11.get_selection_owner(self.atoms.get("XCHANNEL", 0))
        if not candidate_id:
            candidate_id = self.x11.get_selection_owner(self.atoms.get("XINTENT", 0))

        if _protocol.is_valid_router_window(self, candidate_id, Xatom.WM_NAME):
            self.router_win_id = candidate_id
            return candidate_id

        self.router_win_id = 0
        return 0

    def wait_for_router(self, timeout_sec: float = 5.0) -> int:
        """Waits for xintent-router to set root window XINTENT property and returns router_win_id."""
        if self.connect_to_router():
            return self.router_win_id

        start_time = time.time()
        while time.time() - start_time < timeout_sec:
            self.process_events_once()
            if self.connect_to_router():
                return self.router_win_id
            time.sleep(0.05)
        return self.router_win_id

    def get_router_win_id(self) -> int:
        if _protocol.is_valid_router_window(self, self.router_win_id, Xatom.WM_NAME):
            return self.router_win_id
        return self.wait_for_router(timeout_sec=2.0)

    def _default_win_id(self, win_id=None) -> int:
        if win_id:
            return win_id
        return self.client_win.id if self.client_win else 0

    def register_matchbox_toml(self, toml_content: str, win_id=None):
        """Sets MATCHBOX_TOML property on client window or specific sub-window to register services."""
        target_win = self._default_win_id(win_id)
        if target_win:
            self.x11.set_window_property_string(target_win, self.atoms["MATCHBOX_TOML"], toml_content)

    def blob_create(self, blob_data, timeout_sec: float = 5.0) -> int:
        """Creates an XBlob by contacting the local XBlob Host via PUT /blobs over local UNIX socket or HTTP."""
        sock_path = self.get_xblob_socket_path() or os.environ.get("XBLOB_SOCKET_PATH")
        sender_win = self._default_win_id()
        if sock_path and os.path.exists(sock_path):
            blob_id = _http_put_blobs_unix_socket(sock_path, blob_data, sender_win=sender_win)
            if blob_id:
                return blob_id

        http_port = int(os.environ.get("XINTENT_PORT") or os.environ.get("PORT") or 12345)
        return _http_put_blobs_http(http_port, blob_data, sender_win=sender_win) or 0

    def blob_write(self, blob_id: int, blob_data):
        """Sends XBlob payload data to XBLOB_HOST via HTTP over UNIX socket."""
        sock_path = self.get_xblob_socket_path() or os.environ.get("XBLOB_SOCKET_PATH")
        if sock_path and os.path.exists(sock_path):
            _http_put_blobs_unix_socket(sock_path, blob_data)

    def get_xblob_socket_path(self, host_win_id: int = 0):
        """Returns the UNIX domain socket path advertised in XBLOB_SOCKET_PATH on XBLOB_HOST window or host_win_id."""
        return _protocol.resolve_xblob_socket_path(self, host_win_id)

    def build_user_agent(self, win_id=None) -> str:
        host = socket.gethostname()
        display = os.environ.get("DISPLAY") or ""
        target_win = win_id if win_id is not None else self._default_win_id()
        win_hex = hex(target_win) if isinstance(target_win, int) else str(target_win)
        return f"{host}:{display}/{win_hex} (app={self.app_id})"

    @staticmethod
    def _coerce_blob_id(blob_id) -> int:
        if blob_id is None:
            return 0
        if isinstance(blob_id, int):
            return blob_id
        if isinstance(blob_id, str):
            s = blob_id.strip().lower()
            if not s or s == "null":
                return 0
            try:
                return int(s, 16) if s.startswith("0x") else int(s, 0)
            except ValueError:
                return 0
        return int(blob_id)

    def blob_read(
        self,
        blob_id,
        win_id=None,
        receive_fd: bool = False,
        accept_readable_stream: bool = False,
        accept_buffered_readable_stream: bool = False,
    ):
        """Reads XBlob payload from XBLOB_HOST via local UNIX socket or HTTP."""
        accept_stream = bool(accept_readable_stream or accept_buffered_readable_stream)
        blob_id_int = self._coerce_blob_id(blob_id)
        blob_hex = hex(blob_id_int)
        sock_path = self.get_xblob_socket_path() or os.environ.get("XBLOB_SOCKET_PATH")
        user_agent = self.build_user_agent(win_id=win_id)
        if sock_path and os.path.exists(sock_path):
            blob_data = _http_get_blob_unix_socket(
                sock_path,
                blob_hex,
                user_agent=user_agent,
                accept_readable_stream=accept_stream,
            )
            if blob_data:
                return _blob_http.post_process_blob_read_data(blob_data, receive_fd, accept_readable_stream=accept_stream)

        raise RuntimeError(
            f"XBlobRead: No data found for blob_id {blob_id_int} ({blob_hex}) over socket '{sock_path}'"
        )

    def blob_transfer(self, blob_id, grantee_win_id: int, win_id=None):
        router_id = self.get_router_win_id()
        src_win = self._default_win_id(win_id)
        self.x11.send_client_message(router_id, self.atoms["XBLOB_TRANSFER_V0"], [src_win, self._coerce_blob_id(blob_id), grantee_win_id])

    def blob_grant(self, blob_id, grantee_win_id: int, win_id=None):
        router_id = self.get_router_win_id()
        src_win = self._default_win_id(win_id)
        self.x11.send_client_message(router_id, self.atoms["XBLOB_GRANT_V0"], [src_win, self._coerce_blob_id(blob_id), grantee_win_id])

    def blob_unlink(self, blob_id, win_id=None):
        router_id = self.get_router_win_id()
        src_win = self._default_win_id(win_id)
        self.x11.send_client_message(router_id, self.atoms["XBLOB_UNLINK_V0"], [src_win, self._coerce_blob_id(blob_id)])

    def blob_announce_host(self, blob_id: int, host_win_id: int = 0):
        router_id = self.get_router_win_id()
        target_host = self._default_win_id(host_win_id)
        self.x11.send_client_message(router_id, self.atoms["XBLOB_ANNOUNCE_HOST_V0"], [target_host, blob_id, target_host])

    def blob_drop_host(self, blob_id: int, host_win_id: int = 0):
        router_id = self.get_router_win_id()
        target_host = self._default_win_id(host_win_id)
        self.x11.send_client_message(router_id, self.atoms["XBLOB_DROP_HOST_V0"], [target_host, blob_id, target_host])

    def send_intent(
        self,
        target_win_id: int,
        payload: dict,
        tx_id: int = 0,
        channel: int = 0,
        control_word=None,
        data_blob: int = 0,
        sender_win_id=None,
    ) -> int:
        return self._send_xi_v0(
            message_type_atom=self.atoms["XINTENT_INTENT_V0"],
            target_win_id=target_win_id,
            payload=payload,
            tx_id=tx_id,
            channel=channel,
            control_word=control_word,
            data_blob=data_blob,
            sender_win_id=sender_win_id,
        )

    def send_event(
        self,
        target_win_id: int,
        payload: dict,
        tx_id: int = 0,
        channel: int = 0,
        control_word=None,
        data_blob: int = 0,
        sender_win_id=None,
    ) -> int:
        return self._send_xi_v0(
            message_type_atom=self.atoms["XINTENT_EVENT_V0"],
            target_win_id=target_win_id,
            payload=payload,
            tx_id=tx_id,
            channel=channel,
            control_word=control_word,
            data_blob=data_blob,
            sender_win_id=sender_win_id,
        )

    def _send_xi_v0(
        self,
        message_type_atom: int,
        target_win_id: int,
        payload: dict,
        tx_id: int = 0,
        channel: int = 0,
        control_word=None,
        data_blob: int = 0,
        sender_win_id=None,
    ) -> int:
        resolved_target = target_win_id or self.get_router_win_id()
        src_win_id = self._default_win_id(sender_win_id)
        data_blob_int = self._coerce_blob_id(data_blob)

        payload_blob = self.blob_create(payload)
        if resolved_target != src_win_id:
            self.blob_transfer(payload_blob, resolved_target)
            if data_blob_int:
                self.blob_transfer(data_blob_int, resolved_target)

        tx_or_channel = channel if (channel and channel != 0) else (tx_id or 0)
        ctrl_word_to_send = _protocol.resolve_ctrl_word(control_word, tx_or_channel, payload)

        self.x11.send_client_message(
            resolved_target,
            message_type_atom,
            [src_win_id, tx_or_channel, ctrl_word_to_send, payload_blob, data_blob_int],
        )
        return payload_blob

    def register_handler(self, intent_name: str, handler, win_id=None):
        """Registers a handler function for an intent (optionally tied to a specific window ID)."""
        target_win = self._default_win_id(win_id)
        if target_win:
            self.window_handlers[(target_win, intent_name)] = handler
        self.handlers[intent_name] = handler

    def on_intent(self, intent_name: str, win_id=None):
        """Decorator to register a handler function for an intent."""
        def decorator(func):
            self.register_handler(intent_name, func, win_id=win_id)
            return func
        return decorator

    def process_events_once(self):
        """Processes pending incoming X11 events."""
        try:
            if hasattr(self.x11, "disp") and hasattr(self.x11.disp, "fill_raw_data"):
                self.x11.disp.fill_raw_data()
        except Exception:
            pass

        events = list(getattr(self, "pending_events_queue", []))
        self.pending_events_queue = []

        while self.x11.disp.pending_events():
            events.append(self.x11.disp.next_event())

        for event in events:
            if event.type == X.PropertyNotify and hasattr(event, "window") and event.window.id == self.x11.root.id:
                if event.atom == self.atoms.get("XINTENT"):
                    self.connect_to_router()
            elif event.type == X.ClientMessage:
                self._handle_client_message(event)

    def _handle_client_message(self, event):
        msg_type = int(event.client_type)
        atom_name = self.get_atom_name(msg_type)
        win_obj = getattr(event, "window", None)
        target_win_id = win_obj.id if win_obj else self._default_win_id()
        win_hex = hex(target_win_id)
        logger.info(f"[xintent_xlib] Received ClientMessage '{atom_name}' ({msg_type}) on window {win_hex}")
        sys.stderr.write(f"[libxintent.py] Received ClientMessage type '{atom_name}' ({msg_type}) on window {win_hex}\n")
        sys.stderr.flush()

        valid_atoms = [int(self.atoms[k]) for k in ("XINTENT_INTENT_V0", "XINTENT_EVENT_V0") if k in self.atoms]
        if msg_type in valid_atoms:
            _protocol.handle_intent_client_message(self, atom_name, target_win_id, win_hex, event)
        elif atom_name == "XBLOB_STREAM_CLOSED_V0":
            data32 = _extract_event_data(event)
            handler = self.window_handlers.get((target_win_id, atom_name)) or self.handlers.get(atom_name)
            if handler and len(data32) >= 5:
                handler({
                    "event": atom_name,
                    "sender": data32[0],
                    "blob": data32[1],
                    "host": data32[2],
                    "size": (data32[4] << 32) | data32[3],
                    "target_win": target_win_id,
                })
        else:
            sys.stderr.write(f"[libxintent.py warning] Unhandled ClientMessage type '{atom_name}' ({msg_type}) on window {win_hex}\n")
            sys.stderr.flush()

    def run(self):
        """Event loop listening for incoming X11 XIntent ClientMessages."""
        sys.stderr.write(f"[XIntentXlib] Listening for X11 intents on window {hex(self.client_win.id)}...\n")
        sys.stderr.flush()
        while True:
            try:
                self.process_events_once()
                time.sleep(0.01)
            except KeyboardInterrupt:
                break


__all__ = [
    "SYN",
    "FIN",
    "SYN_FIN",
    "XIntentXlibClient",
    "HAS_XLIB",
    "_extract_event_data",
    "format_xblob_at_rest",
    "parse_xblob_at_rest",
    "_http_put_blobs_unix_socket",
    "_http_put_blobs_http",
    "_http_get_blob_unix_socket",
]
