#!/usr/bin/env python3
"""
Cool Transcoder Helpers
=======================
FD/XBlob resolution and FFmpeg pipeline session configuration helpers.
"""

import base64
import logging
import os
import socket
import subprocess
import tempfile
import urllib.parse
from typing import List, Optional, Tuple

logger = logging.getLogger("cool_transcoder")

MP4_MIME = 'video/mp4; codecs="h264, aac"'
MP4_FLAGS = [
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-c:a", "aac",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof"
]

WEBM_MIME = 'video/webm; codecs="vp8, vorbis"'
WEBM_FLAGS = ["-c:v", "libvpx", "-b:v", "2M", "-crf", "10", "-c:a", "libvorbis", "-f", "webm"]

MP3_MIME = 'audio/mpeg; codecs="mp3"'
MP3_FLAGS = ["-vn", "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"]


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


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
        return os.dup(blob_val)

    clean_path = str(blob_val or "").strip()
    if clean_path.startswith("file://"):
        clean_path = urllib.parse.unquote(clean_path.removeprefix("file://"))

    if clean_path and os.path.exists(clean_path):
        try:
            return os.open(clean_path, os.O_RDONLY | os.O_CLOEXEC)
        except Exception as e:
            logger.warning(f"os.open failed for '{clean_path}': {e}")
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


class TranscodeSession:
    def __init__(self, session_id: str, input_url: str, accept_spec: str, title: str = "Transcoded Stream"):
        self.session_id = session_id
        self.input_url = input_url
        self.accept_spec = accept_spec
        self.title = title
        self.mime_type, self.ffmpeg_flags = self._select_ffmpeg_pipeline(accept_spec)

    def _select_ffmpeg_pipeline(self, accept: str) -> Tuple[str, List[str]]:
        accept_lower = accept.lower()
        if any(tok in accept_lower for tok in ("mp4", "h264", "avc", "*/*")):
            return MP4_MIME, list(MP4_FLAGS)
        if any(tok in accept_lower for tok in ("webm", "vp8", "vp9")):
            return WEBM_MIME, list(WEBM_FLAGS)
        if "mp3" in accept_lower and "video" not in accept_lower and "audio" in accept_lower:
            return MP3_MIME, list(MP3_FLAGS)
        return MP4_MIME, list(MP4_FLAGS)


def spawn_ffmpeg_pipe_pipeline(input_url: str, ffmpeg_flags: List[str], input_fd: Optional[int]) -> int:
    pipe_read, pipe_write = os.pipe()
    ffmpeg_cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", input_url,
    ] + ffmpeg_flags + ["pipe:1"]

    pass_fds = [pipe_write]
    if input_fd is not None:
        pass_fds.append(input_fd)

    logger.info(f"Spawning FFmpeg live transcode pipeline into pipe write fd {pipe_write}: {' '.join(ffmpeg_cmd)}")
    subprocess.Popen(
        ffmpeg_cmd,
        stdout=pipe_write,
        stderr=subprocess.DEVNULL,
        pass_fds=pass_fds
    )
    os.close(pipe_write)
    return pipe_read
