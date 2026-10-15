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


class TranscodeSession:
    def __init__(self, session_id: str, input_url: str, accept_spec: str, title: str = "Transcoded Stream"):
        self.session_id = session_id
        self.input_url = input_url
        self.accept_spec = accept_spec
        self.title = title
        self.mime_type, self.ffmpeg_flags = self._select_ffmpeg_pipeline(accept_spec)

    def _select_ffmpeg_pipeline(self, accept: str) -> Tuple[str, List[str]]:
        accept_lower = accept.lower()

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
        tx_id = payload.get("txId") or payload.get("id") or 0
        input_url = payload.get("url") or payload.get("uri")
        accept_spec = payload.get("accept") or payload.get("targetCodecs") or "video/webm; codecs=\"vp8\""
        title = payload.get("title") or "Transcoded Stream"

        blob_data = payload.get("blob")
        if not input_url and blob_data:
            if isinstance(blob_data, dict):
                input_url = blob_data.get("data")
            elif isinstance(blob_data, str):
                input_url = blob_data

        if not input_url:
            return {
                "event": "media.TranscodeResponseV0",
                "txId": tx_id,
                "status": "error",
                "errorMessage": "Missing input URL or blob"
            }

        session = self.create_session(input_url, accept_spec, title)
        stream_url = f"http://{self.local_ip}:{self.http_port}/stream/{session.session_id}"

        response = {
            "event": "media.TranscodeResponseV0",
            "txId": tx_id,
            "status": "ok",
            "url": stream_url,
            "mimeType": session.mime_type,
            "title": title
        }
        logger.info(f"Transcode prepared -> Stream URL: {stream_url}")
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
                fut = asyncio.run_coroutine_threadsafe(self.handle_transcode_intent(payload), loop)
                return fut.result(timeout=5.0)

            client.register_handler("media.Transcode", handle_x11_transcode)
            logger.info(f"Registered cool-transcoder on X11 Window {hex(client.client_win.id)} with MATCHBOX_TOML")

        except Exception as e:
            logger.warning(f"Could not initialize X11 client: {e}")

    async def ws_client_loop(self):
        while True:
            try:
                logger.info(f"Connecting to XIntent WebSocket server at {self.server_ws_url}...")
                async with websockets.connect(self.server_ws_url) as ws:
                    self.ws = ws
                    logger.info("Connected to XIntent WebSocket server.")

                    # Advertise cool-transcoder
                    advertise_msg = {
                        "event": "bridge.Advertise",
                        "app": "cool-transcoder",
                        "manifest": self.build_manifest()
                    }
                    await ws.send(json.dumps(advertise_msg))
                    logger.info("Advertised cool-transcoder over WebSocket")

                    async for msg in ws:
                        try:
                            data = json.loads(msg)
                            intent_name = data.get("intent") or data.get("event")
                            target_app = data.get("app") or data.get("targetApp")

                            if intent_name == "media.Transcode" or target_app == "cool-transcoder":
                                res = await self.handle_transcode_intent(data)
                                await ws.send(json.dumps(res))

                        except json.JSONDecodeError:
                            pass
                        except Exception as ex:
                            logger.error(f"Error handling WS transcode message: {ex}")

            except (websockets.ConnectionClosed, OSError) as e:
                logger.warning(f"WebSocket disconnected ({e}). Reconnecting in 5 seconds...")
                self.ws = None
                await asyncio.sleep(5)
            except Exception as e:
                logger.error(f"Unexpected WebSocket loop error: {e}. Reconnecting in 5 seconds...")
                self.ws = None
                await asyncio.sleep(5)

    async def run(self):
        self.setup_x11()
        http_server = await asyncio.start_server(self.handle_http_connection, "0.0.0.0", self.http_port)
        logger.info(f"Cool Transcoder HTTP Streaming Server running on http://{self.local_ip}:{self.http_port}")

        await asyncio.gather(
            http_server.serve_forever(),
            self.ws_client_loop()
        )


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
