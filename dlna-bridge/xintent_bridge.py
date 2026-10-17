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
import json
import logging
import os
import sys
import tempfile
import urllib.parse
from typing import Dict, Optional, Tuple

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


def ensure_readable_fd(raw_blob: dict) -> Tuple[int, str, str]:
    """
    Converts any incoming XBlob payload into an open, readable file descriptor (int fd),
    mime_type, and file_name.
    
    Regardless of whether raw_blob is Content-Encoding: fd-rights or Content-Encoding: identity,
    a valid, open, readable file descriptor is guaranteed to be returned.
    """
    if not isinstance(raw_blob, dict):
        raw_blob = {"data": raw_blob}

    mime_type = raw_blob.get("type") or raw_blob.get("mimeType") or "application/octet-stream"
    file_name = raw_blob.get("name") or "media_payload"
    data_type = raw_blob.get("_dataType") or raw_blob.get("contentEncoding")
    blob_val = raw_blob.get("data")

    # Case A: Content-Encoding: fd-rights
    if data_type == "fd-rights":
        if isinstance(blob_val, int) and blob_val >= 0:
            dup_fd = os.dup(blob_val)
            try:
                os.lseek(dup_fd, 0, os.SEEK_SET)
            except Exception:
                pass
            return (dup_fd, mime_type, file_name)

        clean_path = str(blob_val or "").strip()
        if clean_path.startswith("file://"):
            clean_path = urllib.parse.unquote(clean_path.removeprefix("file://"))

        if clean_path and os.path.exists(clean_path):
            try:
                fd = os.open(clean_path, os.O_RDWR | os.O_CLOEXEC)
                return (fd, mime_type, file_name)
            except Exception as e:
                logger.warn(f"os.open failed for '{clean_path}', falling back to anonymous fd: {e}")

    # Case B: Content-Encoding: identity or raw bytes/base64/text
    # Write payload into an unlinked anonymous temporary file descriptor
    if isinstance(blob_val, (bytes, bytearray)):
        payload_bytes = bytes(blob_val)
    elif data_type == "base64" and isinstance(blob_val, str):
        try:
            payload_bytes = base64.b64decode(blob_val.strip())
        except Exception:
            payload_bytes = blob_val.encode("utf-8")
    elif isinstance(blob_val, str):
        payload_bytes = blob_val.encode("utf-8")
    else:
        payload_bytes = str(blob_val or "").encode("utf-8")

    tmp_file = tempfile.NamedTemporaryFile(delete=True)
    tmp_file.write(payload_bytes)
    tmp_file.flush()
    tmp_file.seek(0)

    # Duplicate open fd so it stays open independently after closing tmp_file handle
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


async def request_media_transcode_x11(x11_client, input_target, target_accept: str, title: str = "Transcoded Stream", sender_win_id: Optional[int] = None) -> Optional[Tuple[object, str]]:
    """
    Dispatches media.Transcode intent directly over X11 IPC bus to cool-transcoder using a dataBlob
    and awaits the transcoded stream response (returning (transcoded_target, mime_type)).
    """
    if not x11_client or not hasattr(x11_client, "client_win") or not x11_client.client_win:
        return None

    router_id = x11_client.get_router_win_id()
    if not router_id:
        return None

    import random
    channel_id = random.randint(100000, 999999)
    future = asyncio.get_event_loop().create_future()

    input_data_blob = 0
    input_url = None

    # Check if input_target is an existing XBlob ID (e.g. 0x102 / > 256)
    if isinstance(input_target, int) and input_target >= 0x100:
        input_data_blob = input_target
        logger.info(f"Reusing existing XBlob {hex(input_data_blob)} directly for media.Transcode")
    elif isinstance(input_target, int):
        try:
            os.lseek(input_target, 0, os.SEEK_SET)
        except Exception:
            pass
        try:
            input_data_blob = x11_client.blob_create(input_target, win_id=sender_win_id)
            logger.info(f"Created input dataBlob {hex(input_data_blob)} for media.Transcode input fd {input_target}")
        except Exception as e:
            logger.debug(f"Error creating blob for input fd {input_target}: {e}")
    elif isinstance(input_target, str):
        if input_target.startswith("http://") or input_target.startswith("https://"):
            input_url = input_target
        elif os.path.exists(input_target):
            try:
                open_fd = os.open(input_target, os.O_RDWR | os.O_CLOEXEC)
                input_data_blob = x11_client.blob_create(open_fd, win_id=sender_win_id)
                logger.info(f"Created input dataBlob {hex(input_data_blob)} for media.Transcode input path '{input_target}'")
            except Exception as e:
                logger.debug(f"Error creating blob for input path '{input_target}': {e}")
                input_url = input_target

    def response_handler(payload):
        if not future.done():
            data_val = payload.get("payload") or payload
            if isinstance(data_val, dict):
                if data_val.get("status") == "error":
                    logger.error(f"Cool Transcoder returned error over X11 IPC: {data_val.get('errorMessage')}")
                    future.set_result(None)
                    return

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
                            fd, mime, name = ensure_readable_fd(raw_blob)
                            future.set_result((fd, mime_type))
                            return
                    except Exception as e:
                        logger.error(f"Error reading response dataBlob {hex(resp_blob_id)}: {e}")

                url = data_val.get("url")
                if url:
                    future.set_result((url, mime_type))
                else:
                    future.set_result(None)

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
            control_word=1,  # SYN = 1
            data_blob=input_data_blob,
            sender_win_id=sender_win_id
        )

        res = await asyncio.wait_for(future, timeout=8.0)
        logger.info(f"Received media.TranscodeResponseV0 over X11 IPC: {res}")
        return res
    except asyncio.TimeoutError:
        logger.warning(f"Timeout waiting for media.TranscodeResponseV0 over X11 IPC for '{title}'")
    except Exception as e:
        logger.error(f"Error requesting media.Transcode over X11: {e}")

    return None
