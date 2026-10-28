#!/usr/bin/env python3
"""
DLNA Media Probe & Capability Helpers
=====================================
Handles ffprobe codec inspection, DLNA device model, Sink protocol info parsing,
Accept header construction, and hardware device quirks.
"""

import json
import logging
import os
import re
import shutil
import socket
import subprocess
import urllib.parse
from typing import Dict, List, Optional, Set, Tuple

logger = logging.getLogger("dlna_media_manager")

CONTAINER_DEFAULTS: Dict[str, Set[str]] = {
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

PRIORITY_CONTAINERS = [
    "video/mp4", "video/x-msvideo", "video/avi", "video/x-mkv",
    "video/webm", "video/hevc", "video/x-ms-wmv", "video/mpeg"
]

PROFILE_CODEC_RULES: List[Tuple[Tuple[str, ...], List[str]]] = [
    (("MPEG4_P2", "DIVX"), ["mpeg4", "divx"]),
    (("AVC", "H264"), ["h264"]),
    (("HEVC", "H265"), ["hevc", "h265"]),
    (("WMV", "VC1"), ["wmv3", "vc1"]),
    (("AAC", "HEAAC"), ["aac"]),
    (("MP3", "MPEG1_L3"), ["mp3"]),
    (("AC3", "XAC3"), ["ac3"]),
]

MIME_TO_INFERRED_CODECS: Dict[str, List[str]] = {
    "audio/mpeg": ["mp3"],
    "audio/mp3": ["mp3"],
    "audio/x-flac": ["flac"],
    "audio/flac": ["flac"],
    "audio/vnd.dolby.dd-raw": ["ac3"],
    "audio/ac3": ["ac3"],
    "video/hevc": ["hevc", "h265"],
    "video/x-hevc": ["hevc", "h265"],
    "video/x-msvideo": ["mpeg4", "h264", "aac", "mp3"],
    "video/x-avi": ["mpeg4", "h264", "aac", "mp3"],
    "video/avi": ["mpeg4", "h264", "aac", "mp3"],
    "video/mp4": ["mpeg4", "h264", "aac", "mp3"],
    "video/quicktime": ["mpeg4", "h264", "aac", "mp3"],
    "video/mpeg2": ["mpeg2"],
    "video/mpeg": ["mpeg2"],
    "audio/x-ms-wma": ["wma"],
    "audio/wma": ["wma"],
    "audio/x-wav": ["pcm", "pcm_s16le"],
    "audio/wav": ["pcm", "pcm_s16le"],
}

CODEC_NORMALIZATION_MAP: Dict[str, str] = {
    "h264": "h264",
    "avc1": "h264",
    "hevc": "hevc",
    "h265": "hevc",
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


def _resolve_probe_target(fd_or_target) -> Tuple[str, List[int]]:
    if isinstance(fd_or_target, int):
        try:
            os.lseek(fd_or_target, 0, os.SEEK_SET)
        except Exception:
            pass
        return f"/proc/{os.getpid()}/fd/{fd_or_target}", [fd_or_target]

    target_path = str(fd_or_target).strip()
    if target_path.startswith("file://"):
        target_path = urllib.parse.unquote(target_path.removeprefix("file://"))
    return target_path, []


def _is_valid_video_tag(ctag) -> bool:
    if not ctag or not isinstance(ctag, str):
        return False
    ctag_clean = ctag.lower().strip()
    if not ctag_clean or ctag_clean in ("0x0000", "none"):
        return False
    return not bool(re.search(r"[\[\]\x00-\x1f]", ctag_clean))


def _extract_stream_codecs(streams: list) -> dict:
    result = {"video": None, "audio": None, "codecs": []}
    for stream in streams:
        ctype = stream.get("codec_type")
        cname = stream.get("codec_name")
        if ctype not in ("video", "audio") or not cname:
            continue
        cname_clean = cname.lower().strip()
        result[ctype] = cname_clean
        if cname_clean not in result["codecs"]:
            result["codecs"].append(cname_clean)
        ctag = stream.get("codec_tag_string")
        if ctype == "video" and _is_valid_video_tag(ctag):
            ctag_clean = ctag.lower().strip()
            if ctag_clean not in result["codecs"]:
                result["codecs"].append(ctag_clean)
    return result


def probe_media_codecs(fd_or_target) -> dict:
    """
    Runs ffprobe to detect video/audio codecs in an open file descriptor or URL.
    Returns dict e.g.: {'video': 'h264', 'audio': 'aac', 'codecs': ['h264', 'aac']}
    """
    if not shutil.which("ffprobe") or fd_or_target is None:
        return {}

    target_path, pass_fds = _resolve_probe_target(fd_or_target)
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "stream=codec_name,codec_type,codec_tag_string",
        "-of", "json",
        target_path
    ]
    kwargs = {"pass_fds": pass_fds} if pass_fds else {}
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=5, **kwargs)
        if res.returncode == 0 and res.stdout:
            data = json.loads(res.stdout)
            result = _extract_stream_codecs(data.get("streams", []))
            logger.info(f"ffprobe probe result for target '{target_path}': video={result['video']}, audio={result['audio']}, codecs={result['codecs']}")
            return result
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


def _extract_profile_codecs(profile: str) -> Set[str]:
    found: Set[str] = set()
    for tokens, codecs in PROFILE_CODEC_RULES:
        if any(tok in profile for tok in tokens):
            found.update(codecs)
    return found


def _parse_sink_video_entries(sink_text: str, container_codecs: Dict[str, Set[str]]) -> None:
    for raw_entry in sink_text.split(","):
        entry = raw_entry.strip()
        if not entry.startswith("http-get:"):
            continue
        parts = entry.split(":")
        if len(parts) < 3:
            continue
        mime = parts[2].strip().lower()
        if mime.startswith("video/"):
            container_codecs.setdefault(mime, set()).update(_extract_profile_codecs(entry.upper()))


def _format_accept_parts(container_codecs: Dict[str, Set[str]], supported_mimes: Set[str]) -> List[str]:
    accept_parts: List[str] = []
    added_mimes: Set[str] = set()

    ordered_mimes = PRIORITY_CONTAINERS + [m for m in container_codecs if m not in PRIORITY_CONTAINERS]
    for mime in ordered_mimes:
        codecs = container_codecs.get(mime)
        if codecs and mime not in added_mimes:
            codecs_str = ", ".join(sorted(codecs))
            accept_parts.append(f'{mime}; codecs="{codecs_str}"')
            added_mimes.add(mime)

    for mime in sorted(supported_mimes):
        if mime not in added_mimes and not mime.startswith("video/"):
            accept_parts.append(mime)
            added_mimes.add(mime)

    if "text/plain" not in added_mimes:
        accept_parts.append("text/plain")
    return accept_parts


def build_accept_header_from_sink(sink_text: str, supported_mimes: Set[str]) -> str:
    container_codecs: Dict[str, Set[str]] = {
        mime: set(CONTAINER_DEFAULTS[mime])
        for mime in supported_mimes
        if mime in CONTAINER_DEFAULTS
    }
    _parse_sink_video_entries(sink_text, container_codecs)
    return ", ".join(_format_accept_parts(container_codecs, supported_mimes))


def _filter_divx_codecs_from_accept(accept_val: str) -> str:
    if not accept_val:
        return accept_val

    def filter_codecs(match):
        prefix = match.group(1)
        codecs_list = [c.strip() for c in match.group(2).split(",")]
        filtered = [c for c in codecs_list if c.lower() not in ("divx", "xvid")]
        joined = ", ".join(filtered) if filtered else "h264, aac"
        return f'{prefix}{joined}"'

    return re.sub(r'([a-zA-Z0-9_/-]+;\s*codecs=")([^"]+)"', filter_codecs, accept_val)


def apply_device_quirks(dev: DLNADevice, sink_text: str, supported_mimes: Set[str], accept_val: str) -> Tuple[str, Set[str], str]:
    """
    Applies known hardware device quirks directly to raw device capabilities
    (sink_text, supported_mimes, and accept_val) BEFORE publishing manifest.
    """
    brand_info = f"{dev.manufacturer} {dev.model_name} {dev.friendly_name}".lower()
    if not any(term in brand_info for term in ("samsung", "sec", "tizen")):
        return (sink_text, supported_mimes, accept_val)

    logger.info(f"Applying device quirks for Samsung TV [{dev.friendly_name}]: Purging DivX/XviD codecs from capabilities and Accept header")
    supported_mimes = {m for m in supported_mimes if m != "video/x-divx"}
    filtered_entries = [
        e for e in sink_text.split(",")
        if "video/x-divx" not in e.lower() and "DIVX" not in e.upper() and "XVID" not in e.upper()
    ]
    sink_text = ",".join(filtered_entries)
    accept_val = _filter_divx_codecs_from_accept(accept_val)
    return (sink_text, supported_mimes, accept_val)


def parse_supported_codecs_for_device(dev: DLNADevice) -> Set[str]:
    codecs: Set[str] = set()
    if dev.accept_header_val:
        for match in re.findall(r'codecs="([^"]+)"', dev.accept_header_val):
            codecs.update(c.strip().lower() for c in match.split(","))

    for mime in dev.supported_mime_types:
        inferred = MIME_TO_INFERRED_CODECS.get(mime.lower().strip())
        if inferred:
            codecs.update(inferred)

    if not codecs:
        codecs = {"h264", "aac", "mp3", "mpeg4", "pcm", "pcm_s16le", "vorbis", "vp8"}

    logger.info(f"Resolved supported codecs for [{dev.friendly_name}]: {sorted(list(codecs))}")
    return codecs


def check_codec_compatibility(dev: DLNADevice, probe_info: dict, supported_codecs: Set[str]) -> bool:
    detected_codecs = probe_info.get("codecs") or []
    if not detected_codecs:
        return True

    logger.info(f"ffprobe detected codecs for target: video={probe_info.get('video')}, audio={probe_info.get('audio')}")
    for c in detected_codecs:
        c_norm = CODEC_NORMALIZATION_MAP.get(c, c)
        if c_norm not in supported_codecs and c not in supported_codecs:
            logger.info(f"Codec '{c}' (normalized: '{c_norm}') is NOT in supported codecs for [{dev.friendly_name}]: {supported_codecs}")
            return False
    return True
