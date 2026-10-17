#!/usr/bin/env python3
# /// script
# dependencies = [
#     "websockets>=12.0",
#     "python-xlib>=0.33",
# ]
# ///
"""
Cool Transcoder - FFmpeg Media Transcoder Service
=================================================
Accepts media.Transcode(blob/url, accept/targetCodecs) intents over X11 IPC and WebSocket,
spawns dynamic FFmpeg live transcoding pipelines, and streams transcoded video/audio over HTTP.

Usage:
    uv run cool_transcoder.py --port 8088 --server ws://localhost:12345/xaudio
"""

import argparse
import asyncio
import html
import json
import logging
import os
import re
import socket
import subprocess
import sys
import uuid
import urllib.parse
import urllib.request
from typing import Dict, List, Optional, Set, Tuple

try:
    import websockets
except ImportError:
    print("Error: 'websockets' package is required. Run with: uv run cool_transcoder.py")
    sys.exit(1)

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

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s")
logger = logging.getLogger("cool_transcoder")


def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def ensure_readable_fd(raw_blob: dict) -> Tuple[int, str, str]:
    """
    Converts any incoming XBlob payload into an open, readable file descriptor (int fd),
    mime_type, and file_name.
    """
    if isinstance(raw_blob, dict):
        if "blob" in raw_blob and isinstance(raw_blob["blob"], dict):
            raw_blob = raw_blob["blob"]
        elif "data" in raw_blob and isinstance(raw_blob["data"], dict):
            if "blob" in raw_blob["data"] and isinstance(raw_blob["data"]["blob"], dict):
                raw_blob = raw_blob["data"]["blob"]
            elif "_dataType" in raw_blob["data"] or "data" in raw_blob["data"]:
                raw_blob = raw_blob["data"]
    else:
        raw_blob = {"data": raw_blob}

    mime_type = raw_blob.get("type") or raw_blob.get("mimeType") or "application/octet-stream"
    file_name = raw_blob.get("name") or "media_payload"
    data_type = raw_blob.get("_dataType") or raw_blob.get("contentEncoding")
    blob_val = raw_blob.get("data")

    # Case A: Content-Encoding: fd-rights
    if data_type == "fd-rights":
        if isinstance(blob_val, int) and blob_val >= 0:
            dup_fd = os.dup(blob_val)
            return (dup_fd, mime_type, file_name)

        clean_path = str(blob_val or "").strip()
        if clean_path.startswith("file://"):
            clean_path = urllib.parse.unquote(clean_path.removeprefix("file://"))

        if clean_path and os.path.exists(clean_path):
            try:
                fd = os.open(clean_path, os.O_RDONLY | os.O_CLOEXEC)
                return (fd, mime_type, file_name)
            except Exception as e:
                logger.warning(f"os.open failed for '{clean_path}': {e}")

    # Case B: Raw bytes/base64/text
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

    import tempfile
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

        if "mp4" in accept_lower or "h264" in accept_lower or "avc" in accept_lower or "*/*" in accept_lower:
            mime = 'video/mp4; codecs="h264, aac"'
            flags = [
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-tune", "zerolatency",
                "-c:a", "aac",
                "-f", "mp4",
                "-movflags", "frag_keyframe+empty_moov+default_base_moof"
            ]
            return mime, flags

        if "webm" in accept_lower or "vp8" in accept_lower or "vp9" in accept_lower:
            mime = 'video/webm; codecs="vp8, vorbis"'
            flags = ["-c:v", "libvpx", "-b:v", "2M", "-crf", "10", "-c:a", "libvorbis", "-f", "webm"]
            return mime, flags

        if "mp3" in accept_lower and "video" not in accept_lower and "audio" in accept_lower:
            mime = 'audio/mpeg; codecs="mp3"'
            flags = ["-vn", "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"]
            return mime, flags

        # Default fallback to universal MP4 (H.264 + AAC)
        mime = 'video/mp4; codecs="h264, aac"'
        flags = [
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-c:a", "aac",
            "-f", "mp4",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof"
        ]
        return mime, flags


class CoolTranscoderServer:
    def __init__(self, http_port: int = 8088, server_ws_url: str = "ws://localhost:12345/xaudio", display_name: Optional[str] = None):
        self.http_port = http_port
        self.server_ws_url = server_ws_url
        self.display_name = display_name or os.environ.get("DISPLAY")
        self.sessions: Dict[str, TranscodeSession] = {}
        self.ws = None
        self.xintent_client = None
        self.local_ip = get_local_ip()

    def build_manifest(self) -> str:
        return (
            "[app]\n"
            'id = "cool-transcoder"\n'
            'name = "Cool Transcoder (FFmpeg)"\n'
            "\n"
            '[intents."media.Transcode"]\n'
            'Accept = "*/*"\n'
        )

    def create_session(self, input_url: str, accept_spec: str, title: str = "Transcoded Stream") -> TranscodeSession:
        sid = f"session_{uuid.uuid4().hex[:8]}"
        session = TranscodeSession(sid, input_url, accept_spec, title)
        self.sessions[sid] = session
        logger.info(f"Created transcode session {sid} for target '{accept_spec}' -> MIME: {session.mime_type}")
        return session

    async def handle_http_connection(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            req_str = request_line.decode("utf-8", errors="ignore").strip()

            if not req_str:
                writer.close()
                return

            parts = req_str.split(" ")
            if len(parts) < 2:
                writer.close()
                return

            method, path = parts[0], parts[1]

            # Read remaining HTTP headers
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=5.0)
                if line == b"\r\n" or line == b"\n" or not line:
                    break

            if method == "GET" and path.startswith("/stream/"):
                sid = path.removeprefix("/stream/").split("?")[0]
                session = self.sessions.get(sid)

                if not session:
                    res = "HTTP/1.1 404 Not Found\r\nContent-Length: 13\r\n\r\n404 Not Found"
                    writer.write(res.encode("utf-8"))
                    await writer.drain()
                    writer.close()
                    return

                logger.info(f"Client streaming request for session {sid} ({session.mime_type})")

                headers = [
                    "HTTP/1.1 200 OK",
                    f"Content-Type: {session.mime_type}",
                    "Transfer-Encoding: chunked",
                    "Connection: close",
                    "Access-Control-Allow-Origin: *",
                    "",
                    ""
                ]
                writer.write("\r\n".join(headers).encode("latin1"))
                await writer.drain()

                ffmpeg_cmd = [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel", "error",
                    "-re",
                    "-i", session.input_url,
                ] + session.ffmpeg_flags + ["pipe:1"]

                logger.info(f"Spawning FFmpeg pipeline: {' '.join(ffmpeg_cmd)}")

                proc = await asyncio.create_subprocess_exec(
                    *ffmpeg_cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )

                try:
                    while True:
                        chunk = await proc.stdout.read(16384)
                        if not chunk:
                            break
                        hex_len = f"{len(chunk):X}\r\n".encode("latin1")
                        writer.write(hex_len + chunk + b"\r\n")
                        await writer.drain()
                except Exception as ex:
                    logger.debug(f"Streaming write stopped for session {sid}: {ex}")
                finally:
                    # Final zero chunk
                    writer.write(b"0\r\n\r\n")
                    await writer.drain()
                    try:
                        proc.terminate()
                    except Exception:
                        pass
            else:
                res = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found"
                writer.write(res.encode("utf-8"))
                await writer.drain()

        except Exception as e:
            logger.debug(f"HTTP handler error: {e}")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def handle_transcode_intent(self, payload: dict) -> dict:
        data_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload

        tx_id = data_payload.get("txId") or data_payload.get("id") or payload.get("txId") or payload.get("id") or 0
        sender_win = data_payload.get("sender") or payload.get("sender") or 0
        channel_id = data_payload.get("channel") or payload.get("channel") or 0

        input_url = data_payload.get("url") or data_payload.get("uri") or payload.get("url") or payload.get("uri")
        accept_spec = data_payload.get("accept") or data_payload.get("targetCodecs") or payload.get("accept") or payload.get("targetCodecs") or "video/mp4; codecs=\"h264, aac\""
        title = data_payload.get("title") or payload.get("title") or "Transcoded Stream"

        input_fd = None
        data_blob_id = data_payload.get("dataBlob") or data_payload.get("data_blob") or payload.get("dataBlob") or payload.get("data_blob")
        if data_blob_id and self.xintent_client and hasattr(self.xintent_client, "blob_read"):
            try:
                raw_blob = self.xintent_client.blob_read(data_blob_id)
                # Keep input dataBlob alive while FFmpeg transcodes
                if raw_blob and isinstance(raw_blob, dict):
                    input_fd, blob_mime, blob_name = ensure_readable_fd(raw_blob)
                    input_url = f"/proc/self/fd/{input_fd}"
                    input_size = os.fstat(input_fd).st_size
                    size_desc = f"{input_size} bytes" if input_size > 0 else "live stream/pipe"
                    blob_id_str = hex(data_blob_id) if isinstance(data_blob_id, int) else str(data_blob_id)
                    logger.info(f"Resolved input dataBlob {blob_id_str} (fd-rights) -> input fd {input_fd} ({size_desc}, '/proc/self/fd/{input_fd}') for cool-transcoder")
            except Exception as e:
                blob_id_str = hex(data_blob_id) if isinstance(data_blob_id, int) else str(data_blob_id)
                logger.error(f"Error reading input dataBlob {blob_id_str} in cool-transcoder: {e}")

        blob_data = payload.get("blob")
        if not input_url and blob_data:
            if isinstance(blob_data, dict):
                input_url = blob_data.get("data")
            elif isinstance(blob_data, str):
                input_url = blob_data

        if not input_url and input_fd is None:
            response = {
                "event": "media.TranscodeResponseV0",
                "txId": tx_id,
                "status": "error",
                "errorMessage": "Missing input URL or blob"
            }
            resp_data_blob = 0
        else:
            session = self.create_session(input_url, accept_spec, title)

            # Create live stream pipe for FFmpeg output
            pipe_read, pipe_write = os.pipe()

            ffmpeg_cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel", "error",
                "-y",
                "-i", input_url,
            ] + session.ffmpeg_flags + ["pipe:1"]

            pass_fds = [pipe_write]
            if input_fd is not None:
                pass_fds.append(input_fd)

            logger.info(f"Spawning FFmpeg live transcode pipeline into pipe write fd {pipe_write}: {' '.join(ffmpeg_cmd)}")
            proc = subprocess.Popen(
                ffmpeg_cmd,
                stdout=pipe_write,
                stderr=subprocess.DEVNULL,
                pass_fds=pass_fds
            )
            # Close write side in parent process so reader encounters EOF when FFmpeg completes
            os.close(pipe_write)

            # Wait 300ms for FFmpeg to encode and write initial MP4 header & keyframe data into live stream pipe
            await asyncio.sleep(0.3)

            # Create ReadableStream XBlob for pipe_read (XBlobHost turns pipe into storage-backed fd per polyfills.md)
            resp_data_blob = 0
            if self.xintent_client and hasattr(self.xintent_client, "blob_create"):
                try:
                    blob_spec = {
                        "xblobType": "ReadableStream",
                        "type": session.mime_type,
                        "name": title,
                        "data": f"/proc/{os.getpid()}/fd/{pipe_read}",
                        "_dataType": "fd-rights",
                        "contentEncoding": "fd-rights"
                    }
                    resp_data_blob = self.xintent_client.blob_create(blob_spec)
                    logger.info(f"Created ReadableStream response dataBlob {hex(resp_data_blob)} for live stream pipe fd {pipe_read} ('/proc/{os.getpid()}/fd/{pipe_read}')")
                except Exception as e:
                    logger.error(f"Error creating response blob for live stream pipe fd {pipe_read}: {e}")

            stream_url = f"http://{self.local_ip}:{self.http_port}/stream/{session.session_id}"

            response = {
                "event": "media.TranscodeResponseV0",
                "txId": tx_id,
                "status": "ok",
                "url": stream_url,
                "mimeType": session.mime_type,
                "title": title
            }
            logger.info(f"Transcode prepared -> Stream URL: {stream_url}, Response dataBlob: {hex(resp_data_blob)}")

        if self.xintent_client and (sender_win or channel_id):
            try:
                self.xintent_client.send_event(
                    target_win_id=sender_win or self.xintent_client.get_router_win_id(),
                    payload=response,
                    tx_id=tx_id,
                    channel=channel_id,
                    control_word=2,  # FIN = 2
                    data_blob=resp_data_blob
                )
                logger.info(f"Sent media.TranscodeResponseV0 over X11 IPC (channel {channel_id}, dataBlob: {hex(resp_data_blob)})")
            except Exception as e:
                logger.error(f"Error sending X11 transcode response: {e}")

        return response

    def setup_x11(self):
        if not HAS_XINTENT_XLIB or not self.display_name:
            return

        try:
            client = XIntentXlibClient(app_id="cool-transcoder", display_name=self.display_name)
            self.xintent_client = client

            manifest = self.build_manifest()
            client.register_matchbox_toml(manifest)

            def handle_x11_transcode(payload):
                logger.info("[X11 IPC] Received media.Transcode intent")
                loop = asyncio.get_event_loop()
                loop.create_task(self.handle_transcode_intent(payload))

            client.register_handler("media.Transcode", handle_x11_transcode)
            logger.info(f"Registered cool-transcoder on X11 Window {hex(client.client_win.id)} with MATCHBOX_TOML")

            async def x11_event_loop():
                while True:
                    if self.xintent_client:
                        try:
                            self.xintent_client.process_events_once()
                        except Exception as e:
                            logger.debug(f"X11 event loop error: {e}")
                    await asyncio.sleep(0.01)

            asyncio.create_task(x11_event_loop())
            logger.info("Started 100% Async X11 Event Task for cool-transcoder.")

        except Exception as e:
            logger.warning(f"Could not initialize X11 client: {e}")

    async def run(self):
        self.setup_x11()
        http_server = await asyncio.start_server(self.handle_http_connection, "0.0.0.0", self.http_port)
        logger.info(f"Cool Transcoder HTTP Streaming Server running on http://{self.local_ip}:{self.http_port}")

        await http_server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="Cool Transcoder - FFmpeg Media Transcoder Service")
    parser.add_argument("--port", type=int, default=8088, help="HTTP streaming port (default: 8088)")
    parser.add_argument("--server", default="ws://localhost:12345/xaudio", help="XIntent WebSocket URL (default: ws://localhost:12345/xaudio)")
    parser.add_argument("--display", default=None, help="X11 DISPLAY (default: $DISPLAY)")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose debug logging")

    args = parser.parse_args()

    if args.verbose:
        logger.setLevel(logging.DEBUG)

    server = CoolTranscoderServer(http_port=args.port, server_ws_url=args.server, display_name=args.display)

    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        logger.info("Stopping Cool Transcoder...")


if __name__ == "__main__":
    main()
