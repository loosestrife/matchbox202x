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
import logging
import os
import sys
import uuid
from typing import Dict, Optional, Tuple

from transcoder_helpers import (
    TranscodeSession,
    ensure_readable_fd,
    get_local_ip,
    spawn_ffmpeg_pipe_pipeline,
)

try:
    import websockets  # noqa: F401
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


async def _read_http_request_line_and_headers(reader: asyncio.StreamReader) -> Optional[Tuple[str, str]]:
    request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
    req_str = request_line.decode("utf-8", errors="ignore").strip()
    if not req_str:
        return None
    parts = req_str.split(" ")
    if len(parts) < 2:
        return None
    while True:
        line = await asyncio.wait_for(reader.readline(), timeout=5.0)
        if not line or line in (b"\r\n", b"\n"):
            break
    return parts[0], parts[1]


async def _stream_ffmpeg_session_http(session: TranscodeSession, writer: asyncio.StreamWriter) -> None:
    logger.info(f"Client streaming request for session {session.session_id} ({session.mime_type})")
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
        logger.debug(f"Streaming write stopped for session {session.session_id}: {ex}")
    finally:
        writer.write(b"0\r\n\r\n")
        await writer.drain()
        try:
            proc.terminate()
        except Exception:
            pass


def _extract_transcode_params(payload: dict) -> Tuple[int, int, int, Optional[str], str, str, object]:
    data_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    tx_id = data_payload.get("txId") or data_payload.get("id") or payload.get("txId") or payload.get("id") or 0
    sender_win = data_payload.get("sender") or payload.get("sender") or 0
    channel_id = data_payload.get("channel") or payload.get("channel") or 0
    input_url = data_payload.get("url") or data_payload.get("uri") or payload.get("url") or payload.get("uri")
    accept_spec = data_payload.get("accept") or data_payload.get("targetCodecs") or payload.get("accept") or payload.get("targetCodecs") or 'video/mp4; codecs="h264, aac"'
    title = data_payload.get("title") or payload.get("title") or "Transcoded Stream"
    data_blob_id = data_payload.get("dataBlob") or data_payload.get("data_blob") or payload.get("dataBlob") or payload.get("data_blob")
    return tx_id, sender_win, channel_id, input_url, accept_spec, title, data_blob_id


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
            parsed = await _read_http_request_line_and_headers(reader)
            if not parsed:
                return

            method, path = parsed
            if method != "GET" or not path.startswith("/stream/"):
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found")
                await writer.drain()
                return

            sid = path.removeprefix("/stream/").split("?")[0]
            session = self.sessions.get(sid)
            if not session:
                writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 13\r\n\r\n404 Not Found")
                await writer.drain()
                return

            await _stream_ffmpeg_session_http(session, writer)
        except Exception as e:
            logger.debug(f"HTTP handler error: {e}")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    def _resolve_input_source(self, payload: dict, input_url: Optional[str], data_blob_id) -> Tuple[Optional[str], Optional[int]]:
        input_fd = None
        if data_blob_id and self.xintent_client and hasattr(self.xintent_client, "blob_read"):
            blob_id_str = hex(data_blob_id) if isinstance(data_blob_id, int) else str(data_blob_id)
            try:
                raw_blob = self.xintent_client.blob_read(data_blob_id)
                if raw_blob and isinstance(raw_blob, dict):
                    input_fd, _, _ = ensure_readable_fd(raw_blob)
                    input_url = f"/proc/self/fd/{input_fd}"
                    input_size = os.fstat(input_fd).st_size
                    size_desc = f"{input_size} bytes" if input_size > 0 else "live stream/pipe"
                    logger.info(f"Resolved input dataBlob {blob_id_str} (fd-rights) -> input fd {input_fd} ({size_desc}, '/proc/self/fd/{input_fd}') for cool-transcoder")
            except Exception as e:
                logger.error(f"Error reading input dataBlob {blob_id_str} in cool-transcoder: {e}")

        blob_data = payload.get("blob")
        if not input_url and blob_data:
            input_url = blob_data.get("data") if isinstance(blob_data, dict) else (blob_data if isinstance(blob_data, str) else None)
        return input_url, input_fd

    def _create_response_blob(self, pipe_read: int, mime_type: str, title: str) -> int:
        if not self.xintent_client or not hasattr(self.xintent_client, "blob_create"):
            return 0
        try:
            blob_spec = {
                "xblobType": "ReadableStream",
                "type": mime_type,
                "name": title,
                "data": f"/proc/{os.getpid()}/fd/{pipe_read}",
                "_dataType": "fd-rights",
                "contentEncoding": "fd-rights"
            }
            resp_data_blob = self.xintent_client.blob_create(blob_spec)
            logger.info(f"Created ReadableStream response dataBlob {hex(resp_data_blob)} for live stream pipe fd {pipe_read} ('/proc/{os.getpid()}/fd/{pipe_read}')")
            return resp_data_blob
        except Exception as e:
            logger.error(f"Error creating response blob for live stream pipe fd {pipe_read}: {e}")
            return 0

    def _dispatch_x11_response(self, response: dict, tx_id: int, sender_win: int, channel_id: int, resp_data_blob: int) -> None:
        if not self.xintent_client or not (sender_win or channel_id):
            return
        try:
            self.xintent_client.send_event(
                target_win_id=sender_win or self.xintent_client.get_router_win_id(),
                payload=response,
                tx_id=tx_id,
                channel=channel_id,
                control_word=2,
                data_blob=resp_data_blob
            )
            logger.info(f"Sent media.TranscodeResponseV0 over X11 IPC (channel {channel_id}, dataBlob: {hex(resp_data_blob)})")
        except Exception as e:
            logger.error(f"Error sending X11 transcode response: {e}")

    async def handle_transcode_intent(self, payload: dict) -> dict:
        tx_id, sender_win, channel_id, input_url, accept_spec, title, data_blob_id = _extract_transcode_params(payload)
        input_url, input_fd = self._resolve_input_source(payload, input_url, data_blob_id)

        if not input_url and input_fd is None:
            response = {
                "event": "media.TranscodeResponseV0",
                "txId": tx_id,
                "status": "error",
                "errorMessage": "Missing input URL or blob"
            }
            self._dispatch_x11_response(response, tx_id, sender_win, channel_id, 0)
            return response

        session = self.create_session(input_url, accept_spec, title)
        pipe_read = spawn_ffmpeg_pipe_pipeline(input_url, session.ffmpeg_flags, input_fd)
        await asyncio.sleep(0.3)

        resp_data_blob = self._create_response_blob(pipe_read, session.mime_type, title)
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
        self._dispatch_x11_response(response, tx_id, sender_win, channel_id, resp_data_blob)
        return response

    def setup_x11(self):
        if not HAS_XINTENT_XLIB or not self.display_name:
            return

        try:
            client = XIntentXlibClient(app_id="cool-transcoder", display_name=self.display_name)
            self.xintent_client = client
            client.register_matchbox_toml(self.build_manifest())

            def handle_x11_transcode(payload):
                logger.info("[X11 IPC] Received media.Transcode intent")
                asyncio.get_event_loop().create_task(self.handle_transcode_intent(payload))

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
