#!/usr/bin/env python3
"""
xintent_xlib.py - Native X11 XIntent Client using python-xlib.
Implements the full X11 IPC protocol from x11-promises/xintent.js in Python.
"""

import os
import random
import json
import socket
import sys
import time
import traceback
from typing import Dict, Any, Optional, Callable

from x11_promises import X11PromisesClient, HAS_XLIB

if HAS_XLIB:
    from Xlib import X, Xatom

SYN = 1
FIN = 2
SYN_FIN = 3


import array
import struct


def _extract_event_data(event):
    """Extracts 5 uint32 data integers from a python-xlib ClientMessage event."""
    try:
        data_obj = getattr(event, 'data', None)

        if hasattr(event, 'data32'):
            return list(event.data32)

        if data_obj is not None:
            if hasattr(data_obj, 'data32'):
                return list(data_obj.data32)

            if hasattr(data_obj, 'data'):
                inner = data_obj.data
                if isinstance(inner, (bytes, bytearray, str)):
                    b = inner if isinstance(inner, (bytes, bytearray)) else inner.encode('latin1')
                    if len(b) >= 20:
                        return list(struct.unpack('<5I', b[:20]))
                elif isinstance(inner, (tuple, list, array.array)) and len(inner) >= 5:
                    return list(inner)

            if isinstance(data_obj, (tuple, list)):
                if len(data_obj) == 2:
                    inner = data_obj[1]
                    if isinstance(inner, (bytes, bytearray, str)):
                        b = inner if isinstance(inner, (bytes, bytearray)) else inner.encode('latin1')
                        if len(b) >= 20:
                            return list(struct.unpack('<5I', b[:20]))
                    elif isinstance(inner, (tuple, list, array.array)) and len(inner) >= 5:
                        return list(inner)
                elif len(data_obj) >= 5:
                    return list(data_obj)

            if isinstance(data_obj, (bytes, bytearray)) and len(data_obj) >= 20:
                return list(struct.unpack('<5I', data_obj[:20]))

    except Exception as e:
        sys.stderr.write(f"[libxintent.py error] _extract_event_data error: {e}\n{traceback.format_exc()}\n")
        sys.stderr.flush()

    return []


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
        "MATCHBOX_TOML",
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
        self.x11.root.change_attributes(event_mask=X.PropertyChangeMask)
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
        """Finds xintent-router window ID from X11 selection owner for XINTENT."""
        atom_xintent = self.atoms["XINTENT"]
        candidate_id = self.x11.get_selection_owner(atom_xintent)
        if candidate_id:
            wm_name = self.x11.get_window_property_string(candidate_id, Xatom.WM_NAME)
            if wm_name and wm_name.strip() == "XINTENT_ROUTER":
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
        if self.router_win_id:
            try:
                wm_name = self.x11.get_window_property_string(self.router_win_id, Xatom.WM_NAME)
                if wm_name == "XINTENT_ROUTER":
                    return self.router_win_id
            except Exception:
                pass

        return self.wait_for_router(timeout_sec=2.0)

    def register_matchbox_toml(self, toml_content: str):
        """Sets MATCHBOX_TOML property on client window to register services."""
        if self.client_win:
            atom_toml = self.atoms["MATCHBOX_TOML"]
            self.x11.set_window_property_string(
                self.client_win.id, atom_toml, toml_content
            )

    def blob_create(self, blob_data: Any, timeout_sec: float = 5.0) -> int:
        """Creates an XBlob owned by client_win with response cookie tracking."""
        cookie = random.randint(1, 0x7FFFFFFF)
        router_id = self.get_router_win_id()
        self.x11.send_client_message(
            router_id,
            int(self.atoms["XBLOB_CREATE_V0"]),
            [self.client_win.id, cookie],
        )

        start_time = time.time()
        blob_atom = 0
        atom_resp = int(self.atoms["XBLOB_CREATE_RESPONSE_V0"])

        while time.time() - start_time < timeout_sec:
            if self.x11.disp.pending_events():
                event = self.x11.disp.next_event()
                if event.type == X.ClientMessage and int(event.client_type) == atom_resp:
                    data32 = _extract_event_data(event)
                    if data32 and len(data32) >= 3 and (int(data32[2]) & 0xFFFFFFFF) == (cookie & 0xFFFFFFFF):
                        blob_atom = data32[1]
                        break
            time.sleep(0.01)

        if not blob_atom:
            raise RuntimeError(
                f"XBlobCreate timed out waiting for XBLOB_CREATE_RESPONSE_V0 (cookie {cookie})"
            )

        self.blob_write(blob_atom, blob_data)
        return blob_atom

    def blob_write(self, blob_atom: int, blob_data: Any):
        """Writes JSON payload to XBLOB_HOST_<hostname> window property blob_atom."""
        hostname = socket.gethostname()
        host_atom = self.x11.intern_atom(f"XBLOB_HOST_{hostname}")
        xblob_host_id = self.x11.get_selection_owner(host_atom)
        router_id = self.get_router_win_id()
        target_win_id = xblob_host_id if xblob_host_id else router_id

        payload_json = json.dumps(blob_data, indent=2)
        self.x11.set_window_property_string(target_win_id, blob_atom, payload_json)
        self.x11.set_selection_owner(target_win_id, blob_atom)

    def blob_read(self, blob_atom: int) -> Any:
        """Reads JSON data from selection owner window property blob_atom."""
        sys.stderr.write(f"[libxintent.py debug] blob_read start for {hex(blob_atom)}\n")
        sys.stderr.flush()

        host_win_id = 0
        try:
            host_win_id = self.x11.get_selection_owner(blob_atom)
            sys.stderr.write(f"[libxintent.py debug] selection owner for {hex(blob_atom)} is {hex(host_win_id)}\n")
            sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"[libxintent.py debug] get_selection_owner error: {e}\n")
            sys.stderr.flush()

        router_id = 0
        try:
            router_id = self.get_router_win_id()
            sys.stderr.write(f"[libxintent.py debug] router win id is {hex(router_id)}\n")
            sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"[libxintent.py debug] get_router_win_id error: {e}\n")
            sys.stderr.flush()

        targets = [host_win_id, router_id, self.client_win.id if self.client_win else 0]
        for target_win_id in targets:
            if not target_win_id:
                continue
            try:
                sys.stderr.write(f"[libxintent.py debug] reading prop {hex(blob_atom)} from window {hex(target_win_id)}...\n")
                sys.stderr.flush()
                prop_str = self.x11.get_window_property_string(target_win_id, blob_atom)
                if prop_str:
                    sys.stderr.write(f"[libxintent.py] Read blob {hex(blob_atom)} from window {hex(target_win_id)} ({len(prop_str)} bytes)\n")
                    sys.stderr.flush()
                    return json.loads(prop_str)
            except Exception as e:
                sys.stderr.write(f"[libxintent.py error] blob_read attempt on {hex(target_win_id)} failed: {e}\n{traceback.format_exc()}\n")
                sys.stderr.flush()

        raise RuntimeError(
            f"XBlobRead: No data found for blob_atom {blob_atom} ({hex(blob_atom)}) on host {hex(host_win_id)} or router {hex(router_id)}"
        )

    def blob_transfer(self, blob_atom: int, grantee_win_id: int):
        router_id = self.get_router_win_id()
        self.x11.send_client_message(
            router_id,
            self.atoms["XBLOB_TRANSFER_V0"],
            [self.client_win.id, blob_atom, grantee_win_id],
        )

    def blob_grant(self, blob_atom: int, grantee_win_id: int):
        router_id = self.get_router_win_id()
        self.x11.send_client_message(
            router_id,
            self.atoms["XBLOB_GRANT_V0"],
            [self.client_win.id, blob_atom, grantee_win_id],
        )

    def blob_unlink(self, blob_atom: int):
        router_id = self.get_router_win_id()
        self.x11.send_client_message(
            router_id,
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
        tx_id: int = 0,
        channel: int = 0,
        control_word: int = 0,
        data_blob: int = 0,
    ) -> int:
        router_id = self.get_router_win_id()
        if not target_win_id:
            target_win_id = router_id

        payload_blob = self.blob_create(payload)
        if target_win_id != self.client_win.id:
            self.blob_transfer(payload_blob, target_win_id)
            if data_blob:
                self.blob_transfer(data_blob, target_win_id)

        tx_or_channel = channel if (channel and channel != 0) else (tx_id if tx_id else 0)
        ctrl_word_to_send = control_word if control_word else (
            (3 if (payload.get("disposition") in ["final", "error"]) else 1) if tx_or_channel else 0
        )

        # XChannelJsonFrame: data[0]=senderWin, data[1]=channel, data[2]=controlWord, data[3]=payloadBlob, data[4]=dataBlob
        self.x11.send_client_message(
            target_win_id,
            message_type_atom,
            [self.client_win.id, tx_or_channel, ctrl_word_to_send, payload_blob, data_blob],
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
            if event.type == X.PropertyNotify and hasattr(event, 'window') and event.window.id == self.x11.root.id:
                if event.atom == self.atoms.get("XINTENT"):
                    self.connect_to_router()
            elif event.type == X.ClientMessage:
                self._handle_client_message(event)

    def _handle_client_message(self, event):
        msg_type = int(event.client_type)
        atom_name = next((name for name, atom_id in self.atoms.items() if int(atom_id) == msg_type), str(msg_type))
        win_hex = hex(self.client_win.id) if self.client_win else "0x0"
        sys.stderr.write(f"[libxintent.py] Received ClientMessage type '{atom_name}' ({msg_type}) on window {win_hex}\n")
        sys.stderr.flush()

        valid_atoms = [
            int(self.atoms[k]) for k in ["XINTENT_INTENT_V0", "XINTENT_EVENT_V0"] if k in self.atoms
        ]

        if msg_type in valid_atoms:
            data32 = _extract_event_data(event)
            if not data32 or len(data32) < 3:
                sys.stderr.write(f"[libxintent.py error] Invalid ClientMessage data array length ({len(data32) if data32 else 0}) on window {win_hex}\n")
                sys.stderr.flush()
                return

            sender_win_id = data32[0]
            channel       = data32[1]
            control_word  = data32[2] if len(data32) > 2 else 3
            payload_blob  = data32[3] if len(data32) > 3 else data32[1]
            data_blob     = data32[4] if len(data32) > 4 else 0

            sys.stderr.write(f"[libxintent.py] ClientMessage details: sender={hex(sender_win_id)}, channel={channel}, ctrl={control_word}, payload_blob={hex(payload_blob)}, data_blob={hex(data_blob)}\n")
            sys.stderr.flush()

            try:
                payload = self.blob_read(payload_blob)
                self.blob_unlink(payload_blob)
            except Exception as err:
                sys.stderr.write(f"[libxintent.py error] Error reading payload blob {hex(payload_blob)}: {err}\n{traceback.format_exc()}\n")
                sys.stderr.flush()
                return

            intent_name = (
                payload.get("intent")
                or payload.get("event")
                or payload.get("action")
            )
            if intent_name in self.handlers:
                sys.stderr.write(f"[libxintent.py] Handling intent '{intent_name}' on window {win_hex}\n")
                sys.stderr.flush()
                handler = self.handlers[intent_name]
                frame = {
                    "intent": intent_name,
                    "sender": sender_win_id,
                    "channel": channel,
                    "payload": payload,
                    "data_blob": data_blob,
                }
                try:
                    res = handler(frame)
                    if res is not None:
                        res_payload = res if isinstance(res, dict) else {"data": res}
                        data_blob_id = 0
                        if isinstance(res_payload, dict) and "data_blob" in res_payload:
                            data_blob_id = res_payload.pop("data_blob")
                        router_id = self.get_router_win_id()
                        sys.stderr.write(f"[libxintent.py] Sending event response for '{intent_name}' back to router {hex(router_id)} on channel {channel} with data_blob {hex(data_blob_id)}\n")
                        sys.stderr.flush()
                        self.send_event(router_id, res_payload, channel=channel, data_blob=data_blob_id)
                except Exception as err:
                    sys.stderr.write(f"[libxintent.py error] Error executing handler for '{intent_name}': {err}\n{traceback.format_exc()}\n")
                    sys.stderr.flush()
            else:
                sys.stderr.write(f"[libxintent.py warning] No handler registered for intent '{intent_name}' in app '{self.app_id}'\n")
                sys.stderr.flush()
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
        while True:
            try:
                self.process_events_once()
                time.sleep(0.01)
            except KeyboardInterrupt:
                break
