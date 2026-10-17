#!/usr/bin/env python3
"""
DLNA Media Manager
==================
Handles DLNA/UPnP Digital Media Renderer (DMR) discovery, device capabilities,
ffprobe codec inspection on readable file descriptors (/proc/self/fd/<fd>),
HTTP media hosting, and UPnP AVTransport SOAP playback initiation.
"""

import asyncio
import html
import json
import logging
import os
import re
import shutil
import socket
import stat
import struct
import subprocess
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional, Set, Tuple

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


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def probe_media_codecs(fd_or_target) -> dict:
    """
    Runs ffprobe to detect video/audio codecs in an open file descriptor or URL.
    Returns dict e.g.: {'video': 'h264', 'audio': 'aac', 'codecs': ['h264', 'aac']}
    """
    if not shutil.which("ffprobe") or fd_or_target is None:
        return {}

    pass_fds = []
    if isinstance(fd_or_target, int):
        try:
            os.lseek(fd_or_target, 0, os.SEEK_SET)
        except Exception:
            pass
        target_path = f"/proc/{os.getpid()}/fd/{fd_or_target}"
        pass_fds = [fd_or_target]
    else:
        target_path = str(fd_or_target).strip()
        if target_path.startswith("file://"):
            target_path = urllib.parse.unquote(target_path.removeprefix("file://"))

    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "stream=codec_name,codec_type,codec_tag_string",
        "-of", "json",
        target_path
    ]
    try:
        kwargs = {}
        if pass_fds:
            kwargs["pass_fds"] = pass_fds

        res = subprocess.run(cmd, capture_output=True, text=True, timeout=5, **kwargs)
        if res.returncode == 0 and res.stdout:
            data = json.loads(res.stdout)
            streams = data.get("streams", [])
            result = {"video": None, "audio": None, "codecs": []}
            for stream in streams:
                ctype = stream.get("codec_type")
                cname = stream.get("codec_name")
                ctag = stream.get("codec_tag_string")
                if ctype in ("video", "audio") and cname:
                    cname_clean = cname.lower().strip()
                    result[ctype] = cname_clean
                    if cname_clean not in result["codecs"]:
                        result["codecs"].append(cname_clean)
                    if ctype == "video" and ctag and isinstance(ctag, str):
                        ctag_clean = ctag.lower().strip()
                        if ctag_clean and not re.search(r"[\[\]\x00-\x1f]", ctag_clean) and ctag_clean not in ("0x0000", "none"):
                            if ctag_clean not in result["codecs"]:
                                result["codecs"].append(ctag_clean)
            logger.info(f"ffprobe probe result for target '{target_path}': video={result['video']}, audio={result['audio']}, codecs={result['codecs']}")
            return result
        else:
            logger.warning(f"ffprobe returncode {res.returncode} for '{target_path}': {res.stderr.strip() if res.stderr else 'no stdout'}")
    except Exception as e:
        logger.warning(f"ffprobe probe failed for target '{target_path}': {e}")
    finally:
        if isinstance(fd_or_target, int):
            try:
                os.lseek(fd_or_target, 0, os.SEEK_SET)
            except Exception:
                pass
    return {}


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
        self.accept_header_val = 'video/mp4; codecs="h264, aac", video/webm; codecs="vp8, vorbis", text/plain'
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


def build_accept_header_from_sink(sink_text: str, supported_mimes: Set[str]) -> str:
    container_codecs: Dict[str, Set[str]] = {}

    container_defaults = {
        "video/mp4": {"h264", "hevc", "mpeg4", "aac", "mp3", "ac3"},
        "video/x-msvideo": {"mpeg4", "divx", "xvid", "h264", "mp3", "ac3", "pcm"},
        "video/x-avi": {"mpeg4", "divx", "xvid", "h264", "mp3", "ac3", "pcm"},
        "video/avi": {"mpeg4", "divx", "xvid", "h264", "mp3", "ac3", "pcm"},
        "video/x-divx": {"mpeg4", "divx", "xvid", "mp3", "ac3"},
        "video/x-mkv": {"h264", "hevc", "mpeg4", "vp8", "vp9", "aac", "mp3", "ac3", "eac3", "flac", "vorbis"},
        "video/webm": {"vp8", "vp9", "vorbis", "opus"},
        "video/hevc": {"hevc", "h265", "aac", "mp3", "ac3"},
        "video/x-ms-wmv": {"wmv3", "vc1", "wma", "mp3"},
        "video/x-ms-asf": {"wmv3", "vc1", "mpeg4", "wma", "mp3", "g726"},
        "video/mpeg": {"mpeg2", "mpeg1", "h264", "mpeg4", "mp2", "mp3", "ac3", "aac"},
        "video/vnd.dlna.mpeg-tts": {"mpeg2", "mpeg1", "h264", "mpeg4", "mp2", "mp3", "ac3", "aac"},
        "video/quicktime": {"h264", "mpeg4", "aac", "mp3"},
        "video/3gpp": {"h263", "h264", "mpeg4", "amr", "aac"},
    }

    for mime in supported_mimes:
        if mime in container_defaults:
            container_codecs[mime] = set(container_defaults[mime])

    for entry in sink_text.split(","):
        entry = entry.strip()
        if not entry or not entry.startswith("http-get:"):
            continue
        parts = entry.split(":")
        if len(parts) >= 3:
            mime = parts[2].strip().lower()
            if mime.startswith("video/"):
                if mime not in container_codecs:
                    container_codecs[mime] = set()

                profile = entry.upper()
                if "MPEG4_P2" in profile or "DIVX" in profile:
                    container_codecs[mime].update(["mpeg4", "divx"])
                if "AVC" in profile or "H264" in profile:
                    container_codecs[mime].add("h264")
                if "HEVC" in profile or "H265" in profile:
                    container_codecs[mime].update(["hevc", "h265"])
                if "WMV" in profile or "VC1" in profile:
                    container_codecs[mime].update(["wmv3", "vc1"])
                if "AAC" in profile or "HEAAC" in profile:
                    container_codecs[mime].add("aac")
                if "MP3" in profile or "MPEG1_L3" in profile:
                    container_codecs[mime].add("mp3")
                if "AC3" in profile or "XAC3" in profile:
                    container_codecs[mime].add("ac3")

    accept_parts = []
    priority_containers = [
        "video/mp4", "video/x-msvideo", "video/avi", "video/x-mkv",
        "video/webm", "video/hevc", "video/x-ms-wmv", "video/mpeg"
    ]
    added_mimes = set()

    for mime in priority_containers:
        if mime in container_codecs and container_codecs[mime]:
            codecs_str = ", ".join(sorted(list(container_codecs[mime])))
            accept_parts.append(f'{mime}; codecs="{codecs_str}"')
            added_mimes.add(mime)

    for mime, codecs in container_codecs.items():
        if mime not in added_mimes and codecs:
            codecs_str = ", ".join(sorted(list(codecs)))
            accept_parts.append(f'{mime}; codecs="{codecs_str}"')
            added_mimes.add(mime)

    for mime in sorted(list(supported_mimes)):
        if mime not in added_mimes and not mime.startswith("video/"):
            accept_parts.append(mime)
            added_mimes.add(mime)

    if "text/plain" not in added_mimes:
        accept_parts.append("text/plain")

    return ", ".join(accept_parts)


def apply_device_quirks(dev: DLNADevice, sink_text: str, supported_mimes: Set[str], accept_val: str) -> Tuple[str, Set[str], str]:
    """
    Applies known hardware device quirks directly to raw device capabilities
    (sink_text, supported_mimes, and accept_val) BEFORE publishing manifest.
    """
    brand_info = f"{dev.manufacturer} {dev.model_name} {dev.friendly_name}".lower()

    # Quirks for Samsung TVs (Samsung Electronics / Tizen series)
    if any(term in brand_info for term in ("samsung", "sec", "tizen")):
        logger.info(f"Applying device quirks for Samsung TV [{dev.friendly_name}]: Purging DivX/XviD codecs from capabilities and Accept header")

        # 1. Remove video/x-divx from raw supported_mimes
        supported_mimes = {m for m in supported_mimes if m != "video/x-divx"}

        # 2. Strip DIVX and XVID profile entries from raw sink_text
        sink_entries = sink_text.split(",")
        filtered_entries = [
            e for e in sink_entries
            if "video/x-divx" not in e.lower() and "DIVX" not in e.upper() and "XVID" not in e.upper()
        ]
        sink_text = ",".join(filtered_entries)

        # 3. Strip divx and xvid codecs from accept_val string
        if accept_val:
            def filter_codecs(match):
                prefix = match.group(1)
                codecs_list = [c.strip() for c in match.group(2).split(",")]
                filtered = [c for c in codecs_list if c.lower() not in ("divx", "xvid")]
                if filtered:
                    return f'{prefix}{", ".join(filtered)}"'
                return f'{prefix}h264, aac"'

            accept_val = re.sub(r'([a-zA-Z0-9_/-]+;\s*codecs=")([^"]+)"', filter_codecs, accept_val)

    return (sink_text, supported_mimes, accept_val)


class DLNAMediaManager:
    def __init__(self, http_port: int = 8089, server_ws_url: str = "ws://localhost:12355/xaudio", mock_device: bool = False):
        self.http_port = http_port
        self.server_ws_url = server_ws_url
        self.mock_device = mock_device
        self.devices: Dict[str, DLNADevice] = {}
        self.pending_locations: set = set()
        # Maps file_id -> (fd_or_path_or_bytes, mime_type, name)
        self.hosted_files: Dict[str, Tuple[object, str, str]] = {}
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

    def query_get_protocol_info(self, connection_manager_url: str, dev: Optional[DLNADevice] = None) -> Tuple[Set[str], str]:
        """
        Queries ConnectionManager.GetProtocolInfo via UPnP SOAP to obtain the renderer's supported Sink MIME types and codecs.
        Returns: (supported_mime_types: Set[str], accept_header_val: str)
        """
        if not connection_manager_url:
            return ({"video/mp4", "video/webm", "audio/mpeg", "text/plain"}, 'video/mp4; codecs="h264, aac", video/webm; codecs="vp8, vorbis", text/plain')

        soap_body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
            '<s:Body>'
            '<u:GetProtocolInfo xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1"/>'
            '</s:Body>'
            '</s:Envelope>'
        )
        supported_mimes: Set[str] = set()

        try:
            req = urllib.request.Request(
                connection_manager_url,
                data=soap_body.encode("utf-8"),
                headers={
                    "Content-Type": 'text/xml; charset="utf-8"',
                    "SOAPACTION": '"urn:schemas-upnp-org:service:ConnectionManager:1#GetProtocolInfo"'
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=3) as resp:
                xml_resp = resp.read()

            root = ET.fromstring(xml_resp)
            sink_text = root.findtext(".//Sink") or root.findtext(".//sink") or ""

            logger.info(f"=== [DLNA Device Sink Capabilities] Response from {connection_manager_url} ===")
            logger.info(f"{sink_text}")
            logger.info("==========================================================================")

            for entry in sink_text.split(","):
                entry = entry.strip()
                if not entry or not entry.startswith("http-get:"):
                    continue

                parts = entry.split(":")
                if len(parts) >= 3:
                    mime = parts[2].strip().lower()
                    if mime and mime != "*":
                        supported_mimes.add(mime)

            accept_val = build_accept_header_from_sink(sink_text, supported_mimes)

            # Apply device quirks on capability data & Accept string
            if dev:
                sink_text, supported_mimes, accept_val = apply_device_quirks(dev, sink_text, supported_mimes, accept_val)

        except Exception as e:
            logger.debug(f"GetProtocolInfo query error for {connection_manager_url}: {e}")
            accept_val = 'video/mp4; codecs="h264, aac", video/webm; codecs="vp8, vorbis", text/plain'

        if not supported_mimes:
            supported_mimes = {"video/mp4", "video/webm", "audio/mpeg", "text/plain"}
            accept_val = 'video/mp4; codecs="h264, aac", video/webm; codecs="vp8, vorbis", text/plain'
        else:
            supported_mimes.add("text/plain")

        return (supported_mimes, accept_val)

    async def fetch_device_info(self, location: str) -> Optional[DLNADevice]:
        loop = asyncio.get_event_loop()

        def do_fetch():
            try:
                req = urllib.request.Request(location, headers={"User-Agent": "DLNA-XIntent-Bridge/1.0"})
                with urllib.request.urlopen(req, timeout=3) as resp:
                    xml_data = resp.read()
                root = ET.fromstring(xml_data)

                ns = {"ns": "urn:schemas-upnp-org:device-1-0"}
                dev_elem = root.find(".//ns:device", ns) or root.find(".//device")
                if dev_elem is None:
                    return None

                device_type = (dev_elem.findtext("ns:deviceType", "", ns) or dev_elem.findtext("deviceType", "")).strip()
                if "MediaRenderer" not in device_type:
                    return None

                udn = (dev_elem.findtext("ns:UDN", "", ns) or dev_elem.findtext("UDN", "")).strip()
                friendly_name = (dev_elem.findtext("ns:friendlyName", "", ns) or dev_elem.findtext("friendlyName", "DLNA TV")).strip()
                manufacturer = (dev_elem.findtext("ns:manufacturer", "", ns) or dev_elem.findtext("manufacturer", "")).strip()
                model_name = (dev_elem.findtext("ns:modelName", "", ns) or dev_elem.findtext("modelName", "")).strip()

                if not udn:
                    udn = f"uuid:{uuid.uuid4()}"

                dev = DLNADevice(location=location, udn=udn)
                dev.friendly_name = friendly_name
                dev.manufacturer = manufacturer
                dev.model_name = model_name

                for s in dev_elem.findall(".//ns:service", ns) or dev_elem.findall(".//service"):
                    stype = (s.findtext("ns:serviceType", "", ns) or s.findtext("serviceType", "")).strip()
                    curl = (s.findtext("ns:controlURL", "", ns) or s.findtext("controlURL", "")).strip()
                    if "AVTransport" in stype and curl:
                        dev.av_transport_control_url = urllib.parse.urljoin(location, curl)
                    elif "ConnectionManager" in stype and curl:
                        dev.connection_manager_control_url = urllib.parse.urljoin(location, curl)

                if not dev.av_transport_control_url:
                    return None

                # Query ConnectionManager.GetProtocolInfo passing dev so device quirks apply directly to raw data BEFORE accept_val construction
                mimes, accept_val = self.query_get_protocol_info(dev.connection_manager_control_url, dev=dev)
                dev.supported_mime_types = mimes
                dev.accept_header_val = accept_val

                logger.info(f"Fetched DLNA Renderer capabilities for [{dev.friendly_name}]:")
                logger.info(f"  Supported MIME Types ({len(dev.supported_mime_types)}): {sorted(list(dev.supported_mime_types))}")
                logger.info(f"  Accept Header: {dev.accept_header_val}")

                return dev
            except Exception as e:
                logger.debug(f"Error fetching device info from {location}: {e}")
                return None

        return await loop.run_in_executor(None, do_fetch)

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

        start_time = asyncio.get_event_loop().time()
        while (asyncio.get_event_loop().time() - start_time) < duration_sec:
            try:
                data, _ = await asyncio.get_event_loop().run_in_executor(None, sock.recvfrom, 2048)
                resp_text = data.decode("utf-8", errors="ignore")
                headers = {}
                for line in resp_text.splitlines():
                    if ":" in line:
                        k, v = line.split(":", 1)
                        headers[k.strip().upper()] = v.strip()

                location = headers.get("LOCATION")
                if location and location not in self.pending_locations:
                    self.pending_locations.add(location)
                    dev = await self.fetch_device_info(location)
                    if dev and dev.app_id not in self.devices:
                        self.devices[dev.app_id] = dev
                        logger.info(f"Discovered DLNA Renderer: {dev.friendly_name} [{dev.app_id}] at {location}")
                        if on_discovered:
                            on_discovered(dev)
            except Exception:
                await asyncio.sleep(0.1)
        sock.close()

    def parse_supported_codecs(self, dev: DLNADevice) -> Set[str]:
        codecs = set()
        if dev.accept_header_val:
            matches = re.findall(r'codecs="([^"]+)"', dev.accept_header_val)
            for m in matches:
                for c in m.split(","):
                    codecs.add(c.strip().lower())

        # Infer supported codecs from dev.supported_mime_types
        for mime in dev.supported_mime_types:
            m_clean = mime.lower().strip()
            if m_clean in ("audio/mpeg", "audio/mp3"):
                codecs.add("mp3")
            elif m_clean in ("audio/x-flac", "audio/flac"):
                codecs.add("flac")
            elif m_clean in ("audio/vnd.dolby.dd-raw", "audio/ac3"):
                codecs.add("ac3")
            elif m_clean in ("video/hevc", "video/x-hevc"):
                codecs.update(["hevc", "h265"])
            elif m_clean in ("video/x-msvideo", "video/x-avi", "video/avi", "video/mp4", "video/quicktime"):
                codecs.update(["mpeg4", "h264", "aac", "mp3"])
            elif m_clean in ("video/mpeg2", "video/mpeg"):
                codecs.add("mpeg2")
            elif m_clean in ("audio/x-ms-wma", "audio/wma"):
                codecs.add("wma")
            elif m_clean in ("audio/x-wav", "audio/wav"):
                codecs.update(["pcm", "pcm_s16le"])

        if not codecs:
            codecs = {"h264", "aac", "mp3", "mpeg4", "pcm", "pcm_s16le", "vorbis", "vp8"}

        logger.info(f"Resolved supported codecs for [{dev.friendly_name}]: {sorted(list(codecs))}")
        return codecs

    async def is_mime_supported(self, dev: DLNADevice, mime_type: str, fd_or_target: Optional[object] = None) -> bool:
        if mime_type and mime_type not in ("*/*", "application/octet-stream"):
            clean_mime = mime_type.split(";")[0].strip().lower()

            if clean_mime not in dev.supported_mime_types and clean_mime not in ("video/mp4", "video/webm", "audio/mpeg", "audio/mp4", "text/plain"):
                logger.info(f"Container/MIME type '{clean_mime}' is not supported by [{dev.friendly_name}]")
                return False

        if fd_or_target is not None:
            loop = asyncio.get_event_loop()
            probe_info = await loop.run_in_executor(None, probe_media_codecs, fd_or_target)
            if probe_info and probe_info.get("codecs"):
                supported_codecs = self.parse_supported_codecs(dev)
                detected_codecs = probe_info["codecs"]
                v_codec = probe_info.get("video")
                a_codec = probe_info.get("audio")

                logger.info(f"ffprobe detected codecs for target: video={v_codec}, audio={a_codec}")

                for c in detected_codecs:
                    c_norm = c
                    if c in ("h264", "avc1"):
                        c_norm = "h264"
                    elif c in ("hevc", "h265"):
                        c_norm = "hevc"

                    if c_norm not in supported_codecs and c not in supported_codecs:
                        logger.info(f"Codec '{c}' (normalized: '{c_norm}') is NOT in supported codecs for [{dev.friendly_name}]: {supported_codecs}")
                        return False

        return True

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

    def host_readable_fd(self, fd: int, mime_type: str, file_name: str) -> str:
        """
        Registers an open readable file descriptor (int fd) for HTTP streaming.
        If fd is a non-seekable pipe/FIFO, pools incoming stream bytes into an
        anonymous seekable temporary file so DLNA renderers can seek and rewind.
        Returns the hosted HTTP URL.
        """
        target_fd = fd
        is_pipe = False
        try:
            st_mode = os.fstat(fd).st_mode
            if stat.S_ISFIFO(st_mode) or stat.S_ISSOCK(st_mode):
                is_pipe = True
        except Exception:
            pass

        if is_pipe:
            try:
                tmp_file = tempfile.NamedTemporaryFile(delete=True)
                pool_fd = os.dup(tmp_file.fileno())
                tmp_file.close()

                def pool_pipe_worker(src_fd: int, dst_fd: int):
                    try:
                        while True:
                            chunk = os.read(src_fd, 65536)
                            if not chunk:
                                break
                            os.write(dst_fd, chunk)
                    except Exception as ex:
                        logger.debug(f"Pipe pooling finished or ended for fd {src_fd}: {ex}")
                    finally:
                        try:
                            os.close(src_fd)
                        except Exception:
                            pass

                t = threading.Thread(target=pool_pipe_worker, args=(fd, pool_fd), daemon=True)
                t.start()
                target_fd = pool_fd
                logger.info(f"Started background thread pooling pipe fd {fd} -> seekable anonymous fd {pool_fd} for '{file_name}'")
            except Exception as e:
                logger.error(f"Failed to pool pipe fd {fd} to anonymous file: {e}")

        file_id = f"file_{uuid.uuid4().hex[:8]}"
        self.hosted_files[file_id] = (target_fd, mime_type, file_name)
        hosted_url = f"http://{self.local_ip}:{self.http_port}/files/{file_id}"
        logger.info(f"Hosted readable fd {target_fd} ('{file_name}', {mime_type}) at {hosted_url}")
        return hosted_url

    async def play_media(self, app_id: str, fd_or_url, mime_type: str, name: str, tx_id: int = 0, x11_client=None, data_blob_id: Optional[int] = None):
        dev = self.devices.get(app_id)
        if not dev or not dev.av_transport_control_url:
            logger.error(f"Device for app {app_id} not available or missing AVTransport")
            return

        media_url = None
        probe_target = fd_or_url

        if isinstance(fd_or_url, int):
            media_url = self.host_readable_fd(fd_or_url, mime_type, name)
            probe_target = fd_or_url
        elif isinstance(fd_or_url, str):
            if fd_or_url.startswith("http://") or fd_or_url.startswith("https://"):
                media_url = fd_or_url
                probe_target = media_url
            elif os.path.exists(fd_or_url):
                try:
                    open_fd = os.open(fd_or_url, os.O_RDWR | os.O_CLOEXEC)
                    media_url = self.host_readable_fd(open_fd, mime_type, name)
                    probe_target = open_fd
                except Exception:
                    media_url = fd_or_url
                    probe_target = fd_or_url

        was_transcoded = False
        # Check format support via ffprobe on readable fd / URL
        if not await self.is_mime_supported(dev, mime_type, probe_target):
            was_transcoded = True
            logger.info(f"Format '{mime_type}' is not supported by [{dev.friendly_name}]. Requesting media.Transcode from cool-transcoder...")
            transcoded_res = None
            if x11_client:
                from xintent_bridge import request_media_transcode_x11
                transcode_input = data_blob_id if (data_blob_id and data_blob_id >= 0x100) else probe_target
                transcoded_res = await request_media_transcode_x11(x11_client, transcode_input, dev.accept_header_val, title=name, sender_win_id=dev.xintent_win_id)
            if not transcoded_res:
                transcoded_res = await self.request_media_transcode(media_url, dev.accept_header_val, title=name)

            if transcoded_res:
                if isinstance(transcoded_res, tuple) and len(transcoded_res) == 2:
                    transcoded_target, res_mime = transcoded_res
                    if isinstance(transcoded_target, int):
                        media_url = self.host_readable_fd(transcoded_target, res_mime, f"transcoded_{name}")
                        mime_type = res_mime
                    elif isinstance(transcoded_target, str):
                        media_url = transcoded_target
                        mime_type = res_mime
                elif isinstance(transcoded_res, str):
                    media_url = transcoded_res
                    mime_type = "video/mp4"

                logger.info(f"Transcoded live stream ready for [{dev.friendly_name}]: {media_url} (MIME: {mime_type})")

        logger.info(f"Executing media.Play on '{dev.friendly_name}' with URL: {media_url}")

        clean_mime = mime_type.split(";")[0].strip().lower()

        upnp_class = "object.item.videoItem"
        if clean_mime.startswith("audio/"):
            upnp_class = "object.item.audioItem.musicItem"
        elif clean_mime.startswith("image/"):
            upnp_class = "object.item.imageItem.photo"

        dlna_flags = "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
        protocol_info = f"http-get:*:{clean_mime}:{dlna_flags}"

        raw_didl = (
            '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/" '
            'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
            'xmlns:sec="http://www.samsung.com/schemas/dlna/sec">'
            '<item id="0" parentID="-1" restricted="1">'
            f'<dc:title>{html.escape(name)}</dc:title>'
            f'<upnp:class>{upnp_class}</upnp:class>'
            f'<res protocolInfo="{protocol_info}">{html.escape(media_url)}</res>'
            '</item></DIDL-Lite>'
        )
        didl_xml = html.escape(raw_didl)

        def do_soap_call():
            try:
                soap_set_uri = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
                    '<s:Body>'
                    '<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
                    '<InstanceID>0</InstanceID>'
                    f'<CurrentURI>{html.escape(media_url)}</CurrentURI>'
                    f'<CurrentURIMetaData>{didl_xml}</CurrentURIMetaData>'
                    '</u:SetAVTransportURI>'
                    '</s:Body>'
                    '</s:Envelope>'
                )
                req1 = urllib.request.Request(
                    dev.av_transport_control_url,
                    data=soap_set_uri.encode("utf-8"),
                    headers={
                        "Content-Type": 'text/xml; charset="utf-8"',
                        "SOAPACTION": '"urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"'
                    },
                    method="POST"
                )
                with urllib.request.urlopen(req1, timeout=5) as resp:
                    resp.read()

                soap_play = (
                    '<?xml version="1.0" encoding="utf-8"?>'
                    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
                    '<s:Body>'
                    '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
                    '<InstanceID>0</InstanceID>'
                    '<Speed>1</Speed>'
                    '</u:Play>'
                    '</s:Body>'
                    '</s:Envelope>'
                )
                req2 = urllib.request.Request(
                    dev.av_transport_control_url,
                    data=soap_play.encode("utf-8"),
                    headers={
                        "Content-Type": 'text/xml; charset="utf-8"',
                        "SOAPACTION": '"urn:schemas-upnp-org:service:AVTransport:1#Play"'
                    },
                    method="POST"
                )
                with urllib.request.urlopen(req2, timeout=5) as resp:
                    resp.read()

                logger.info(f"Playback successfully initiated on DLNA device '{dev.friendly_name}'")
            except urllib.error.HTTPError as e:
                body = ""
                try:
                    body = e.read().decode("utf-8", errors="ignore")
                except Exception:
                    pass
                headers_str = "\n".join([f"  {k}: {v}" for k, v in e.headers.items()])
                logger.error(
                    f"SOAP playback call failed for '{dev.friendly_name}' [HTTP {e.code} {e.reason}]\n"
                    f"--- Response Headers ---\n{headers_str}\n"
                    f"--- Response Body ---\n{body}"
                )
            except Exception as e:
                logger.error(f"SOAP playback call failed for '{dev.friendly_name}': {e}")

        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, do_soap_call)
        return was_transcoded

    async def handle_http_media_request(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            request_line = await reader.readline()
            if not request_line:
                writer.close()
                return

            line_str = request_line.decode("utf-8", errors="ignore").strip()
            parts = line_str.split(" ")
            if len(parts) < 2:
                writer.close()
                return

            method, path_str = parts[0], parts[1]
            headers = {}
            while True:
                h_line = await reader.readline()
                if not h_line or h_line in (b"\r\n", b"\n"):
                    break
                h_str = h_line.decode("utf-8", errors="ignore").strip()
                if ":" in h_str:
                    k, v = h_str.split(":", 1)
                    headers[k.strip().lower()] = v.strip()

            logger.info(f"[HTTP Media Request] {method} {path_str} HTTP/1.1 from {writer.get_extra_info('peername')[0] if writer.get_extra_info('peername') else 'unknown'}")

            if path_str.startswith("/files/"):
                file_id = path_str.removeprefix("/files/").split("?")[0]
                item = self.hosted_files.get(file_id)
                if not item:
                    res = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
                    writer.write(res.encode("utf-8"))
                    await writer.drain()
                    writer.close()
                    return

                val, mime_type, filename = item

                # Case A: Integer File Descriptor (fd)
                if isinstance(val, int):
                    try:
                        clean_mime = mime_type.split(";")[0].strip().lower()

                        import stat
                        is_pipe = False
                        try:
                            st_mode = os.fstat(val).st_mode
                            if stat.S_ISFIFO(st_mode) or stat.S_ISSOCK(st_mode):
                                is_pipe = True
                        except Exception:
                            pass

                        if is_pipe:
                            dlna_features = "DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
                            if clean_mime == "video/mp4":
                                dlna_features = "DLNA.ORG_PN=AVC_MP4_MP_SD_AAC;" + dlna_features

                            res_headers = [
                                "HTTP/1.1 200 OK",
                                f"Content-Type: {clean_mime}",
                                "Accept-Ranges: none",
                                f"contentFeatures.dlna.org: {dlna_features}",
                                "transferMode.dlna.org: Streaming",
                                f'Content-Disposition: inline; filename="{filename}"',
                                "Connection: close",
                                "\r\n"
                            ]
                            writer.write("\r\n".join(res_headers).encode("utf-8"))
                            await writer.drain()

                            if method.upper() == "HEAD":
                                writer.close()
                                return

                            bytes_sent = 0
                            while True:
                                try:
                                    chunk = os.read(val, 65536)
                                    if not chunk:
                                        break
                                    writer.write(chunk)
                                    await writer.drain()
                                    bytes_sent += len(chunk)
                                except Exception:
                                    break

                            logger.info(f"Streamed '{filename}' from pipe fd {val} -> sent: {bytes_sent} bytes")
                            writer.close()
                            return

                        # For growing live transcoded seekable files, wait briefly until initial MP4 header is ready
                        for _ in range(30):
                            if os.fstat(val).st_size >= 1024:
                                break
                            await asyncio.sleep(0.05)

                        file_size = os.fstat(val).st_size

                        # Handle Range requests from DLNA TV
                        range_header = headers.get("range")
                        is_open_ended = False
                        start_byte = 0
                        end_byte = max(0, file_size - 1)

                        if range_header and range_header.startswith("bytes="):
                            try:
                                r_spec = range_header.removeprefix("bytes=").split("-")
                                if r_spec[0]:
                                    start_byte = int(r_spec[0])
                                if len(r_spec) > 1 and r_spec[1]:
                                    end_byte = int(r_spec[1])
                                else:
                                    is_open_ended = True
                            except Exception:
                                pass
                        else:
                            is_open_ended = True

                        if start_byte >= file_size and file_size > 0:
                            start_byte = max(0, file_size - 1)

                        content_len = max(0, end_byte - start_byte + 1)

                        if range_header:
                            status_line = "HTTP/1.1 206 Partial Content"
                            range_str = f"bytes {start_byte}-{end_byte}/{file_size}"
                        else:
                            status_line = "HTTP/1.1 200 OK"
                            range_str = None

                        dlna_features = "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
                        if clean_mime == "video/mp4":
                            dlna_features = "DLNA.ORG_PN=AVC_MP4_MP_SD_AAC;" + dlna_features

                        res_headers = [
                            status_line,
                            f"Content-Type: {clean_mime}",
                            f"Content-Length: {content_len}",
                            "Accept-Ranges: bytes",
                            f"contentFeatures.dlna.org: {dlna_features}",
                            "transferMode.dlna.org: Streaming",
                        ]
                        if range_str:
                            res_headers.append(f"Content-Range: {range_str}")
                        res_headers.extend([
                            f'Content-Disposition: inline; filename="{filename}"',
                            "Connection: close",
                            "\r\n"
                        ])

                        writer.write("\r\n".join(res_headers).encode("utf-8"))
                        await writer.drain()

                        if method.upper() == "HEAD":
                            writer.close()
                            return

                        offset = start_byte
                        bytes_sent = 0
                        stuck_count = 0
                        while is_open_ended or (bytes_sent < content_len):
                            chunk_max = 65536 if is_open_ended else min(65536, content_len - bytes_sent)
                            chunk = os.pread(val, chunk_max, offset)
                            if not chunk:
                                if is_open_ended:
                                    await asyncio.sleep(0.1)
                                    chunk = os.pread(val, chunk_max, offset)
                                    if not chunk:
                                        stuck_count += 1
                                        if stuck_count > 30:  # 3 seconds of no new data
                                            break
                                        continue
                                else:
                                    break

                            stuck_count = 0
                            writer.write(chunk)
                            await writer.drain()
                            offset += len(chunk)
                            bytes_sent += len(chunk)

                        fd_size = os.fstat(val).st_size
                        asked_str = f"range {start_byte}-{end_byte} ({content_len} bytes)" if not is_open_ended else f"range {start_byte}-EOF (open-ended)"
                        logger.info(f"Streamed '{filename}' from fd {val} -> sent: {bytes_sent} bytes, asked: {asked_str}, fd_size: {fd_size} bytes")
                    except Exception as e:
                        logger.error(f"Error streaming file descriptor {val}: {e}")
                    finally:
                        writer.close()
                    return

                # Case B: Local file path string
                file_path = val if (isinstance(val, str) and (os.path.isfile(val) or val.startswith("/proc/"))) else None
                if file_path:
                    try:
                        file_size = os.path.getsize(file_path)
                        res_headers = [
                            "HTTP/1.1 200 OK",
                            f"Content-Type: {mime_type}",
                            f"Content-Length: {file_size}",
                            "Accept-Ranges: bytes",
                            f'Content-Disposition: inline; filename="{filename}"',
                            "Connection: close",
                            "\r\n"
                        ]
                        writer.write("\r\n".join(res_headers).encode("utf-8"))
                        await writer.drain()

                        if method.upper() == "HEAD":
                            writer.close()
                            return

                        # Stream chunks directly from readable fd
                        with open(file_path, "rb") as f:
                            while True:
                                chunk = f.read(65536)
                                if not chunk:
                                    break
                                writer.write(chunk)
                                await writer.drain()

                        logger.info(f"Streamed '{filename}' (0-{file_size} bytes) from fd to DLNA renderer")
                    except Exception as e:
                        logger.error(f"Error streaming file descriptor '{file_path}': {e}")
                    finally:
                        writer.close()
                    return

                # Case B: In-memory raw bytes
                data_bytes = val if isinstance(val, (bytes, bytearray)) else str(val).encode("utf-8")
                res_headers = [
                    "HTTP/1.1 200 OK",
                    f"Content-Type: {mime_type}",
                    f"Content-Length: {len(data_bytes)}",
                    "Accept-Ranges: bytes",
                    f'Content-Disposition: inline; filename="{filename}"',
                    "Connection: close",
                    "\r\n"
                ]
                writer.write("\r\n".join(res_headers).encode("utf-8"))
                writer.write(data_bytes)
                await writer.drain()
                writer.close()
                return

            res = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nNot Found"
            writer.write(res.encode("utf-8"))
            await writer.drain()
            writer.close()
        except Exception as ex:
            logger.debug(f"HTTP Media Request error: {ex}")
            try:
                writer.close()
            except Exception:
                pass
