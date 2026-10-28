#!/usr/bin/env python3
"""
DLNA Media Manager
==================
Handles DLNA/UPnP Digital Media Renderer (DMR) discovery, device capabilities,
ffprobe codec inspection on readable file descriptors (/proc/self/fd/<fd>),
HTTP media hosting, and UPnP AVTransport SOAP playback initiation.
"""

import asyncio
import json
import logging
import os
import socket
import urllib.request
import uuid
from typing import Optional

import dlna_http_server
import dlna_probe
import dlna_soap
from dlna_probe import (
    DLNADevice,
    apply_device_quirks,
    build_accept_header_from_sink,
    get_local_ip,
    probe_media_codecs,
)

logger = logging.getLogger("dlna_media_manager")

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

ALWAYS_SUPPORTED_MIMES = {"video/mp4", "video/webm", "audio/mpeg", "audio/mp4", "text/plain"}


def _parse_ssdp_headers(resp_text: str) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in resp_text.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().upper()] = v.strip()
    return headers


class DLNAMediaManager:
    def __init__(self, http_port: int = 8089, server_ws_url: str = "ws://localhost:12355/xaudio", mock_device: bool = False):
        self.http_port = http_port
        self.server_ws_url = server_ws_url
        self.mock_device = mock_device
        self.devices: dict[str, DLNADevice] = {}
        self.pending_locations: set = set()
        self.hosted_files: dict[str, tuple[object, str, str]] = {}
        self.local_ip = get_local_ip()

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

    def query_get_protocol_info(self, connection_manager_url: str, dev: Optional[DLNADevice] = None) -> tuple[set[str], str]:
        return dlna_soap.query_get_protocol_info_soap(connection_manager_url, dev=dev)

    async def fetch_device_info(self, location: str) -> Optional[DLNADevice]:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, dlna_soap.fetch_and_parse_device_description, location, self.query_get_protocol_info
        )

    async def _discover_ssdp_location(self, location: Optional[str], on_discovered) -> None:
        if not location or location in self.pending_locations:
            return
        self.pending_locations.add(location)
        dev = await self.fetch_device_info(location)
        if dev and dev.app_id not in self.devices:
            self.devices[dev.app_id] = dev
            logger.info(f"Discovered DLNA Renderer: {dev.friendly_name} [{dev.app_id}] at {location}")
            if on_discovered:
                on_discovered(dev)

    async def scan_ssdp_now(self, duration_sec: float = 3.0, on_discovered=None):
        if self.mock_device:
            return

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(0.5)

        try:
            sock.sendto(MSEARCH_MSG, (SSDP_MULTICAST_ADDR, SSDP_PORT))
        except Exception as e:
            logger.error(f"Error sending SSDP M-SEARCH: {e}")

        loop = asyncio.get_event_loop()
        start_time = loop.time()
        while (loop.time() - start_time) < duration_sec:
            try:
                data, _ = await loop.run_in_executor(None, sock.recvfrom, 2048)
                headers = _parse_ssdp_headers(data.decode("utf-8", errors="ignore"))
                await self._discover_ssdp_location(headers.get("LOCATION"), on_discovered)
            except Exception:
                await asyncio.sleep(0.1)
        sock.close()

    def parse_supported_codecs(self, dev: DLNADevice) -> set[str]:
        return dlna_probe.parse_supported_codecs_for_device(dev)

    async def is_mime_supported(self, dev: DLNADevice, mime_type: str, fd_or_target: Optional[object] = None) -> bool:
        if mime_type and mime_type not in ("*/*", "application/octet-stream"):
            clean_mime = mime_type.split(";")[0].strip().lower()
            if clean_mime not in dev.supported_mime_types and clean_mime not in ALWAYS_SUPPORTED_MIMES:
                logger.info(f"Container/MIME type '{clean_mime}' is not supported by [{dev.friendly_name}]")
                return False

        if fd_or_target is None:
            return True

        loop = asyncio.get_event_loop()
        probe_info = await loop.run_in_executor(None, probe_media_codecs, fd_or_target)
        if not probe_info or not probe_info.get("codecs"):
            return True

        return dlna_probe.check_codec_compatibility(dev, probe_info, self.parse_supported_codecs(dev))

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

        def do_post() -> Optional[str]:
            try:
                req = urllib.request.Request(
                    full_url,
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": "DLNA-XIntent-Bridge/1.0"},
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    for line in resp.read().decode("utf-8", errors="ignore").splitlines():
                        try:
                            obj = json.loads(line.strip())
                            if isinstance(obj, dict) and obj.get("url"):
                                return obj["url"]
                        except Exception:
                            pass
            except Exception as e:
                logger.error(f"Error requesting media.Transcode from {full_url}: {e}")
            return None

        return await asyncio.get_event_loop().run_in_executor(None, do_post)

    def host_readable_fd(self, fd: int, mime_type: str, file_name: str) -> str:
        target_fd = dlna_http_server.pool_pipe_to_seekable_fd(fd, file_name)
        file_id = f"file_{uuid.uuid4().hex[:8]}"
        self.hosted_files[file_id] = (target_fd, mime_type, file_name)
        hosted_url = f"http://{self.local_ip}:{self.http_port}/files/{file_id}"
        logger.info(f"Hosted readable fd {target_fd} ('{file_name}', {mime_type}) at {hosted_url}")
        return hosted_url

    def _prepare_initial_media_target(self, fd_or_url, mime_type: str, name: str) -> tuple[Optional[str], object]:
        if isinstance(fd_or_url, int):
            return self.host_readable_fd(fd_or_url, mime_type, name), fd_or_url
        if isinstance(fd_or_url, str):
            if fd_or_url.startswith(("http://", "https://")):
                return fd_or_url, fd_or_url
            if os.path.exists(fd_or_url):
                try:
                    open_fd = os.open(fd_or_url, os.O_RDWR | os.O_CLOEXEC)
                    return self.host_readable_fd(open_fd, mime_type, name), open_fd
                except Exception:
                    return fd_or_url, fd_or_url
        return None, fd_or_url

    def _apply_transcoded_result(self, transcoded_res, name: str, media_url: Optional[str], mime_type: str) -> tuple[Optional[str], str]:
        if isinstance(transcoded_res, tuple) and len(transcoded_res) == 2:
            target, res_mime = transcoded_res
            if isinstance(target, int):
                return self.host_readable_fd(target, res_mime, f"transcoded_{name}"), res_mime
            if isinstance(target, str):
                return target, res_mime
        elif isinstance(transcoded_res, str):
            return transcoded_res, "video/mp4"
        return media_url, mime_type

    async def _transcode_for_device(self, dev: DLNADevice, probe_target, media_url: Optional[str], mime_type: str, name: str, x11_client, data_blob_id: Optional[int]) -> tuple[Optional[str], str]:
        logger.info(f"Format '{mime_type}' is not supported by [{dev.friendly_name}]. Requesting media.Transcode from cool-transcoder...")
        transcoded_res = None
        if x11_client:
            from xintent_bridge import request_media_transcode_x11
            transcode_input = data_blob_id if (data_blob_id and data_blob_id >= 0x100) else probe_target
            transcoded_res = await request_media_transcode_x11(x11_client, transcode_input, dev.accept_header_val, title=name, sender_win_id=dev.xintent_win_id)
        if not transcoded_res:
            transcoded_res = await self.request_media_transcode(media_url, dev.accept_header_val, title=name)
        if transcoded_res:
            media_url, mime_type = self._apply_transcoded_result(transcoded_res, name, media_url, mime_type)
            logger.info(f"Transcoded live stream ready for [{dev.friendly_name}]: {media_url} (MIME: {mime_type})")
        return media_url, mime_type

    async def play_media(self, app_id: str, fd_or_url, mime_type: str, name: str, tx_id: int = 0, x11_client=None, data_blob_id: Optional[int] = None):
        dev = self.devices.get(app_id)
        if not dev or not dev.av_transport_control_url:
            logger.error(f"Device for app {app_id} not available or missing AVTransport")
            return

        media_url, probe_target = self._prepare_initial_media_target(fd_or_url, mime_type, name)
        was_transcoded = False
        if not await self.is_mime_supported(dev, mime_type, probe_target):
            was_transcoded = True
            media_url, mime_type = await self._transcode_for_device(dev, probe_target, media_url, mime_type, name, x11_client, data_blob_id)

        logger.info(f"Executing media.Play on '{dev.friendly_name}' with URL: {media_url}")
        clean_mime = mime_type.split(";")[0].strip().lower()
        didl_xml = dlna_soap.build_didl_lite_metadata(name, clean_mime, media_url or "")

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, dlna_soap.execute_soap_playback, dev, media_url or "", didl_xml)
        return was_transcoded

    async def handle_http_media_request(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        await dlna_http_server.serve_http_media_request(self.hosted_files, reader, writer)
