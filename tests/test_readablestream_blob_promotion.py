#!/usr/bin/env python3
"""
Test: ReadableStream -> Blob Promotion & DLNA Bridge MPEG-TS Streaming
======================================================================
Runs inside an isolated Xvfb display and verifies:
1. cool-transcoder identifies its transcoded output as a ReadableStream (video/mpeg).
2. dlna-bridge (or a receiver opting into ReadableStream via accept_readable_stream=True)
   immediately receives the live ReadableStream without waiting for StreamCompleted.
3. A receiver requesting a Blob (accept_readable_stream=False) causes the blob host
   (cool-service-lighter) to wait for the StreamCompleted event, promote the
   ReadableStream to a Blob, and hand over the completed Blob with final size.
4. dlna-bridge logs file_size every time it responds to an HTTP request for part of the file,
   and supports HTTP 206 Partial Content byte-range seeking on the MPEG-TS stream.
"""

import asyncio
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT_DIR, "x11-promises"))
sys.path.insert(0, os.path.join(ROOT_DIR, "cool-transcoder"))
sys.path.insert(0, os.path.join(ROOT_DIR, "dlna-bridge"))

from xintent_xlib import XIntentXlibClient
from dlna_media_manager import DLNAMediaManager, probe_media_codecs
from cool_transcoder import CoolTranscoderServer


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def generate_test_xvid_avi(output_path: str, duration_sec: int = 3) -> bool:
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"testsrc=duration={duration_sec}:size=320x240:rate=15",
        "-f", "lavfi", "-i", f"sine=frequency=1000:duration={duration_sec}",
        "-c:v", "mpeg4", "-vtag", "XVID",
        "-c:a", "mp3",
        output_path,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    return res.returncode == 0 and os.path.exists(output_path)


async def run_async_checks(display: str, http_port: int):
    print(f"--- Connecting XIntentXlibClient on DISPLAY={display} ---")
    client = XIntentXlibClient(app_id="test-readablestream-promotion", display_name=display)
    router_win = client.wait_for_router(timeout_sec=5.0)
    assert router_win > 0, f"Expected valid router window ID, got {router_win}"

    sock_path = client.get_xblob_socket_path()
    print(f"Resolved XBLOB_SOCKET_PATH: {sock_path}")
    assert sock_path and os.path.exists(sock_path), f"Expected XBLOB_SOCKET_PATH to exist, got {sock_path}"

    # 1. Test BufferedReadableStream opt-in vs Blob wait-for-StreamCompleted promotion
    print("\n=== TEST 1: BufferedReadableStream Opt-In vs Blob Promotion on StreamCompleted ===")
    r_fd, w_fd = os.pipe()
    stream_blob_id = client.blob_create({
        "xblobType": "BufferedReadableStream",
        "type": 'video/mpeg; codecs="h264, aac"',
        "name": "live_test.ts",
        "data": f"/proc/{os.getpid()}/fd/{r_fd}",
        "_dataType": "fd-rights",
        "contentEncoding": "fd-rights",
    })
    os.close(r_fd)
    assert stream_blob_id > 0, "Expected non-zero blob ID for BufferedReadableStream"
    print(f"Created BufferedReadableStream XBlob: {hex(stream_blob_id)}")

    # Write initial chunk to the pipe, keep write-end open so StreamCompleted has NOT fired yet
    chunk_1 = b"MPEGTS_CHUNK_1_" * 100
    chunk_2 = b"MPEGTS_CHUNK_2_" * 100
    os.write(w_fd, chunk_1)
    await asyncio.sleep(0.05)

    # Receiver A (like dlna-bridge) opts in to BufferedReadableStream -> must return immediately!
    t0 = time.monotonic()
    stream_res = client.blob_read(stream_blob_id, receive_fd=True, accept_buffered_readable_stream=True)
    dt_opt_in = time.monotonic() - t0
    print(
        f"Receiver A (accept_buffered_readable_stream=True) returned in {dt_opt_in * 1000:.1f}ms: "
        f"xblobType={stream_res.get('xblobType')}, _dataType={stream_res.get('_dataType')}, fd={stream_res.get('data')}"
    )
    assert stream_res.get("xblobType") == "BufferedReadableStream", f"Expected BufferedReadableStream, got {stream_res.get('xblobType')}"
    assert dt_opt_in < 0.3, f"Expected immediate return (<0.3s) for BufferedReadableStream opt-in, took {dt_opt_in:.2f}s"
    assert isinstance(stream_res.get("data"), int), "Expected open file descriptor for BufferedReadableStream"

    # Schedule writing chunk_2 and closing pipe after 400ms (triggering StreamCompleted)
    async def finish_producer():
        await asyncio.sleep(0.4)
        os.write(w_fd, chunk_2)
        os.close(w_fd)

    producer_task = asyncio.create_task(finish_producer())

    # Receiver B wants a Blob (accept_buffered_readable_stream=False) -> blob host must wait for StreamCompleted,
    # promote BufferedReadableStream -> Blob, and return the completed Blob!
    loop = asyncio.get_event_loop()
    t1 = time.monotonic()
    blob_res = await loop.run_in_executor(
        None,
        lambda: client.blob_read(stream_blob_id, receive_fd=False, accept_buffered_readable_stream=False),
    )
    dt_blob = time.monotonic() - t1
    await producer_task

    expected_total = len(chunk_1) + len(chunk_2)
    print(
        f"Receiver B (accept_buffered_readable_stream=False) returned after StreamCompleted in {dt_blob * 1000:.1f}ms: "
        f"xblobType={blob_res.get('xblobType')}, size={blob_res.get('size')}, data_len={len(blob_res.get('data', b''))}"
    )
    assert dt_blob >= 0.3, f"Expected Receiver B to wait for StreamCompleted (>=0.3s), took {dt_blob:.2f}s"
    assert blob_res.get("xblobType") == "Blob", f"Expected promoted xblobType 'Blob', got {blob_res.get('xblobType')}"
    assert blob_res.get("size") == expected_total, f"Expected promoted Blob size {expected_total}, got {blob_res.get('size')}"
    assert blob_res.get("data") == (chunk_1 + chunk_2), "Promoted Blob data mismatch"

    # Also verify Receiver A's storage-backed FD grew to the full size!
    final_fd_size = os.fstat(stream_res["data"]).st_size
    assert final_fd_size == expected_total, f"Expected Receiver A's FD to have grown to {expected_total}, got {final_fd_size}"
    os.close(stream_res["data"])

    # 1b. Test actual WHATWG ReadableStream defined as a pipe (unbuffered from 0, does not promote to Blob)
    print("\n=== TEST 1b: WHATWG ReadableStream Defined as a Pipe ===")
    pipe_r, pipe_w = os.pipe()
    pipe_blob_id = client.blob_create({
        "xblobType": "ReadableStream",
        "type": "application/octet-stream",
        "name": "whatwg_pipe.bin",
        "data": f"/proc/{os.getpid()}/fd/{pipe_r}",
        "_dataType": "fd-rights",
        "contentEncoding": "fd-rights",
    })
    os.close(pipe_r)
    assert pipe_blob_id > 0, "Expected non-zero blob ID for ReadableStream pipe"
    print(f"Created ReadableStream (pipe) XBlob: {hex(pipe_blob_id)}")

    pipe_chunk_1 = b"WHATWG_PIPE_CHUNK_1"
    pipe_chunk_2 = b"WHATWG_PIPE_CHUNK_2"
    os.write(pipe_w, pipe_chunk_1)

    pipe_res_1 = client.blob_read(pipe_blob_id, receive_fd=True, accept_readable_stream=True)
    assert pipe_res_1.get("xblobType") == "ReadableStream", f"Expected ReadableStream, got {pipe_res_1.get('xblobType')}"
    pipe_fd_1 = pipe_res_1["data"]
    import stat as _stat
    assert _stat.S_ISFIFO(os.fstat(pipe_fd_1).st_mode), "Expected ReadableStream FD to be a FIFO/pipe"
    read_1 = os.read(pipe_fd_1, len(pipe_chunk_1))
    assert read_1 == pipe_chunk_1, f"Expected {pipe_chunk_1!r}, got {read_1!r}"

    os.write(pipe_w, pipe_chunk_2)
    os.close(pipe_w)

    # Because ReadableStream is a pipe (not buffered from 0), reading again only receives chunk 2
    pipe_res_2 = client.blob_read(pipe_blob_id, receive_fd=True, accept_readable_stream=True)
    assert pipe_res_2.get("xblobType") == "ReadableStream", f"Expected ReadableStream to stay ReadableStream, got {pipe_res_2.get('xblobType')}"
    pipe_fd_2 = pipe_res_2["data"]
    read_2 = os.read(pipe_fd_2, 1024)
    assert read_2 == pipe_chunk_2, f"Expected pipe to yield only unconsumed {pipe_chunk_2!r}, got {read_2!r}"
    os.close(pipe_fd_1)
    os.close(pipe_fd_2)
    print("Verified WHATWG ReadableStream is a true pipe (unbuffered from 0, does not promote to Blob).")

    # 2. Test End-to-End CoolTranscoder -> ReadableStream XBlob -> DLNA Bridge HTTP Range Streaming
    print("\n=== TEST 2: CoolTranscoder ReadableStream MPEG-TS -> DLNA Bridge Seekable HTTP Streaming ===")
    tmp_avi = tempfile.NamedTemporaryFile(suffix=".avi", delete=False)
    tmp_avi.close()
    avi_path = tmp_avi.name

    try:
        assert generate_test_xvid_avi(avi_path, duration_sec=2), "Failed to generate test XviD AVI"
        input_fd = os.open(avi_path, os.O_RDONLY)
        input_blob_id = client.blob_create(input_fd)
        os.close(input_fd)

        transcoder_port = _find_free_port()
        dlna_port = _find_free_port()

        transcoder = CoolTranscoderServer(http_port=transcoder_port, display_name=display)
        transcoder.xintent_client = client
        transcoder.local_ip = "127.0.0.1"

        dlna_mgr = DLNAMediaManager(http_port=dlna_port, mock_device=True)
        dlna_mgr.local_ip = "127.0.0.1"
        dev = dlna_mgr.register_mock_device()
        media_server = await asyncio.start_server(dlna_mgr.handle_http_media_request, "127.0.0.1", dlna_port)

        received_progress_events = []

        def on_ui_progress(frame):
            payload_obj = frame.get("payload", frame) if isinstance(frame, dict) else {}
            received_progress_events.append(payload_obj)
            print(f"[Channel {frame.get('channel')}] Received ui.Progress: {payload_obj}")

        client.register_handler("ui.Progress", on_ui_progress)

        async def pump_x11():
            while True:
                client.process_events_once()
                await asyncio.sleep(0.01)

        pump_task = asyncio.create_task(pump_x11())

        transcode_resp = await transcoder.handle_transcode_intent({
            "intent": "media.Transcode",
            "app": "cool-transcoder",
            "sender": client.client_win.id,
            "channel": 424242,
            "data_blob": input_blob_id,
            "accept": dev.accept_header_val,
            "title": "Simpsons Test Episode.avi",
            "Prefer": "return=minimal",
        })
        await asyncio.sleep(0.1)
        pump_task.cancel()

        assert transcode_resp.get("status") == "ok", f"Transcode failed: {transcode_resp}"
        assert "video/mpeg" in transcode_resp.get("mimeType", ""), f"Expected video/mpeg MIME, got {transcode_resp.get('mimeType')}"
        assert "dataBlob" not in transcode_resp and "blobId" not in transcode_resp, "XBlob ID must not be in JSON payload body"
        out_blob_id = transcode_resp.get("data_blob")
        assert out_blob_id and out_blob_id > 0, f"Expected data_blob slot in transcode response for Prefer: return=minimal, got {transcode_resp}"
        print(f"Total ui.Progress events received before media.TranscodeResponseV0: {len(received_progress_events)} -> {[e.get('percent') for e in received_progress_events]}")
        assert len(received_progress_events) >= 1, "Expected at least one ui.Progress event to be emitted on Prefer: return=minimal"
        assert received_progress_events[-1].get("percent") == 1.0, f"Expected final ui.Progress percent to be 1.0, got {received_progress_events[-1]}"

        # Workflow A: dlna-bridge opts in to ReadableStream -> continuous live streaming (Accept-Ranges: none, DLNA.ORG_OP=00)
        live_raw_blob = client.blob_read(out_blob_id, receive_fd=True, accept_readable_stream=True)
        from xintent_bridge import ensure_readable_fd, is_readable_stream_blob
        live_fd, live_mime, _ = ensure_readable_fd(live_raw_blob)
        live_url = dlna_mgr.host_readable_fd(live_fd, live_mime, "live_stream.ts", is_live_stream=True)

        def fetch_live_stream():
            req = urllib.request.Request(live_url)
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, dict(resp.headers), resp.read()

        live_status, live_headers, live_bytes = await loop.run_in_executor(None, fetch_live_stream)
        print(f"Workflow A (ReadableStream continuous live): status={live_status}, Accept-Ranges={live_headers.get('Accept-Ranges')}, bytes={len(live_bytes)}")
        assert live_status == 200
        assert live_headers.get("Accept-Ranges") == "none"
        assert "DLNA.ORG_OP=00" in (live_headers.get("contentFeatures.dlna.org") or "")
        assert len(live_bytes) > 5000

        # Workflow B: UI-driven transcode-then-play as promoted Blob -> seekable byte-range streaming (Accept-Ranges: bytes, DLNA.ORG_OP=01)
        promoted_raw_blob = client.blob_read(out_blob_id, receive_fd=True, accept_readable_stream=False)
        assert not is_readable_stream_blob(promoted_raw_blob), "Expected promoted Blob after StreamCompleted"
        blob_fd, blob_mime, _ = ensure_readable_fd(promoted_raw_blob)
        blob_url = dlna_mgr.host_readable_fd(blob_fd, blob_mime, "promoted_blob.ts", is_live_stream=False)

        def fetch_blob_range():
            req = urllib.request.Request(blob_url, headers={"Range": "bytes=0-4095"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, dict(resp.headers), resp.read()

        range_status, range_headers, range_bytes = await loop.run_in_executor(None, fetch_blob_range)
        print(f"Workflow B (Promoted Blob range seek): status={range_status}, Accept-Ranges={range_headers.get('Accept-Ranges')}, bytes={len(range_bytes)}")
        assert range_status == 206
        assert range_headers.get("Accept-Ranges") == "bytes"
        assert "DLNA.ORG_OP=01" in (range_headers.get("contentFeatures.dlna.org") or "")
        assert len(range_bytes) == 4096

        os.close(live_fd)
        os.close(blob_fd)
        media_server.close()
    finally:
        if os.path.exists(avi_path):
            os.unlink(avi_path)

    print("\n[VERIFICATION PASSED] ReadableStream -> Blob promotion and MPEG-TS DLNA pipeline succeeded!")
    return True


def main():
    test_port = str(_find_free_port())
    if not os.environ.get("XVFB_RUNNING") and shutil.which("xvfb-run"):
        print("--- Relaunching test inside isolated Xvfb server via xvfb-run ---")
        env = dict(
            os.environ,
            XVFB_RUNNING="1",
            PYTHONUNBUFFERED="1",
            PORT=test_port,
            XINTENT_PORT=test_port,
        )
        cmd = ["xvfb-run", "-a", "uv", "run", "--with", "websockets", "--with", "python-xlib", "python3"] + sys.argv
        res = subprocess.run(cmd, env=env)
        sys.exit(res.returncode)

    display = os.environ.get("DISPLAY", ":99")
    http_port = int(os.environ.get("PORT", test_port))
    sock_path = f"/tmp/xblob-test-{os.getpid()}.sock"
    env = dict(
        os.environ,
        DISPLAY=display,
        PORT=str(http_port),
        XINTENT_PORT=str(http_port),
        XBLOB_SOCKET_PATH=sock_path,
        PYTHONUNBUFFERED="1",
    )
    os.environ["XBLOB_SOCKET_PATH"] = sock_path

    print(f"--- Starting cool-service-lighter supervisor on DISPLAY={display}, PORT={http_port} ---")
    supervisor_proc = subprocess.Popen(
        ["bun", os.path.join(ROOT_DIR, "cool-service-lighter", "index.js")],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    time.sleep(2.5)

    try:
        ok = asyncio.run(run_async_checks(display, http_port))
        sys.exit(0 if ok else 1)
    finally:
        supervisor_proc.terminate()
        try:
            supervisor_proc.wait(timeout=3)
        except Exception:
            supervisor_proc.kill()
        if os.path.exists(sock_path):
            try:
                os.unlink(sock_path)
            except Exception:
                pass


if __name__ == "__main__":
    main()
