#!/usr/bin/env python3
"""
XIntent Bridge Handler
======================
Handles X11/XIntent IPC connections and WebSocket bridge messages.
Resolves incoming XBlobs into readable file descriptors (fd) regardless of whether
they arrive with Content-Encoding: fd-rights or Content-Encoding: identity, and passes
the open, readable file descriptor directly to the DLNA Media Manager.
"""

import asyncio
import base64
import logging
import os
import random
import tempfile
import urllib.parse
from typing import Optional, Tuple

logger = logging.getLogger("xintent_bridge")

# Import x11-promises client
sys_path_x11 = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "x11-promises"))
if sys_path_x11 not in os.sys.path:
    os.sys.path.insert(0, sys_path_x11)

try:
    from xintent_xlib import XIntentXlibClient
    HAS_XINTENT_XLIB = True
except Exception as e:
    logger.warning(f"Failed to import xintent_xlib: {e}")
    HAS_XINTENT_XLIB = False
    XIntentXlibClient = None


def _unwrap_blob_dict(raw_blob) -> dict:
    if not isinstance(raw_blob, dict):
        return {"data": raw_blob}
    if isinstance(raw_blob.get("blob"), dict):
        return raw_blob["blob"]
    data_field = raw_blob.get("data")
    if isinstance(data_field, dict):
        if isinstance(data_field.get("blob"), dict):
            return data_field["blob"]
        if "_dataType" in data_field or "data" in data_field:
            return data_field
    return raw_blob


def _try_open_fd_rights(blob_val) -> Optional[int]:
    if isinstance(blob_val, int) and blob_val >= 0:
        dup_fd = os.dup(blob_val)
        try:
            os.lseek(dup_fd, 0, os.SEEK_SET)
        except Exception:
            pass
        return dup_fd

    clean_path = str(blob_val or "").strip()
    if clean_path.startswith("file://"):
        clean_path = urllib.parse.unquote(clean_path.removeprefix("file://"))

    if not clean_path or not os.path.exists(clean_path):
        logger.warning(f"ensure_readable_fd: file path '{clean_path}' does not exist on disk, falling back to anonymous fd")
        return None

    try:
        fd = os.open(clean_path, os.O_RDONLY | os.O_CLOEXEC)
        logger.info(f"ensure_readable_fd resolved file path '{clean_path}' -> open fd {fd} (size: {os.path.getsize(clean_path)} bytes)")
        return fd
    except Exception as e:
        logger.error(f"ensure_readable_fd os.open failed for '{clean_path}', falling back to anonymous fd: {e}", exc_info=True)
        return None


def _decode_blob_bytes(blob_val, data_type: Optional[str]) -> bytes:
    if isinstance(blob_val, (bytes, bytearray)):
        return bytes(blob_val)
    if data_type == "base64" and isinstance(blob_val, str):
        try:
            return base64.b64decode(blob_val.strip())
        except Exception:
            return blob_val.encode("utf-8")
    if isinstance(blob_val, str):
        return blob_val.encode("utf-8")
    return str(blob_val or "").encode("utf-8")


def ensure_readable_fd(raw_blob: dict) -> Tuple[int, str, str]:
    """
    Converts any incoming XBlob payload into an open, readable file descriptor (int fd),
    mime_type, and file_name.
    """
    unwrapped = _unwrap_blob_dict(raw_blob)
    mime_type = unwrapped.get("type") or unwrapped.get("mimeType") or "application/octet-stream"
    file_name = unwrapped.get("name") or "media_payload"
    data_type = unwrapped.get("_dataType") or unwrapped.get("contentEncoding")
    blob_val = unwrapped.get("data")

    if data_type == "fd-rights":
        fd = _try_open_fd_rights(blob_val)
        if fd is not None:
            return (fd, mime_type, file_name)

    payload_bytes = _decode_blob_bytes(blob_val, data_type)
    tmp_file = tempfile.NamedTemporaryFile(delete=True)
    tmp_file.write(payload_bytes)
    tmp_file.flush()
    tmp_file.seek(0)

    dup_fd = os.dup(tmp_file.fileno())
    tmp_file.close()
    return (dup_fd, mime_type, file_name)


class X11DeviceManager:
    def __init__(self, display_name: Optional[str] = None):
        self.display_name = display_name or os.environ.get("DISPLAY")
        self.enabled = bool(self.display_name and HAS_XINTENT_XLIB)
        self.main_client = None
        self.running = False
        self.async_task = None

        if self.enabled:
            try:
                self.main_client = XIntentXlibClient(
                    app_id="dlna-bridge",
                    display_name=self.display_name
                )
                logger.info(f"X11 Device Manager enabled on DISPLAY '{self.display_name}' (Shared X11 Client Window {hex(self.main_client.client_win.id)})")
            except Exception as e:
                logger.error(f"Failed to initialize main X11 client: {e}")
                self.enabled = False
        else:
            logger.info("X11 Device Manager disabled.")

    def start_event_loop(self, main_loop: Optional[asyncio.AbstractEventLoop] = None):
        if not self.enabled or not self.main_client or self.running:
            return
        self.running = True

        async def loop_task():
            while self.running:
                if self.main_client:
                    try:
                        self.main_client.process_events_once()
                    except Exception as e:
                        logger.debug(f"X11 event loop error: {e}")
                await asyncio.sleep(0.01)

        loop = main_loop or asyncio.get_event_loop()
        self.async_task = loop.create_task(loop_task())
        logger.info("Started 100% Async X11 Event Task on shared X11 connection.")

    def attach_device_x11_window(self, dev, message_handler_callback):
        if not self.enabled or not self.main_client:
            return
        try:
            sub_win = self.main_client.create_sub_window(
                dev.app_id,
                manifest=dev.build_manifest()
            )
            dev.xintent_client = self.main_client
            dev.xintent_win_id = sub_win.id

            def x11_handler(payload):
                message_handler_callback(dev.app_id, payload)

            self.main_client.register_handler("fs.SendTo", x11_handler, win_id=sub_win.id)
            self.main_client.register_handler("media.Play", x11_handler, win_id=sub_win.id)
            logger.info(f"Attached device proxy Window {hex(dev.xintent_win_id)} on shared X11 connection for [{dev.friendly_name}] ({dev.app_id})")
        except Exception as e:
            logger.error(f"Failed to attach device window for {dev.friendly_name}: {e}")

    def detach_device_x11_window(self, dev):
        if dev.xintent_win_id and self.main_client and dev.xintent_win_id in self.main_client.sub_windows:
            try:
                win = self.main_client.sub_windows.pop(dev.xintent_win_id, None)
                if win:
                    win.unmap()
                    win.destroy()
                    self.main_client.x11.disp.flush()
                logger.info(f"Closed device proxy Window {hex(dev.xintent_win_id)} for [{dev.friendly_name}]")
            except Exception as e:
                logger.debug(f"Error detaching X11 window for {dev.friendly_name}: {e}")
            dev.xintent_win_id = None


def _prepare_transcode_x11_input(x11_client, input_target, sender_win_id: Optional[int]) -> Tuple[int, Optional[str]]:
    if isinstance(input_target, int) and input_target >= 0x100:
        logger.info(f"Reusing existing XBlob {hex(input_target)} directly for media.Transcode")
        return input_target, None

    if isinstance(input_target, int):
        try:
            os.lseek(input_target, 0, os.SEEK_SET)
        except Exception:
            pass
        try:
            blob_id = x11_client.blob_create(input_target, win_id=sender_win_id)
            logger.info(f"Created input dataBlob {hex(blob_id)} for media.Transcode input fd {input_target}")
            return blob_id, None
        except Exception as e:
            logger.debug(f"Error creating blob for input fd {input_target}: {e}")
            return 0, None

    if isinstance(input_target, str):
        if input_target.startswith(("http://", "https://")):
            return 0, input_target
        if os.path.exists(input_target):
            try:
                open_fd = os.open(input_target, os.O_RDWR | os.O_CLOEXEC)
                blob_id = x11_client.blob_create(open_fd, win_id=sender_win_id)
                logger.info(f"Created input dataBlob {hex(blob_id)} for media.Transcode input path '{input_target}'")
                return blob_id, None
            except Exception as e:
                logger.debug(f"Error creating blob for input path '{input_target}': {e}")
                return 0, input_target

    return 0, None


def _resolve_transcode_x11_response(x11_client, payload: dict, sender_win_id: Optional[int]) -> Optional[Tuple[object, str]]:
    data_val = payload.get("payload") or payload
    if not isinstance(data_val, dict):
        return None
    if data_val.get("status") == "error":
        logger.error(f"Cool Transcoder returned error over X11 IPC: {data_val.get('errorMessage')}")
        return None

    resp_blob_id = payload.get("dataBlob") or payload.get("data_blob") or data_val.get("dataBlob") or data_val.get("data_blob")
    mime_type = data_val.get("mimeType") or "video/mp4"

    if resp_blob_id and hasattr(x11_client, "blob_read"):
        try:
            raw_blob = x11_client.blob_read(resp_blob_id)
            try:
                x11_client.blob_unlink(resp_blob_id, win_id=sender_win_id)
            except Exception:
                pass
            if raw_blob:
                fd, _, _ = ensure_readable_fd(raw_blob)
                return (fd, mime_type)
        except Exception as e:
            logger.error(f"Error reading response dataBlob {hex(resp_blob_id)}: {e}")

    url = data_val.get("url")
    return (url, mime_type) if url else None


async def request_media_transcode_x11(x11_client, input_target, target_accept: str, title: str = "Transcoded Stream", sender_win_id: Optional[int] = None) -> Optional[Tuple[object, str]]:
    """
    Dispatches media.Transcode intent directly over X11 IPC bus to cool-transcoder using a dataBlob
    and awaits the transcoded stream response (returning (transcoded_target, mime_type)).
    """
    if not x11_client or not getattr(x11_client, "client_win", None):
        return None

    router_id = x11_client.get_router_win_id()
    if not router_id:
        return None

    channel_id = random.randint(100000, 999999)
    future = asyncio.get_event_loop().create_future()
    input_data_blob, input_url = _prepare_transcode_x11_input(x11_client, input_target, sender_win_id)

    def response_handler(payload):
        if not future.done():
            future.set_result(_resolve_transcode_x11_response(x11_client, payload, sender_win_id))

    x11_client.register_handler("media.TranscodeResponseV0", response_handler)

    payload = {
        "intent": "media.Transcode",
        "app": "cool-transcoder",
        "accept": target_accept,
        "targetCodecs": target_accept,
        "title": title
    }
    if input_url:
        payload["url"] = input_url

    try:
        logger.info(f"Dispatching media.Transcode for '{title}' over X11 IPC (channel {channel_id}, dataBlob: {hex(input_data_blob)})...")
        x11_client.send_intent(
            target_win_id=router_id,
            payload=payload,
            channel=channel_id,
            control_word=1,
            data_blob=input_data_blob,
            sender_win_id=sender_win_id
        )
        res = await asyncio.wait_for(future, timeout=15.0)
        logger.info(f"request_media_transcode_x11 SUCCESS: received response {res}")
        return res
    except asyncio.TimeoutError:
        logger.error(f"request_media_transcode_x11 TIMED OUT waiting for media.TranscodeResponseV0 on channel {channel_id}")
        return None
    except Exception as e:
        logger.error(f"request_media_transcode_x11 failed for '{title}': {e}", exc_info=True)
        return None
