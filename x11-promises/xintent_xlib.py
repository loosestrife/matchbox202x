#!/usr/bin/env python3
"""
xintent_xlib.py - Native X11 XIntent Client using python-xlib.
Implements the full X11 IPC protocol from x11-promises/xintent.js in Python.
"""

import os
import random
import json
import socket
import time
from typing import Dict, Any, Optional, Callable

from x11_promises import X11PromisesClient, HAS_XLIB

if HAS_XLIB:
    from Xlib import X, Xatom


class XIntentXlibClient:
    """
    X11-native XIntent Client mirroring xintent.js.
    Connects to xintent-router over X11 IPC, handles XBlobs, registers matchbox.toml,
    and sends/receives xintents and xevents over native X11 window events.
    """

    PROTOCOL_ATOMS = [
        "XINTENT",
        "XINTENT_INTENT_V0",
        "XINTENT_EVENT_V0",
        "XINTENT_MATCHBOX_TOML",
        "XINTENT_AGGREGATE_TOML",
        "XINTENT_SERVICES_MANIFEST",
        "XBLOB_CREATE_V0",
        "XBLOB_CREATE_RESPONSE_V0",
        "XBLOB_GRANT_V0",
        "XBLOB_UNLINK_V0",
        "XBLOB_TRANSFER_V0",
        "XBLOB_BROADCAST_V0",
        "XBLOB_SOFT_LINK_V0",
        "XBLOB_SOFT_UNLINK_V0",
        "XBLOB_DESTRUCTOR_V0",
        "_NET_WM_PID",
        "CARDINAL",
        "STRING",
        "WM_NAME",
        "WM_CLASS",
    ]

    def __init__(self, app_id: str = "cool-tts", display_name: Optional[str] = None):
        self.app_id = app_id
        self.x11 = X11PromisesClient(display_name)
        self.atoms: Dict[str, int] = {}
        self.router_win_id: int = 0
        self.client_win = None
        self.handlers: Dict[str, Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]] = {}

        self._intern_all_atoms()
        self.connect_to_router()
        self.client_win = self.x11.create_client_window(name=app_id)

    def _intern_all_atoms(self):
        for atom_name in self.PROTOCOL_ATOMS:
            self.atoms[atom_name] = self.x11.intern_atom(atom_name)

    def connect_to_router(self) -> int:
        """Finds xintent-router window ID from root property XINTENT."""
        atom_xintent = self.atoms["XINTENT"]
        prop = self.x11.root.get_full_property(atom_xintent, Xatom.WINDOW)
        if prop and prop.value and len(prop.value) > 0:
            candidate_id = prop.value[0]
            wm_name = self.x11.get_window_property_string(candidate_id, Xatom.WM_NAME)
            if wm_name == "XINTENT_ROUTER":
                self.router_win_id = candidate_id
                return candidate_id
        return 0

    def register_matchbox_toml(self, toml_content: str):
        """Sets XINTENT_MATCHBOX_TOML property on client window to register services."""
        if self.client_win:
            atom_toml = self.atoms["XINTENT_MATCHBOX_TOML"]
            self.x11.set_window_property_string(
                self.client_win.id, atom_toml, toml_content
            )

    def blob_create(self, blob_data: Any, timeout_sec: float = 5.0) -> int:
        """Creates an XBlob owned by client_win with response cookie tracking."""
        cookie = random.randint(1, 0xFFFFFFFF)
        self.x11.send_client_message(
            self.router_win_id,
            self.atoms["XBLOB_CREATE_V0"],
            [self.client_win.id, cookie],
        )

        start_time = time.time()
        blob_atom = 0
        atom_resp = self.atoms["XBLOB_CREATE_RESPONSE_V0"]

        while time.time() - start_time < timeout_sec:
            if self.x11.disp.pending_events():
                event = self.x11.disp.next_event()
                if event.type == X.ClientMessage and event.client_type == atom_resp:
                    if event.data.data32[2] == cookie:
                        blob_atom = event.data.data32[1]
                        break
            time.sleep(0.01)

        if not blob_atom:
            raise RuntimeError(
                "XBlobCreate timed out waiting for XBLOB_CREATE_RESPONSE_V0"
            )

        self.blob_write(blob_atom, blob_data)
        return blob_atom

    def blob_write(self, blob_atom: int, blob_data: Any):
        """Writes JSON payload to XBLOB_HOST_<hostname> window property blob_atom."""
        hostname = socket.gethostname()
        host_atom = self.x11.intern_atom(f"XBLOB_HOST_{hostname}")
        xblob_host_id = self.x11.get_selection_owner(host_atom)
        target_win_id = xblob_host_id if xblob_host_id else self.router_win_id

        payload_json = json.dumps(blob_data, indent=2)
        self.x11.set_window_property_string(target_win_id, blob_atom, payload_json)
        self.x11.set_selection_owner(target_win_id, blob_atom)

    def blob_read(self, blob_atom: int) -> Any:
        """Reads JSON data from selection owner window property blob_atom."""
        host_win_id = self.x11.get_selection_owner(blob_atom)
        target_win_id = host_win_id if host_win_id else self.router_win_id
        prop_str = self.x11.get_window_property_string(target_win_id, blob_atom)
        if prop_str:
            return json.loads(prop_str)
        raise RuntimeError(
            f"XBlobRead: No data found for blob_atom {blob_atom} on window {hex(target_win_id)}"
        )

    def blob_transfer(self, blob_atom: int, grantee_win_id: int):
        self.x11.send_client_message(
            self.router_win_id,
            self.atoms["XBLOB_TRANSFER_V0"],
            [self.client_win.id, blob_atom, grantee_win_id],
        )

    def blob_grant(self, blob_atom: int, grantee_win_id: int):
        self.x11.send_client_message(
            self.router_win_id,
            self.atoms["XBLOB_GRANT_V0"],
            [self.client_win.id, blob_atom, grantee_win_id],
        )

    def blob_unlink(self, blob_atom: int):
        self.x11.send_client_message(
            self.router_win_id,
            self.atoms["XBLOB_UNLINK_V0"],
            [self.client_win.id, blob_atom],
        )

    def send_intent(
        self,
        target_win_id: int,
        payload: Dict[str, Any],
        tx_id: int = 0,
        channel: int = 0,
        data_blob: int = 0,
    ) -> int:
        return self._send_xi_v0(
            self.atoms["XINTENT_INTENT_V0"],
            target_win_id,
            payload,
            tx_id,
            channel,
            data_blob,
        )

    def send_event(
        self,
        target_win_id: int,
        payload: Dict[str, Any],
        tx_id: int = 0,
        channel: int = 0,
        data_blob: int = 0,
    ) -> int:
        return self._send_xi_v0(
            self.atoms["XINTENT_EVENT_V0"],
            target_win_id,
            payload,
            tx_id,
            channel,
            data_blob,
        )

    def _send_xi_v0(
        self,
        message_type_atom: int,
        target_win_id: int,
        payload: Dict[str, Any],
        tx_id: int,
        channel: int,
        data_blob: int,
    ) -> int:
        if not target_win_id:
            target_win_id = self.router_win_id

        payload_blob = self.blob_create(payload)
        if target_win_id != self.client_win.id:
            self.blob_transfer(payload_blob, target_win_id)

        tx_or_channel = tx_id if tx_id else channel
        self.x11.send_client_message(
            target_win_id,
            message_type_atom,
            [self.client_win.id, payload_blob, tx_or_channel, data_blob],
        )
        return payload_blob

    def on_intent(self, intent_name: str):
        def decorator(func: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]):
            self.handlers[intent_name] = func
            return func

        return decorator

    def process_events_once(self):
        """Processes pending incoming X11 events."""
        while self.x11.disp.pending_events():
            event = self.x11.disp.next_event()
            if event.type == X.ClientMessage:
                self._handle_client_message(event)

    def _handle_client_message(self, event):
        msg_type = event.client_type
        if msg_type in [
            self.atoms["XINTENT_INTENT_V0"],
            self.atoms["XINTENT_EVENT_V0"],
        ]:
            sender_win_id = event.data.data32[0]
            payload_blob = event.data.data32[1]
            channel = event.data.data32[2]
            data_blob = event.data.data32[3]

            try:
                payload = self.blob_read(payload_blob)
                self.blob_unlink(payload_blob)
            except Exception as err:
                print(f"[XIntentXlib] Error reading payload blob: {err}")
                return

            intent_name = (
                payload.get("intent")
                or payload.get("event")
                or payload.get("action")
            )
            if intent_name in self.handlers:
                handler = self.handlers[intent_name]
                frame = {
                    "intent": intent_name,
                    "sender": sender_win_id,
                    "channel": channel,
                    "payload": payload,
                    "data_blob": data_blob,
                }
                res = handler(frame)
                if res is not None:
                    res_payload = res if isinstance(res, dict) else {"data": res}
                    self.send_event(sender_win_id, res_payload, channel=channel)

    def run(self):
        """Event loop listening for incoming X11 XIntent ClientMessages."""
        print(
            f"[XIntentXlib] Listening for X11 intents on window {hex(self.client_win.id)}..."
        )
        while True:
            try:
                self.process_events_once()
                time.sleep(0.01)
            except KeyboardInterrupt:
                break
