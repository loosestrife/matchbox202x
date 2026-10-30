#!/usr/bin/env python3
"""
End-to-End Transcode Pipeline Test Simulation
==============================================
Simulates Flammenwerfer sending an XviD/MP3 .avi video file to dlna-bridge,
verifying format rejection, cool-transcoder live transcoding over X11 IPC / file descriptors,
DLNA media hosting, HTTP streaming download, and ffprobe codec validation of the transcoded result.
"""

import asyncio
import json
import logging
import os
import shutil
import socket
import subprocess
import tempfile
import urllib.request
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../cool-transcoder")))
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../dlna-bridge")))
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from dlna_media_manager import DLNAMediaManager, probe_media_codecs
from cool_transcoder import CoolTranscoderServer

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s")
logger = logging.getLogger("test_transcode_pipeline")


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def generate_test_xvid_avi(output_path: str) -> bool:
    """Generates a 2-second test AVI video file encoded with XVID video and MP3 audio using FFmpeg."""
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=2",
        "-c:v", "mpeg4", "-vtag", "XVID",
        "-c:a", "mp3",
        output_path
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.returncode == 0 and os.path.exists(output_path)


async def run_simulation():
    logger.info("=== STEP 1: Generating XviD (.avi) Test Media Artifact ===")
    tmp_avi = tempfile.NamedTemporaryFile(suffix=".avi", delete=False)
    tmp_avi.close()
    avi_path = tmp_avi.name

    try:
        if not generate_test_xvid_avi(avi_path):
            logger.error("Failed to generate test XviD AVI video file")
            return False

        file_size_orig = os.path.getsize(avi_path)
        logger.info(f"Generated test XviD AVI media file: '{avi_path}' ({file_size_orig} bytes)")

        logger.info("\n=== STEP 1b: Simulating final-copy-pro File Payload ===")
        # Construct exact xblobPayload emitted by final-copy-pro.js for files
        fcp_payload = {
            "xblobType": "File",
            "name": os.path.basename(avi_path),
            "type": "video/x-msvideo",
            "size": file_size_orig,
            "url": f"file://{avi_path}",
            "_dataType": "fd-rights",
            "contentEncoding": "fd-rights",
            "data": avi_path,
        }

        from xintent_bridge import ensure_readable_fd
        fcp_fd, fcp_mime, fcp_name = ensure_readable_fd(fcp_payload)
        logger.info(f"Resolved final-copy-pro payload -> readable fd {fcp_fd} ('{fcp_name}', {fcp_mime})")
        assert fcp_fd >= 0, "Expected valid file descriptor from final-copy-pro payload"
        assert fcp_mime == "video/x-msvideo", f"Expected MIME video/x-msvideo, got {fcp_mime}"
        os.close(fcp_fd)

        # Open file descriptor for input media
        input_fd = os.open(avi_path, os.O_RDONLY)
        dlna_port = _find_free_port()
        transcoder_port = _find_free_port()

        logger.info("\n=== STEP 2: Initializing DLNA Media Manager & Mock Samsung TV ===")
        dlna_mgr = DLNAMediaManager(http_port=dlna_port, mock_device=True)
        dlna_mgr.local_ip = "127.0.0.1"
        dev = dlna_mgr.register_mock_device()

        # Probe codecs of input AVI file using ffprobe
        probe_res = probe_media_codecs(input_fd)
        logger.info(f"ffprobe input file codecs: {probe_res}")
        assert "xvid" in probe_res.get("codecs", []), "Expected 'xvid' FourCC in test file"

        # Check format compatibility on Samsung TV
        is_supported = await dlna_mgr.is_mime_supported(dev, "video/x-msvideo", input_fd)
        logger.info(f"Is XviD AVI supported natively on [{dev.friendly_name}]? {is_supported}")
        assert is_supported is False, "Expected Samsung TV to reject XviD AVI media format"

        logger.info("\n=== STEP 3: Initializing Cool Transcoder Server ===")
        transcoder_server = CoolTranscoderServer(http_port=transcoder_port)
        transcoder_server.local_ip = "127.0.0.1"
        transcoder_http_server = await asyncio.start_server(transcoder_server.handle_http_connection, "127.0.0.1", transcoder_port)

        logger.info("\n=== STEP 4: Dispatching media.Transcode Intent ===")
        transcode_payload = {
            "intent": "media.Transcode",
            "app": "cool-transcoder",
            "url": f"/proc/{os.getpid()}/fd/{input_fd}",
            "accept": dev.accept_header_val,
            "title": "Simulated Flammenwerfer Transcode Test"
        }

        transcode_resp = await transcoder_server.handle_transcode_intent(transcode_payload)
        logger.info(f"Cool Transcoder response: {transcode_resp}")
        assert transcode_resp.get("status") == "ok", "Expected status 'ok' from Cool Transcoder"

        stream_url = transcode_resp.get("url")
        logger.info(f"Live transcode stream URL: {stream_url}")

        logger.info("\n=== STEP 5: Hosting Transcoded Live Stream on DLNA Media Server ===")
        # Start HTTP server for DLNA Media Manager
        media_server = await asyncio.start_server(dlna_mgr.handle_http_media_request, "127.0.0.1", dlna_port)

        # Fetch initial stream from transcoder HTTP server using run_in_executor
        loop = asyncio.get_event_loop()
        def fetch_stream():
            req = urllib.request.Request(stream_url)
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.read()

        transcoded_bytes = await loop.run_in_executor(None, fetch_stream)

        logger.info(f"Downloaded transcoded live stream: {len(transcoded_bytes)} bytes")
        assert len(transcoded_bytes) > 5000, "Expected transcoded stream to contain video bytes (>5KB)"

        # Save transcoded stream to temporary file for ffprobe verification & DLNA HTTP Range test
        tmp_transcoded = tempfile.NamedTemporaryFile(suffix=".ts", delete=False)
        tmp_transcoded.write(transcoded_bytes)
        tmp_transcoded.close()

        logger.info("\n=== STEP 6: Verifying Transcoded Output with ffprobe & DLNA HTTP Range Seek ===")
        transcoded_fd = os.open(tmp_transcoded.name, os.O_RDONLY)
        out_probe = probe_media_codecs(transcoded_fd)
        logger.info(f"ffprobe transcoded output codecs: {out_probe}")

        assert out_probe.get("video") == "h264", f"Expected transcoded video codec 'h264', got {out_probe.get('video')}"
        assert out_probe.get("audio") == "aac", f"Expected transcoded audio codec 'aac', got {out_probe.get('audio')}"

        hosted_url = dlna_mgr.host_readable_fd(transcoded_fd, transcode_resp.get("mimeType", "video/mpeg"), "transcoded_test.ts")
        def fetch_range():
            req = urllib.request.Request(hosted_url, headers={"Range": "bytes=0-4095"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read()

        status_code, range_bytes = await loop.run_in_executor(None, fetch_range)
        assert status_code == 206, f"Expected HTTP 206 Partial Content, got {status_code}"
        assert len(range_bytes) == 4096, f"Expected 4096 range bytes, got {len(range_bytes)}"

        logger.info("\n=== SUCCESS: End-to-End Transcode Pipeline Simulation PASSED! ===")
        logger.info(f"Original XviD AVI ({file_size_orig} bytes) -> Successfully transcoded to MPEG-TS H.264/AAC ({len(transcoded_bytes)} bytes)")

        os.close(transcoded_fd)
        os.unlink(tmp_transcoded.name)
        try:
            os.close(input_fd)
        except OSError:
            pass
        media_server.close()
        transcoder_http_server.close()
        return True

    finally:
        if os.path.exists(avi_path):
            os.unlink(avi_path)


if __name__ == "__main__":
    success = asyncio.run(run_simulation())
    sys.exit(0 if success else 1)
