#!/usr/bin/env python3
"""
xintent_protocol.py - X11 ClientMessage event data extraction and XIntent protocol helpers.
"""

import array
import logging
import os
import socket
import struct
import sys
import traceback

SYN = 1
FIN = 2
SYN_FIN = 3

PROTOCOL_ATOMS = [
    "XCHANNEL",
    "XINTENT",
    "XINTENT_INTENT_V0",
    "XINTENT_EVENT_V0",
    "MATCHBOX_TOML",
    "AGGREGATE_TOML",
    "SERVICE_MANIFEST_TOML",
    "XBLOB_CREATE_V0",
    "XBLOB_CREATE_RESPONSE_V0",
    "XBLOB_GRANT_V0",
    "XBLOB_UNLINK_V0",
    "XBLOB_TRANSFER_V0",
    "XBLOB_BROADCAST_V0",
    "XBLOB_SOFT_LINK_V0",
    "XBLOB_SOFT_UNLINK_V0",
    "XBLOB_ANNOUNCE_HOST_V0",
    "XBLOB_DROP_HOST_V0",
    "XBLOB_DESTRUCTOR_V0",
    "XBLOB_STREAM_CLOSED_V0",
    "XAUDIO_PLAY_V0",
    "XAUDIO_PLAY_RESPONSE_V0",
    "XAUDIO_CONTROL_V0",
    "XAUDIO_PREFETCH_SOUND_BLOB_V0",
    "XAUDIO_SEEK_STREAM_V0",
    "XAUDIO_GET_AUDIO_OUTPUTS_V0",
    "SESSION_SPEAKERS",
    "_NET_WM_PID",
    "CARDINAL",
    "STRING",
    "WM_NAME",
    "WM_CLASS",
    "message/http",
]

logger = logging.getLogger("xintent_xlib")


def _unpack_bytes_or_seq(inner):
    if isinstance(inner, (bytes, bytearray, str)):
        raw_bytes = inner if isinstance(inner, (bytes, bytearray)) else inner.encode("latin1")
        return list(struct.unpack("<5I", raw_bytes[:20])) if len(raw_bytes) >= 20 else None
    if isinstance(inner, (tuple, list, array.array)) and len(inner) >= 5:
        return list(inner)
    return None


def _extract_from_data_obj(data_obj):
    if hasattr(data_obj, "data32"):
        return list(data_obj.data32)
    if hasattr(data_obj, "data"):
        res = _unpack_bytes_or_seq(data_obj.data)
        if res is not None:
            return res
    if isinstance(data_obj, (tuple, list)):
        target = data_obj[1] if len(data_obj) == 2 else data_obj
        res = _unpack_bytes_or_seq(target)
        if res is not None:
            return res
    return _unpack_bytes_or_seq(data_obj)


def _extract_event_data(event) -> list:
    """Extracts 5 uint32 data integers from a python-xlib ClientMessage event."""
    try:
        if hasattr(event, "data32"):
            return list(event.data32)
        data_obj = getattr(event, "data", None)
        if data_obj is not None:
            res = _extract_from_data_obj(data_obj)
            if res is not None:
                return res
    except Exception as e:
        sys.stderr.write(f"[libxintent.py error] _extract_event_data error: {e}\n{traceback.format_exc()}\n")
        sys.stderr.flush()
    return []


def is_valid_router_window(client, win_id: int, wm_name_atom: int) -> bool:
    if not win_id:
        return False
    try:
        wm_name = client.x11.get_window_property_string(win_id, wm_name_atom)
        return bool(wm_name and wm_name.strip() in ("XCHANNEL_BUSMASTER", "XINTENT_ROUTER"))
    except Exception:
        return False


def _read_existing_socket_prop(client, win_id: int, socket_path_atom: int):
    if not win_id:
        return None
    try:
        sock_path = client.x11.get_window_property_string(win_id, socket_path_atom)
        if sock_path and os.path.exists(sock_path):
            client._cached_xblob_socket_path = sock_path
            return sock_path
    except Exception:
        pass
    return None


def resolve_xblob_socket_path(client, host_win_id: int = 0):
    socket_path_atom = client.x11.intern_atom("XBLOB_SOCKET_PATH")
    from_arg = _read_existing_socket_prop(client, host_win_id, socket_path_atom)
    if from_arg:
        return from_arg

    hostname = socket.gethostname()
    host_id = client.x11.get_selection_owner(client.x11.intern_atom(f"XBLOB_HOST_{hostname}"))
    if not host_id:
        host_id = client.x11.get_selection_owner(client.x11.intern_atom("XBLOB_X_SERVER_LOCAL_BLOB_HOST"))
    if not host_id:
        host_id = client.x11.get_selection_owner(client.x11.intern_atom("XBLOB_HOST"))
    from_owner = _read_existing_socket_prop(client, host_id, socket_path_atom)
    if from_owner:
        return from_owner

    env_sock = os.environ.get("XBLOB_SOCKET_PATH")
    if env_sock and os.path.exists(env_sock):
        client._cached_xblob_socket_path = env_sock
        return env_sock

    cached = getattr(client, "_cached_xblob_socket_path", None)
    if cached and os.path.exists(cached):
        return cached
    return None


def resolve_ctrl_word(control_word, tx_or_channel: int, payload: dict) -> int:
    if control_word is not None:
        return int(control_word)
    if not tx_or_channel:
        return 0
    return 2 if payload.get("disposition") in ("final", "error") else 1


def read_and_unlink_payload_blob(client, payload_blob: int):
    try:
        raw_payload = client.blob_read(payload_blob)
        logger.info(f"[xintent_xlib] Decoded payload blob {hex(payload_blob)}: {raw_payload}")
        client.blob_unlink(payload_blob)
        if isinstance(raw_payload, dict) and "data" in raw_payload:
            return raw_payload["data"]
        return raw_payload
    except Exception as err:
        logger.error(f"[xintent_xlib] Error reading payload blob {hex(payload_blob)}: {err}", exc_info=True)
        return None


def _extract_response_meta(res_payload: dict):
    data_blob_id = res_payload.pop("data_blob", 0)
    if "controlWord" in res_payload:
        ctrl_word = res_payload.pop("controlWord")
    else:
        ctrl_word = res_payload.pop("control_word", 0)
    return data_blob_id, ctrl_word


def send_handler_response(client, intent_name: str, channel: int, target_win_id: int, win_hex: str, res):
    res_payload = res if isinstance(res, dict) else {"data": res}
    data_blob_id, ctrl_word = _extract_response_meta(res_payload)
    router_id = client.get_router_win_id()
    logger.info(
        f"[xintent_xlib] Sending event response for '{intent_name}' back to router {hex(router_id)} "
        f"on channel {channel} with control_word {ctrl_word} data_blob {hex(data_blob_id)} from sender win {win_hex}"
    )
    client.send_event(
        router_id,
        res_payload,
        channel=channel,
        control_word=ctrl_word,
        data_blob=data_blob_id,
        sender_win_id=target_win_id,
    )


def dispatch_intent_handler(client, handler, frame: dict, win_hex: str):
    intent_name = frame["intent"]
    handler_name = getattr(handler, "__name__", str(handler))
    logger.info(f"[xintent_xlib] Executing handler '{handler_name}' for intent '{intent_name}' on window {win_hex}...")
    try:
        res = handler(frame)
        logger.info(f"[xintent_xlib] Handler '{handler_name}' returned: {res}")
        if res is not None:
            send_handler_response(client, intent_name, frame["channel"], frame["target_win"], win_hex, res)
    except Exception as err:
        logger.error(f"[xintent_xlib] Error executing handler for '{intent_name}': {err}", exc_info=True)


def handle_intent_client_message(client, atom_name: str, target_win_id: int, win_hex: str, event):
    data32 = _extract_event_data(event)
    if not data32 or len(data32) < 3:
        msg = f"Invalid ClientMessage data array length ({len(data32) if data32 else 0}) on window {win_hex}"
        logger.error(f"[xintent_xlib] {msg}")
        sys.stderr.write(f"[libxintent.py error] {msg}\n")
        sys.stderr.flush()
        return

    sender_win_id = data32[0]
    channel = data32[1]
    control_word = data32[2]
    payload_blob = data32[3] if len(data32) > 3 else data32[1]
    data_blob = data32[4] if len(data32) > 4 else 0

    logger.info(
        f"[xintent_xlib] ClientMessage details: atom={atom_name}, sender={hex(sender_win_id)}, "
        f"channel={channel}, ctrl={control_word}, payload_blob={hex(payload_blob)}, data_blob={hex(data_blob)}"
    )
    sys.stderr.write(
        f"[libxintent.py] ClientMessage details: sender={hex(sender_win_id)}, "
        f"channel={channel}, ctrl={control_word}, payload_blob={hex(payload_blob)}, data_blob={hex(data_blob)}\n"
    )
    sys.stderr.flush()

    payload = read_and_unlink_payload_blob(client, payload_blob)
    if payload is None:
        return

    intent_name = payload.get("intent") or payload.get("event") or payload.get("action")
    logger.info(
        f"[xintent_xlib] Received message for intent '{intent_name}' on channel {channel} "
        f"(payload_blob={hex(payload_blob)}, data_blob={hex(data_blob)}) on window {win_hex}"
    )

    handler = client.window_handlers.get((target_win_id, intent_name)) or client.handlers.get(intent_name)
    if handler:
        frame = {
            "intent": intent_name,
            "sender": sender_win_id,
            "channel": channel,
            "payload": payload,
            "data_blob": data_blob,
            "target_win": target_win_id,
        }
        dispatch_intent_handler(client, handler, frame, win_hex)
    else:
        registered_keys = list(client.window_handlers.keys()) + list(client.handlers.keys())
        logger.warning(
            f"[xintent_xlib] No handler registered for intent '{intent_name}' on window {win_hex} in app '{client.app_id}'. "
            f"Registered handlers: {registered_keys}"
        )
