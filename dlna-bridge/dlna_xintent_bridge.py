#!/usr/bin/env python3
# /// script
# dependencies = [
#     "websockets>=12.0",
#     "python-xlib>=0.33",
# ]
# ///
"""
DLNA to XIntent Bridge Daemon
=============================
Enumerates local network DLNA/UPnP Digital Media Renderers (DMR), queries their Sink capabilities
via ConnectionManager.GetProtocolInfo, advertises each renderer to the XIntent hub as an xintent app
capable of handling [intents."media.Play"] and [intents] "fs.SendTo" = true, and opens
an X11 window using x11-promises (xintent_xlib) for each DLNA device with MATCHBOX_TOML attached.

Also handles [intents] "media.FindDevices" = true to perform on-demand SSDP scanning for DLNA devices.

When a media.Play or fs.SendTo intent is dispatched to a discovered DLNA device, this daemon checks
whether the file format is natively supported. If unsupported, it sends a media.Transcode intent
to cool-transcoder and plays the live transcoded stream via UPnP AVTransport SOAP calls.

Usage:
    uv run dlna_xintent_bridge.py --port 8089 --server ws://localhost:12345/xaudio
"""

import argparse
import asyncio
import base64
import html
import json
import logging
import os
import re
import socket
import struct
import sys
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional, Set, Tuple

try:
    import websockets
except ImportError:
    print("Error: 'websockets' package is required. Run with: uv run dlna_xintent_bridge.py")
    sys.exit(1)

# Import x11-promises client library if available
X11_PROMISES_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../x11-promises"))
if os.path.exists(X11_PROMISES_DIR) and X11_PROMISES_DIR not in sys.path:
    sys.path.insert(0, X11_PROMISES_DIR)

HAS_XINTENT_XLIB = False
XIntentXlibClient = None
try:
    from xintent_xlib import XIntentXlibClient
    HAS_XINTENT_XLIB = True
except ImportError:
    pass

XLIB_AVAILABLE = False
try:
    import Xlib
    import Xlib.display
    import Xlib.X
    import Xlib.Xatom
    XLIB_AVAILABLE = True
except ImportError:
    pass

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s")
logger = logging.getLogger("dlna_xintent_bridge")

SSDP_MULTICAST_ADDR = "239.255.255.250"
SSDP_PORT = 1900
SSDP_MX = 3
MEDIA_RENDERER_ST = "urn:schemas-upnp-org:device:MediaRenderer:1"

MSEARCH_MSG = (
    f"M-SEARCH * HTTP/1.1\r\n"
    f"HOST: {SSDP_MULTICAST_ADDR}:{SSDP_PORT}\r\n"
    f'MAN: "ssdp:discover"\r\n'
    f"MX: {SSDP_MX}\r\n"
    f"ST: {MEDIA_RENDERER_ST}\r\n"
    f"\r\n"
).encode("utf-8")

MIME_CODEC_MAP = {
    "video/webm": 'codecs="vp8, vp9, opus, vorbis"',
    "video/mp4": 'codecs="h264, hevc, aac, mp3, ac3"',
    "video/x-mkv": 'codecs="h264, hevc, vp8, vp9, aac, mp3, flac, ac3"',
    "video/x-matroska": 'codecs="h264, hevc, vp8, vp9, aac, mp3, flac, ac3"',
    "video/quicktime": 'codecs="h264, hevc, aac, mp3"',
    "video/3gpp": 'codecs="h263, h264, aac, amr"',
    "video/avi": 'codecs="mpeg4, divx, xvid, mp3, ac3"',
    "video/x-avi": 'codecs="mpeg4, divx, xvid, mp3, ac3"',
    "video/x-divx": 'codecs="divx, mpeg4, mp3, ac3"',
    "video/x-flv": 'codecs="h264, vp6, aac, mp3"',
    "video/hevc": 'codecs="hevc, aac, ac3"',
    "video/mpeg": 'codecs="mpeg2video, h264, mp2, ac3"',
    "video/mpeg2": 'codecs="mpeg2video, mp2, ac3"',
    "video/x-ms-wmv": 'codecs="wmv3, vc1, wma"',
    "video/x-ms-asf": 'codecs="wmv3, vc1, wma"',
    "audio/mpeg": 'codecs="mp3"',
    "audio/mp4": 'codecs="aac, alac"',
    "audio/x-m4a": 'codecs="aac, alac"',
    "audio/ogg": 'codecs="vorbis, opus, flac"',
    "audio/x-flac": 'codecs="flac"',
    "audio/x-wav": 'codecs="pcm"',
    "audio/aac": 'codecs="aac"',
    "audio/vnd.dlna.adts": 'codecs="aac"',
    "audio/x-ms-wma": 'codecs="wma"',
    "audio/3gpp": 'codecs="amr, aac"',
}


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class DLNADevice:
    def __init__(self, location: str, udn: str):
        self.location = location
        self.udn = udn
        self.slug = re.sub(r"[^a-zA-Z0-9_-]", "_", udn.replace("uuid:", ""))
        self.app_id = f"dlna-{self.slug}"
        self.friendly_name = "Unknown DLNA Renderer"
        self.manufacturer = ""
        self.model_name = ""
        self.av_transport_control_url = ""
        self.connection_manager_control_url = ""
        self.supported_mime_types: Set[str] = set()
        self.accept_header_val = 'video/webm; codecs="vp8, vp9, opus, vorbis"'
        self.xintent_client = None
        self.xintent_win_id: Optional[int] = None

    def build_manifest(self) -> str:
        accept_str = self.accept_header_val.replace('"', '\\"')
        return (
            f'[app]\n'
            f'id = "{self.app_id}"\n'
            f'name = "DLNA ({self.friendly_name})"\n'
            f'\n'
            f'[intents]\n'
            f'"fs.SendTo" = true\n'
            f'\n'
            f'[intents."media.Play"]\n'
            f'Accept = "{accept_str}"\n'
        )


class X11DeviceManager:
    def __init__(self, display_name: Optional[str] = None):
        self.display_name = display_name or os.environ.get("DISPLAY")
        self.enabled = bool(self.display_name and (HAS_XINTENT_XLIB or XLIB_AVAILABLE))
        self.main_client = None
        self.running = False
        self.async_task = None

        if self.enabled:
            logger.info(f"X11 Device Manager enabled for DISPLAY '{self.display_name}' (x11-promises client: {HAS_XINTENT_XLIB})")
        else:
            logger.info("X11 Device Manager disabled (DISPLAY not set or X11 libs missing).")

    def start_event_loop(self, devices_dict: Dict[str, DLNADevice], main_loop: Optional[asyncio.AbstractEventLoop] = None):
        if not self.enabled or self.running:
            return
        self.running = True

        async def async_event_task():
            while self.running:
                try:
                    if self.main_client and hasattr(self.main_client, "process_events_once"):
                        self.main_client.process_events_once()

                    for dev in list(devices_dict.values()):
                        if dev.xintent_client and hasattr(dev.xintent_client, "process_events_once"):
                            dev.xintent_client.process_events_once()
                except Exception as e:
                    logger.debug(f"X11 event loop error: {e}")
                await asyncio.sleep(0.05)

        self.async_task = asyncio.create_task(async_event_task())
        logger.info("Started 100% Async X11 Event Task for device proxy windows.")

    def setup_main_bridge_window(self, find_devices_callback):
        if not self.enabled or not HAS_XINTENT_XLIB or not XIntentXlibClient:
            return
        try:
            client = XIntentXlibClient(app_id="dlna-bridge", display_name=self.display_name)
            self.main_client = client

            bridge_manifest = (
                "[app]\n"
                'id = "dlna-bridge"\n'
                'name = "DLNA XIntent Bridge"\n'
                "\n"
                "[intents]\n"
                '"media.FindDevices" = true\n'
                '"bridge.Advertise" = true\n'
            )
            client.register_matchbox_toml(bridge_manifest)

            def handle_x11_find(payload):
                logger.info("[X11 IPC] Received media.FindDevices intent")
                payload_dict = payload.payload if hasattr(payload, "payload") and isinstance(payload.payload, dict) else (payload if isinstance(payload, dict) else {})
                if hasattr(payload, "dataBlob") and payload.dataBlob:
                    payload_dict["dataBlob"] = payload.dataBlob
                asyncio.create_task(find_devices_callback(payload_dict))
                return {"status": "ok", "app": "dlna-bridge"}

            client.register_handler("media.FindDevices", handle_x11_find)
            logger.info(f"Registered main dlna-bridge on X11 Window {hex(client.client_win.id)} (media.FindDevices)")
        except Exception as e:
            logger.debug(f"Could not setup main dlna-bridge X11 window: {e}")

    def attach_device_x11_window(self, dev: DLNADevice, play_callback, send_to_callback) -> bool:
        if not self.enabled or not self.display_name:
            return False

        manifest = dev.build_manifest()

        # 1. Use x11-promises XIntentXlibClient if available
        if HAS_XINTENT_XLIB and XIntentXlibClient:
            try:
                if not self.main_client:
                    self.main_client = XIntentXlibClient(app_id="dlna-bridge", display_name=self.display_name)

                if not dev.xintent_win_id:
                    sub_win = self.main_client.create_sub_window(app_id=dev.app_id, manifest=manifest)
                    dev.xintent_win_id = sub_win.id
                    dev.xintent_client = self.main_client

                    title = f"DLNA: {dev.friendly_name}"
                    sub_win.set_wm_name(title)
                    if hasattr(self.main_client, "x11"):
                        net_wm_name = self.main_client.x11.intern_atom("_NET_WM_NAME")
                        utf8_str = self.main_client.x11.intern_atom("UTF8_STRING")
                        sub_win.change_property(
                            net_wm_name, utf8_str, 8, list(title.encode("utf-8"))
                        )
                        sub_win.map()
                        self.main_client.x11.disp.flush()

                    def handle_x11_play(payload):
                        logger.info(f"[X11 IPC] Received media.Play for {dev.friendly_name}")
                        payload_dict = payload.payload if hasattr(payload, "payload") and isinstance(payload.payload, dict) else (payload if isinstance(payload, dict) else {})
                        if hasattr(payload, "dataBlob") and payload.dataBlob:
                            payload_dict["dataBlob"] = payload.dataBlob
                        asyncio.create_task(play_callback(dev.app_id, payload_dict))
                        return {"status": "ok", "app": dev.app_id}

                    def handle_x11_send_to(payload):
                        logger.info(f"[X11 IPC] Received fs.SendTo for {dev.friendly_name}")
                        payload_dict = payload.payload if hasattr(payload, "payload") and isinstance(payload.payload, dict) else (payload if isinstance(payload, dict) else {})
                        if hasattr(payload, "dataBlob") and payload.dataBlob:
                            payload_dict["dataBlob"] = payload.dataBlob
                        asyncio.create_task(send_to_callback(dev.app_id, payload_dict))
                        return {"status": "ok", "app": dev.app_id}

                    self.main_client.register_handler("media.Play", handle_x11_play, win_id=sub_win.id)
                    self.main_client.register_handler("fs.SendTo", handle_x11_send_to, win_id=sub_win.id)
                else:
                    self.main_client.register_matchbox_toml(manifest, win_id=dev.xintent_win_id)

                win_id_hex = hex(dev.xintent_win_id) if dev.xintent_win_id else "unknown"
                logger.info(f"Attached MATCHBOX_TOML via shared X11 connection on Window {win_id_hex} for [{dev.friendly_name}] (fs.SendTo + media.Play)")
                return True

            except Exception as e:
                logger.error(f"Error attaching x11-promises window for {dev.friendly_name}: {e}")

        # 2. Raw python-xlib fallback
        if XLIB_AVAILABLE:
            try:
                disp = Xlib.display.Display(self.display_name)
                root = disp.screen().root
                atom_toml = disp.intern_atom("MATCHBOX_TOML")
                atom_toml_alt = disp.intern_atom("_MATCHBOX_TOML")
                atom_net_wm_name = disp.intern_atom("_NET_WM_NAME")
                atom_utf8_string = disp.intern_atom("UTF8_STRING")

                title = f"DLNA: {dev.friendly_name}"
                manifest_bytes = manifest.encode("utf-8")

                win = root.create_window(
                    x=100, y=100, width=320, height=200, border_width=1,
                    depth=disp.screen().root_depth,
                    window_class=Xlib.X.InputOutput,
                    visual=Xlib.X.CopyFromParent,
                    event_mask=Xlib.X.ExposureMask | Xlib.X.StructureNotifyMask
                )

                win.set_wm_name(title)
                win.change_property(atom_net_wm_name, atom_utf8_string, 8, list(title.encode("utf-8")))
                win.change_property(atom_toml, Xlib.Xatom.STRING, 8, list(manifest_bytes))
                win.change_property(atom_toml_alt, Xlib.Xatom.STRING, 8, list(manifest_bytes))

                win.map()
                disp.sync()
                logger.info(f"Opened fallback X11 Window (ID: {hex(win.id)}) for [{dev.friendly_name}] with MATCHBOX_TOML set")
                return True

            except Exception as e:
                logger.error(f"Fallback X11 window creation failed for {dev.friendly_name}: {e}")

        return False

    def detach_device_x11_window(self, dev: DLNADevice):
        if dev.xintent_client and hasattr(dev.xintent_client, "client_win") and dev.xintent_client.client_win:
            try:
                dev.xintent_client.client_win.unmap()
                dev.xintent_client.client_win.destroy()
                if hasattr(dev.xintent_client, "x11"):
                    dev.xintent_client.x11.disp.flush()
                logger.info(f"Closed X11 Window for [{dev.friendly_name}]")
            except Exception as e:
                logger.debug(f"Error detaching X11 window for {dev.friendly_name}: {e}")
            dev.xintent_client = None


class DLNABridgeDaemon:
    def __init__(self, server_ws_url: str, ssdp_interval: int = 30, display_name: Optional[str] = None, http_port: int = 8089, mock_device: bool = False):
        self.server_ws_url = server_ws_url
        self.ssdp_interval = ssdp_interval
        self.http_port = http_port
        self.mock_device = mock_device or (os.environ.get("MOCK_DLNA_DEVICE") == "1")
        self.devices: Dict[str, DLNADevice] = {}
        self.pending_locations: set = set()
        self.hosted_files: Dict[str, Tuple[bytes, str, str]] = {}
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.running = False
        self.local_ip = get_local_ip()
        self.x11_mgr = X11DeviceManager(display_name=display_name)

    def register_mock_device(self) -> DLNADevice:
        dev = DLNADevice(
            location=f"http://127.0.0.1:{self.http_port}/mock-dmr/description.xml",
            udn="uuid:304218b7-3388-45da-a2fd-c4ea6de7121a"
        )
        dev.friendly_name = "Samsung TU690T 43 TV (Mock)"
        dev.app_id = "dlna-304218b7-3388-45da-a2fd-c4ea6de7121a"
        dev.av_transport_control_url = f"http://127.0.0.1:{self.http_port}/mock-dmr/AVTransport"
        dev.connection_manager_control_url = f"http://127.0.0.1:{self.http_port}/mock-dmr/ConnectionManager"
        dev.supported_mime_types = {"video/mp4", "video/webm", "audio/mpeg", "text/plain"}
        dev.accept_header_val = 'video/mp4; codecs="h264, aac", video/webm; codecs="vp8, vorbis", text/plain'

        self.devices[dev.app_id] = dev
        logger.info(f"Registered Mock DLNA Renderer: {dev.friendly_name} [{dev.app_id}]")
        return dev

    def is_mime_supported(self, dev: DLNADevice, mime_type: str) -> bool:
        if not mime_type or mime_type in ("*/*", "application/octet-stream"):
            return True

        clean_mime = mime_type.split(";")[0].strip().lower()

        if clean_mime in dev.supported_mime_types:
            return True

        if clean_mime in ("video/mp4", "video/webm", "audio/mpeg", "audio/mp4"):
            return True

        return False

    async def request_media_transcode(self, input_url: str, target_accept: str, title: str = "Transcoded Stream") -> Optional[str]:
        http_base = self.server_ws_url.replace("ws://", "http://").replace("wss://", "https://").split("/xaudio")[0]
        full_url = f"{http_base}/intent/media/Transcode?app=cool-transcoder"

        payload = {
            "intent": "media.Transcode",
            "app": "cool-transcoder",
            "url": input_url,
            "accept": target_accept,
            "targetCodecs": target_accept,
            "title": title
        }

        loop = asyncio.get_event_loop()

        def do_post() -> Optional[str]:
            try:
                req_data = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(
                    full_url,
                    data=req_data,
                    headers={
                        "Content-Type": "application/json; charset=utf-8",
                        "User-Agent": "DLNA-XIntent-Bridge/1.0"
                    },
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    resp_text = resp.read().decode("utf-8", errors="ignore")
                    for candidate in resp_text.splitlines():
                        try:
                            obj = json.loads(candidate.strip())
                            if isinstance(obj, dict) and obj.get("url"):
                                return obj.get("url")
                        except Exception:
                            pass
            except Exception as e:
                logger.error(f"Error requesting media.Transcode from {full_url}: {e}")
            return None

        return await loop.run_in_executor(None, do_post)

    async def handle_http_media_request(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            req_str = request_line.decode("utf-8", errors="ignore").strip()

            if not req_str:
                writer.close()
                return

            req_headers = {}
            while True:
                line_bytes = await asyncio.wait_for(reader.readline(), timeout=2.0)
                line_str = line_bytes.decode("utf-8", errors="ignore").strip()
                if not line_str:
                    break
                if ":" in line_str:
                    hk, hv = line_str.split(":", 1)
                    req_headers[hk.strip().lower()] = hv.strip()

            parts = req_str.split(" ")
            method = parts[0].upper() if parts else ""
            peer_info = writer.get_extra_info("peername")
            peer_addr = f"{peer_info[0]}:{peer_info[1]}" if peer_info and len(peer_info) >= 2 else "unknown"
            formatted_headers = "\n  ".join(f"{k}: {v}" for k, v in req_headers.items()) if req_headers else "(None)"
            logger.info(f"[HTTP Media Request] {req_str} from {peer_addr}\n  {formatted_headers}")

            if len(parts) >= 2 and method in ("GET", "HEAD") and parts[1].startswith("/files/"):
                file_id = parts[1].removeprefix("/files/").split("?")[0]
                media_item = self.hosted_files.get(file_id)

                if media_item:
                    item_data, mime_type, name = media_item
                    display_name = name if (name and str(name) != "None") else "media.mp4"
                    dlna_features = "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"

                    if isinstance(item_data, int):
                        total_size = os.fstat(item_data).st_size
                    elif isinstance(item_data, str) and os.path.isfile(item_data):
                        total_size = os.path.getsize(item_data)
                    else:
                        raw_bytes_all = item_data if isinstance(item_data, (bytes, bytearray)) else str(item_data).encode("utf-8")
                        total_size = len(raw_bytes_all)

                    range_hdr = req_headers.get("range")
                    start_offset = 0
                    end_offset = total_size - 1
                    is_partial = False

                    if range_hdr and range_hdr.startswith("bytes="):
                        try:
                            r_spec = range_hdr.removeprefix("bytes=").split(",")[0].strip()
                            r_parts = r_spec.split("-")
                            if r_parts[0]:
                                start_offset = int(r_parts[0])
                            if len(r_parts) > 1 and r_parts[1]:
                                end_offset = int(r_parts[1])
                            if start_offset < total_size and end_offset >= start_offset:
                                end_offset = min(end_offset, total_size - 1)
                                is_partial = True
                        except Exception:
                            start_offset = 0
                            end_offset = total_size - 1
                            is_partial = False

                    content_length = end_offset - start_offset + 1
                    status_line = "HTTP/1.1 206 Partial Content" if is_partial else "HTTP/1.1 200 OK"

                    headers = [
                        status_line,
                        f"Content-Type: {mime_type}",
                        f"Content-Length: {content_length}",
                        f'Content-Disposition: inline; filename="{display_name}"',
                        f"contentFeatures.dlna.org: {dlna_features}",
                        "transferMode.dlna.org: Streaming",
                        "Accept-Ranges: bytes",
                        "Connection: close",
                        "Access-Control-Allow-Origin: *",
                    ]

                    if is_partial:
                        headers.append(f"Content-Range: bytes {start_offset}-{end_offset}/{total_size}")

                    headers.append("")
                    headers.append("")

                    writer.write("\r\n".join(headers).encode("latin1"))
                    await writer.drain()

                    if method == "GET":
                        bytes_remaining = content_length

                        if isinstance(item_data, int):
                            os.lseek(item_data, start_offset, os.SEEK_SET)
                            while bytes_remaining > 0:
                                chunk_size = min(65536, bytes_remaining)
                                chunk = os.read(item_data, chunk_size)
                                if not chunk:
                                    break
                                writer.write(chunk)
                                await writer.drain()
                                bytes_remaining -= len(chunk)
                        elif isinstance(item_data, str) and os.path.isfile(item_data):
                            with open(item_data, "rb") as f:
                                f.seek(start_offset)
                                while bytes_remaining > 0:
                                    chunk_size = min(65536, bytes_remaining)
                                    chunk = f.read(chunk_size)
                                    if not chunk:
                                        break
                                    writer.write(chunk)
                                    await writer.drain()
                                    bytes_remaining -= len(chunk)
                        else:
                            raw_slice = raw_bytes_all[start_offset : start_offset + content_length]
                            writer.write(raw_slice)
                            await writer.drain()

                        logger.info(f"Streamed '{display_name}' ({start_offset}-{end_offset}/{total_size} bytes) to DLNA renderer")
                    else:
                        logger.info(f"Responded to HEAD request for '{display_name}' ({start_offset}-{end_offset}/{total_size} bytes)")
                else:
                    res = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found"
                    writer.write(res.encode("utf-8"))
                    await writer.drain()
            else:
                res = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found"
                writer.write(res.encode("utf-8"))
                await writer.drain()
        except Exception as e:
            logger.debug(f"Media HTTP server error: {e}")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def fetch_device_description(self, location: str) -> Optional[DLNADevice]:
        loop = asyncio.get_event_loop()
        try:
            req = urllib.request.Request(location, headers={"User-Agent": "DLNA-XIntent-Bridge/1.0"})
            resp_bytes = await loop.run_in_executor(None, lambda: urllib.request.urlopen(req, timeout=5).read())
            root = ET.fromstring(resp_bytes.decode("utf-8", errors="ignore"))

            ns = {"upnp": "urn:schemas-upnp-org:device-1-0"}
            device_elem = root.find(".//upnp:device", ns)
            if device_elem is None:
                device_elem = root.find(".//device")
            if device_elem is None:
                return None

            def find_text(elem, tag: str) -> str:
                res = elem.find(f".//upnp:{tag}", ns)
                if res is None:
                    res = elem.find(f".//{tag}")
                return res.text.strip() if res is not None and res.text else ""

            friendly_name = find_text(device_elem, "friendlyName")
            udn = find_text(device_elem, "UDN")
            manufacturer = find_text(device_elem, "manufacturer")
            model_name = find_text(device_elem, "modelName")

            if not udn:
                udn = location

            dev = DLNADevice(location, udn)
            if friendly_name:
                dev.friendly_name = friendly_name
            dev.manufacturer = manufacturer
            dev.model_name = model_name

            base_url = location
            base_url_elem = root.find(".//upnp:URLBase", ns)
            if base_url_elem is not None and base_url_elem.text:
                base_url = base_url_elem.text.strip()

            services = root.findall(".//upnp:service", ns) + root.findall(".//service")
            for service in services:
                stype = find_text(service, "serviceType")
                curl = find_text(service, "controlURL")
                if not curl:
                    continue
                full_curl = urllib.parse.urljoin(base_url, curl)

                if "AVTransport" in stype:
                    dev.av_transport_control_url = full_curl
                elif "ConnectionManager" in stype:
                    dev.connection_manager_control_url = full_curl

            await self.probe_capabilities(dev)
            return dev

        except Exception as e:
            logger.warning(f"Failed to fetch/parse device description from {location}: {e}")
            return None

    async def probe_capabilities(self, dev: DLNADevice):
        if not dev.connection_manager_control_url:
            dev.accept_header_val = 'video/webm; codecs="vp8, vp9, opus, vorbis", video/mp4; codecs="h264, hevc, aac, mp3", audio/mpeg; codecs="mp3"'
            return

        soap_body = (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n'
            '  <s:Body>\n'
            '    <u:GetProtocolInfo xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1" />\n'
            '  </s:Body>\n'
            '</s:Envelope>'
        )

        headers = {
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPACTION": '"urn:schemas-upnp-org:service:ConnectionManager:1#GetProtocolInfo"',
            "User-Agent": "DLNA-XIntent-Bridge/1.0",
        }

        loop = asyncio.get_event_loop()
        try:
            req = urllib.request.Request(
                dev.connection_manager_control_url,
                data=soap_body.encode("utf-8"),
                headers=headers,
                method="POST"
            )
            resp_bytes = await loop.run_in_executor(None, lambda: urllib.request.urlopen(req, timeout=5).read())
            root = ET.fromstring(resp_bytes.decode("utf-8", errors="ignore"))

            sink_elem = root.find(".//Sink")
            sink_str = sink_elem.text if sink_elem is not None and sink_elem.text else ""

            mimes_to_profiles: Dict[str, Set[str]] = {}
            for entry in sink_str.split(","):
                entry = entry.strip()
                parts = entry.split(":")
                if len(parts) >= 3 and parts[0] == "http-get":
                    mime = parts[2]
                    if mime and mime != "*":
                        if mime not in mimes_to_profiles:
                            mimes_to_profiles[mime] = set()

                        if len(parts) >= 4 and "DLNA.ORG_PN=" in parts[3]:
                            for param in parts[3].split(";"):
                                if param.startswith("DLNA.ORG_PN="):
                                    mimes_to_profiles[mime].add(param.split("=", 1)[1])

            if mimes_to_profiles:
                dev.supported_mime_types = set(mimes_to_profiles.keys())
                mime_list = []
                for mime in sorted(mimes_to_profiles.keys()):
                    profiles = mimes_to_profiles[mime]
                    codecs = set()

                    if mime in MIME_CODEC_MAP:
                        match = re.search(r'codecs="([^"]+)"', MIME_CODEC_MAP[mime])
                        if match:
                            for c in match.group(1).split(","):
                                codecs.add(c.strip())

                    for pn in profiles:
                        pn_u = pn.upper()
                        if "AVC" in pn_u or "H264" in pn_u:
                            codecs.add("h264")
                        if "HEVC" in pn_u or "H265" in pn_u:
                            codecs.add("hevc")
                        if "MPEG" in pn_u:
                            codecs.add("mpeg2video")
                        if "WMV" in pn_u:
                            codecs.add("wmv3")
                        if "AAC" in pn_u:
                            codecs.add("aac")
                        if "MP3" in pn_u:
                            codecs.add("mp3")
                        if "AC3" in pn_u or "DOLBY" in pn_u:
                            codecs.add("ac3")
                        if "LPCM" in pn_u or "PCM" in pn_u:
                            codecs.add("pcm")

                    if codecs:
                        codec_str = ", ".join(sorted(codecs))
                        mime_list.append(f'{mime}; codecs="{codec_str}"')
                    else:
                        mime_list.append(mime)

                dev.accept_header_val = ", ".join(mime_list)
            else:
                dev.accept_header_val = 'video/webm; codecs="vp8, vp9, opus, vorbis", video/mp4; codecs="h264, hevc, aac, mp3", audio/mpeg; codecs="mp3"'

            logger.info(f"Discovered capabilities for [{dev.friendly_name}]: Accept = {dev.accept_header_val}")

        except Exception as e:
            logger.debug(f"SOAP GetProtocolInfo failed for {dev.friendly_name}: {e}")
            dev.accept_header_val = 'video/webm; codecs="vp8, vp9, opus, vorbis", video/mp4; codecs="h264, hevc, aac, mp3", audio/mpeg; codecs="mp3"'

    async def advertise_device(self, dev: DLNADevice):
        # 1. Attach MATCHBOX_TOML via X11 window
        self.x11_mgr.attach_device_x11_window(dev, self.handle_play_intent, self.handle_send_to_intent)

        # 2. Send bridge.Advertise over WebSocket if connected
        if not self.ws:
            return

        manifest = dev.build_manifest()
        payload = {
            "event": "bridge.Advertise",
            "app": dev.app_id,
            "manifest": manifest
        }

        try:
            await self.ws.send(json.dumps(payload))
            logger.info(f"Advertised XIntent app '{dev.app_id}' ({dev.friendly_name}) [fs.SendTo + media.Play] to {self.server_ws_url}")
            logger.debug(f"Manifest:\n{manifest}")
        except Exception as e:
            logger.debug(f"Failed to advertise {dev.app_id} over WebSocket: {e}")

    async def deadvertise_device(self, dev: DLNADevice):
        self.x11_mgr.detach_device_x11_window(dev)

        if not self.ws:
            return

        payload = {
            "event": "bridge.Deadvertise",
            "app": dev.app_id
        }

        try:
            await self.ws.send(json.dumps(payload))
            logger.info(f"Deadvertised XIntent app '{dev.app_id}' ({dev.friendly_name})")
        except Exception as e:
            logger.debug(f"Failed to deadvertise {dev.app_id}: {e}")

    async def scan_ssdp_now(self, duration_sec: float = 3.0):
        logger.info("Executing on-demand SSDP M-SEARCH scan for DLNA devices...")
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setblocking(False)

        sock.bind(("", 0))

        loop = asyncio.get_event_loop()
        try:
            sock.sendto(MSEARCH_MSG, (SSDP_MULTICAST_ADDR, SSDP_PORT))
        except Exception as e:
            logger.error(f"Error sending SSDP M-SEARCH: {e}")

        end_time = loop.time() + duration_sec
        while loop.time() < end_time:
            try:
                if hasattr(loop, "sock_recvfrom"):
                    data, _ = await asyncio.wait_for(loop.sock_recvfrom(sock, 4096), timeout=0.5)
                else:
                    data = await asyncio.wait_for(loop.sock_recv(sock, 4096), timeout=0.5)
                text = data.decode("utf-8", errors="ignore")

                location = None
                for line in text.split("\r\n"):
                    if line.lower().startswith("location:"):
                        location = line.split(":", 1)[1].strip()
                        break

                if location:
                    existing = any(d.location == location for d in self.devices.values()) or (location in self.pending_locations)
                    if not existing:
                        self.pending_locations.add(location)
                        try:
                            logger.info(f"Discovered new DLNA candidate at {location}")
                            dev = await self.fetch_device_description(location)
                            if dev:
                                if dev.app_id not in self.devices:
                                    self.devices[dev.app_id] = dev
                                    logger.info(f"Registered DLNA Renderer: {dev.friendly_name} [{dev.app_id}]")
                                    await self.advertise_device(dev)
                        finally:
                            self.pending_locations.discard(location)

            except asyncio.TimeoutError:
                continue
            except Exception as ex:
                logger.debug(f"SSDP recv error: {ex}")
        sock.close()

    async def handle_find_devices_intent(self, payload: dict) -> dict:
        tx_id = payload.get("txId") or payload.get("id") or 0
        logger.info("Received media.FindDevices intent. Initiating network scan...")

        await self.scan_ssdp_now(duration_sec=3.0)

        device_list = [
            {
                "appId": dev.app_id,
                "name": dev.friendly_name,
                "accept": dev.accept_header_val,
                "location": dev.location,
                "manufacturer": dev.manufacturer,
                "modelName": dev.model_name
            }
            for dev in self.devices.values()
        ]

        response = {
            "event": "media.FindDevicesResponseV0",
            "txId": tx_id,
            "status": "ok",
            "devices": device_list
        }

        if self.ws:
            try:
                await self.ws.send(json.dumps(response))
            except Exception:
                pass

        return response

    async def handle_send_to_intent(self, app_id: str, payload: dict):
        dev = self.devices.get(app_id)
        if not dev or not dev.av_transport_control_url:
            logger.error(f"Device for app {app_id} not available or missing AVTransport")
            return

        tx_id = payload.get("txId") or payload.get("id") or 0
        blob = payload.get("blob") or {}

        name = payload.get("name") or (blob.get("name") if isinstance(blob, dict) else "Sent Media")
        mime_type = payload.get("mimeType") or payload.get("type") or (blob.get("type") if isinstance(blob, dict) else "video/mp4")

        media_url = payload.get("url") or payload.get("uri")
        if not media_url and isinstance(blob, dict):
            media_url = blob.get("url") or blob.get("uri")

        data_blob_id = payload.get("dataBlob") or payload.get("data_blob")
        if not media_url and data_blob_id and dev.xintent_client and hasattr(dev.xintent_client, "blob_read"):
            try:
                raw_blob = dev.xintent_client.blob_read(data_blob_id)
                if raw_blob and isinstance(raw_blob, dict):
                    data_type = raw_blob.get("_dataType") or raw_blob.get("contentEncoding")
                    blob_data_val = raw_blob.get("data")
                    if not mime_type or mime_type == "video/mp4":
                        mime_type = raw_blob.get("type") or mime_type
                    if not name or name == "Sent Media":
                        name = raw_blob.get("name") or name

                    if data_type == "fd-rights":
                        if isinstance(blob_data_val, int):
                            file_id = f"file_{uuid.uuid4().hex[:8]}"
                            self.hosted_files[file_id] = (blob_data_val, mime_type, name)
                            media_url = f"http://{self.local_ip}:{self.http_port}/files/{file_id}"
                            logger.info(f"Read SCM_RIGHTS fd-rights XBlob {hex(data_blob_id)} -> zero-copy file descriptor {blob_data_val} hosted at {media_url}")
                        else:
                            clean_path = str(blob_data_val or "").strip()
                            if clean_path.startswith("file://"):
                                clean_path = urllib.parse.unquote(clean_path.removeprefix("file://"))

                            if clean_path and os.path.isfile(clean_path):
                                file_id = f"file_{uuid.uuid4().hex[:8]}"
                                self.hosted_files[file_id] = (clean_path, mime_type, name)
                                media_url = f"http://{self.local_ip}:{self.http_port}/files/{file_id}"
                                logger.info(f"Read fd-rights XBlob {hex(data_blob_id)} -> zero-copy local file path '{clean_path}' hosted at {media_url}")
                            else:
                                logger.warning(f"fd-rights XBlob {hex(data_blob_id)} path '{clean_path}' not accessible on filesystem (no SCM_RIGHTS file descriptor received).")
                                file_id = f"file_{uuid.uuid4().hex[:8]}"
                                self.hosted_files[file_id] = (clean_path.encode("utf-8"), mime_type, name)
                                media_url = f"http://{self.local_ip}:{self.http_port}/files/{file_id}"
                    else:
                        raw_bytes = blob_data_val if isinstance(blob_data_val, (bytes, bytearray)) else str(blob_data_val or "").encode("utf-8")
                        file_id = f"file_{uuid.uuid4().hex[:8]}"
                        self.hosted_files[file_id] = (raw_bytes, mime_type, name)
                        media_url = f"http://{self.local_ip}:{self.http_port}/files/{file_id}"
                        logger.info(f"Read XBlob {hex(data_blob_id)} & hosted file '{name}' ({len(raw_bytes)} bytes) at {media_url}")
            except Exception as ex:
                logger.error(f"Error reading XBlob {data_blob_id} for fs.SendTo: {ex}")

        if not media_url:
            data_val = blob.get("data") if isinstance(blob, dict) else payload.get("data")
            data_type = blob.get("_dataType") if isinstance(blob, dict) else payload.get("_dataType")

            if data_val:
                if data_type == "url" or (isinstance(data_val, str) and data_val.startswith("http")):
                    media_url = data_val
                else:
                    try:
                        if data_type == "base64" or isinstance(data_val, str):
                            raw_bytes = base64.b64decode(data_val.strip())
                        elif isinstance(data_val, (bytes, bytearray)):
                            raw_bytes = bytes(data_val)
                        else:
                            raw_bytes = str(data_val).encode("utf-8")

                        file_id = f"file_{uuid.uuid4().hex[:8]}"
                        self.hosted_files[file_id] = (raw_bytes, mime_type, name)
                        media_url = f"http://{self.local_ip}:{self.http_port}/files/{file_id}"
                        logger.info(f"Hosted sent file '{name}' ({len(raw_bytes)} bytes) at {media_url}")
                    except Exception as ex:
                        logger.error(f"Error processing base64 data for fs.SendTo: {ex}")

        if not media_url:
            logger.error(f"Received fs.SendTo for {dev.friendly_name} with no usable file URL or data")
            return

        logger.info(f"Received fs.SendTo for '{dev.friendly_name}' (MIME: {mime_type})")

        # Check if media format is supported natively by the DLNA renderer
        if not self.is_mime_supported(dev, mime_type):
            logger.info(f"Format '{mime_type}' is not supported by [{dev.friendly_name}]. Requesting media.Transcode from cool-transcoder...")
            transcoded_url = await self.request_media_transcode(media_url, dev.accept_header_val, title=name)
            if transcoded_url:
                logger.info(f"Transcoded live stream ready for [{dev.friendly_name}]: {transcoded_url}")
                media_url = transcoded_url
                mime_type = "video/mp4"

        play_payload = {
            "txId": tx_id,
            "url": media_url,
            "mimeType": mime_type,
            "title": name,
        }
        await self.handle_play_intent(app_id, play_payload)

        if self.ws:
            response_msg = {
                "event": "fs.SendToResponseV0",
                "txId": tx_id,
                "app": dev.app_id,
                "status": "ok"
            }
            try:
                await self.ws.send(json.dumps(response_msg))
            except Exception:
                pass

    async def handle_play_intent(self, app_id: str, payload: dict):
        dev = self.devices.get(app_id)
        if not dev or not dev.av_transport_control_url:
            logger.error(f"Device for app {app_id} not available or missing AVTransport")
            return

        tx_id = payload.get("txId") or payload.get("id") or 0
        media_url = payload.get("url") or payload.get("uri") or payload.get("data")
        mime_type = payload.get("mimeType") or "video/webm"
        title = payload.get("title") or "XIntent Media Stream"

        if not media_url:
            logger.error(f"Received media.Play intent for {dev.friendly_name} with no media URL")
            return

        # Check if media format is supported natively by the DLNA renderer
        if not self.is_mime_supported(dev, mime_type):
            logger.info(f"Format '{mime_type}' is not supported by [{dev.friendly_name}]. Requesting media.Transcode from cool-transcoder...")
            transcoded_url = await self.request_media_transcode(media_url, dev.accept_header_val, title=title)
            if transcoded_url:
                logger.info(f"Transcoded live stream ready for [{dev.friendly_name}]: {transcoded_url}")
                media_url = transcoded_url
                mime_type = "video/mp4"

        logger.info(f"Executing media.Play on '{dev.friendly_name}' with URL: {media_url}")

        dlna_flags = "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
        protocol_info = f"http-get:*:{mime_type}:{dlna_flags}"

        didl_xml = (
            '&lt;DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"&gt;'
            f'&lt;item id="0" parentID="-1" restricted="1"&gt;'
            f'&lt;dc:title&gt;{html.escape(title)}&lt;/dc:title&gt;'
            f'&lt;upnp:class&gt;object.item.videoItem&lt;/upnp:class&gt;'
            f'&lt;res protocolInfo="{protocol_info}"&gt;{html.escape(media_url)}&lt;/res&gt;'
            f'&lt;/item&gt;'
            '&lt;/DIDL-Lite&gt;'
        )

        set_uri_soap = (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n'
            '  <s:Body>\n'
            '    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">\n'
            '      <InstanceID>0</InstanceID>\n'
            f'     <CurrentURI>{html.escape(media_url)}</CurrentURI>\n'
            f'     <CurrentURIMetaData>{didl_xml}</CurrentURIMetaData>\n'
            '    </u:SetAVTransportURI>\n'
            '  </s:Body>\n'
            '</s:Envelope>'
        )

        play_soap = (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">\n'
            '  <s:Body>\n'
            '    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">\n'
            '      <InstanceID>0</InstanceID>\n'
            '      <Speed>1</Speed>\n'
            '    </u:Play>\n'
            '  </s:Body>\n'
            '</s:Envelope>'
        )

        loop = asyncio.get_event_loop()

        def send_soap(action: str, body: str) -> bool:
            headers = {
                "Content-Type": 'text/xml; charset="utf-8"',
                "SOAPACTION": f'"urn:schemas-upnp-org:service:AVTransport:1#{action}"',
                "User-Agent": "DLNA-XIntent-Bridge/1.0",
            }
            try:
                req = urllib.request.Request(
                    dev.av_transport_control_url,
                    data=body.encode("utf-8"),
                    headers=headers,
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return resp.status == 200
            except urllib.error.HTTPError as ex:
                if "mock" in dev.location or "mock" in dev.av_transport_control_url or os.environ.get("MOCK_DLNA_DEVICE") == "1":
                    logger.info(f"[MOCK DLNA SOAP] Simulated successful '{action}' SOAP call on {dev.friendly_name}")
                    return True

                err_body = ""
                try:
                    err_body = ex.read().decode("utf-8", errors="ignore")
                except Exception:
                    pass

                code_match = re.search(r"<errorCode>(\d+)</errorCode>", err_body, re.IGNORECASE)
                desc_match = re.search(r"<errorDescription>(.*?)</errorDescription>", err_body, re.IGNORECASE)

                if code_match:
                    code_val = code_match.group(1)
                    desc_val = desc_match.group(1) if desc_match else "UPnP Error"
                    logger.error(f"DLNA SOAP {action} failed on '{dev.friendly_name}' [HTTP {ex.code}] UPnP Error {code_val}: {desc_val}\nFull SOAP Fault Response:\n{err_body}")
                elif err_body:
                    logger.error(f"DLNA SOAP {action} failed on '{dev.friendly_name}' [HTTP {ex.code}]: {ex}\nFull Response Body:\n{err_body}")
                else:
                    logger.error(f"DLNA SOAP error on {action}: {ex}")

                return False
            except Exception as ex:
                if "mock" in dev.location or "mock" in dev.av_transport_control_url or os.environ.get("MOCK_DLNA_DEVICE") == "1":
                    logger.info(f"[MOCK DLNA SOAP] Simulated successful '{action}' SOAP call on {dev.friendly_name}")
                    return True
                logger.error(f"DLNA SOAP error on {action}: {ex}")
                return False

        set_ok = await loop.run_in_executor(None, lambda: send_soap("SetAVTransportURI", set_uri_soap))
        if set_ok:
            play_ok = await loop.run_in_executor(None, lambda: send_soap("Play", play_soap))
            if play_ok:
                logger.info(f"Playback successfully initiated on DLNA device '{dev.friendly_name}'")
            else:
                logger.warning(f"SetAVTransportURI succeeded but Play command failed on '{dev.friendly_name}'")

        if self.ws:
            response_msg = {
                "event": "media.PlayResponseV0",
                "txId": tx_id,
                "app": dev.app_id,
                "status": "playing" if set_ok else "error"
            }
            try:
                await self.ws.send(json.dumps(response_msg))
            except Exception:
                pass

    async def ssdp_scanner_loop(self):
        if self.mock_device or os.environ.get("MOCK_DLNA_DEVICE") == "1":
            logger.info("SSDP scanner loop disabled in mock device mode.")
            return

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setblocking(False)

        sock.bind(("", 0))

        loop = asyncio.get_event_loop()

        while self.running:
            try:
                sock.sendto(MSEARCH_MSG, (SSDP_MULTICAST_ADDR, SSDP_PORT))
                logger.debug("Sent SSDP M-SEARCH multicast")
            except Exception as e:
                logger.error(f"Error sending SSDP M-SEARCH: {e}")

            end_time = loop.time() + 5.0
            while loop.time() < end_time and self.running:
                try:
                    if hasattr(loop, "sock_recvfrom"):
                        data, _ = await asyncio.wait_for(loop.sock_recvfrom(sock, 4096), timeout=0.5)
                    else:
                        data = await asyncio.wait_for(loop.sock_recv(sock, 4096), timeout=0.5)
                    text = data.decode("utf-8", errors="ignore")

                    location = None
                    for line in text.split("\r\n"):
                        if line.lower().startswith("location:"):
                            location = line.split(":", 1)[1].strip()
                            break

                    if location:
                        existing = any(d.location == location for d in self.devices.values()) or (location in self.pending_locations)
                        if not existing:
                            self.pending_locations.add(location)
                            try:
                                logger.info(f"Discovered new DLNA candidate at {location}")
                                dev = await self.fetch_device_description(location)
                                if dev:
                                    if dev.app_id not in self.devices:
                                        self.devices[dev.app_id] = dev
                                        logger.info(f"Registered DLNA Renderer: {dev.friendly_name} [{dev.app_id}]")
                                        await self.advertise_device(dev)
                            finally:
                                self.pending_locations.discard(location)

                except asyncio.TimeoutError:
                    continue
                except Exception as ex:
                    logger.debug(f"SSDP recv error: {ex}")

            await asyncio.sleep(max(1.0, self.ssdp_interval - 5.0))

    async def ws_client_loop(self):
        while self.running:
            try:
                logger.info(f"Connecting to XIntent WebSocket server at {self.server_ws_url}...")
                async with websockets.connect(self.server_ws_url) as ws:
                    self.ws = ws
                    logger.info("Connected to XIntent WebSocket server.")

                    # Advertise main bridge app
                    bridge_manifest = (
                        "[app]\n"
                        'id = "dlna-bridge"\n'
                        'name = "DLNA XIntent Bridge"\n'
                        "\n"
                        "[intents]\n"
                        '"media.FindDevices" = true\n'
                        '"bridge.Advertise" = true\n'
                    )
                    await ws.send(json.dumps({
                        "event": "bridge.Advertise",
                        "app": "dlna-bridge",
                        "manifest": bridge_manifest
                    }))

                    for dev in self.devices.values():
                        await self.advertise_device(dev)

                    async for msg in ws:
                        try:
                            data = json.loads(msg)
                            intent_name = data.get("intent") or data.get("event")
                            target_app = data.get("app") or data.get("targetApp")

                            if intent_name == "media.FindDevices" or target_app == "dlna-bridge":
                                await self.handle_find_devices_intent(data)
                            elif intent_name == "media.Play":
                                if target_app in self.devices:
                                    await self.handle_play_intent(target_app, data)
                                else:
                                    logger.debug(f"Received media.Play for unknown app {target_app}")
                            elif intent_name in ("fs.SendTo", "fs.SaveAs"):
                                if target_app in self.devices:
                                    await self.handle_send_to_intent(target_app, data)
                                else:
                                    logger.debug(f"Received {intent_name} for unknown app {target_app}")

                        except json.JSONDecodeError:
                            logger.warning(f"Received non-JSON WebSocket frame: {msg[:100]}")
                        except Exception as ex:
                            logger.error(f"Error handling WebSocket message: {ex}")

            except (websockets.ConnectionClosed, OSError) as e:
                logger.warning(f"WebSocket disconnected ({e}). Reconnecting in 5 seconds...")
                self.ws = None
                await asyncio.sleep(5)
            except Exception as e:
                logger.error(f"Unexpected WebSocket loop error: {e}. Reconnecting in 5 seconds...")
                self.ws = None
                await asyncio.sleep(5)

    async def run(self):
        self.running = True
        main_loop = asyncio.get_running_loop()
        self.x11_mgr.setup_main_bridge_window(self.handle_find_devices_intent)

        if self.mock_device or os.environ.get("MOCK_DLNA_DEVICE") == "1":
            dev = self.register_mock_device()
            await self.advertise_device(dev)

        self.x11_mgr.start_event_loop(self.devices, main_loop=main_loop)
        media_server = await asyncio.start_server(self.handle_http_media_request, "0.0.0.0", self.http_port)
        logger.info(f"DLNA Media Host HTTP Server running on http://{self.local_ip}:{self.http_port}")
        logger.info(f"Starting DLNA XIntent Bridge Daemon (Server: {self.server_ws_url})")

        await asyncio.gather(
            media_server.serve_forever(),
            self.ssdp_scanner_loop(),
            self.ws_client_loop()
        )

    def stop(self):
        self.running = False


def main():
    parser = argparse.ArgumentParser(description="DLNA to XIntent Bridge Daemon")
    parser.add_argument("--server", default="ws://localhost:12345/xaudio", help="XIntent WebSocket URL (default: ws://localhost:12345/xaudio)")
    parser.add_argument("--port", type=int, default=8089, help="Media host HTTP server port (default: 8089)")
    parser.add_argument("--ssdp-interval", type=int, default=30, help="SSDP discovery interval in seconds (default: 30)")
    parser.add_argument("--display", default=None, help="X11 DISPLAY (default: $DISPLAY)")
    parser.add_argument("--mock-device", action="store_true", help="Register a mock DLNA renderer for offline/CI testing")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose debug logging")

    args = parser.parse_args()

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    daemon = DLNABridgeDaemon(server_ws_url=args.server, ssdp_interval=args.ssdp_interval, display_name=args.display, http_port=args.port, mock_device=args.mock_device)

    try:
        asyncio.run(daemon.run())
    except KeyboardInterrupt:
        logger.info("Stopping DLNA Bridge Daemon...")
        daemon.stop()


if __name__ == "__main__":
    main()
