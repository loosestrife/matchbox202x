#!/usr/bin/env python3
"""
DLNA HTTP Media Hosting & Streaming Helpers
===========================================
Handles pipe-to-seekable-file pooling, HTTP Range parsing, live transcode
pread streaming, and serving hosted media files to DLNA renderers.
"""

import asyncio
import logging
import os
import stat
import tempfile
import threading
from typing import Dict, Optional, Tuple

logger = logging.getLogger("dlna_media_manager")


def is_fd_pipe_or_socket(fd: int) -> bool:
    try:
        st_mode = os.fstat(fd).st_mode
        return bool(stat.S_ISFIFO(st_mode) or stat.S_ISSOCK(st_mode))
    except Exception:
        return False


def _pool_pipe_worker(src_fd: int, dst_fd: int) -> None:
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


def pool_pipe_to_seekable_fd(fd: int, file_name: str) -> int:
    if not is_fd_pipe_or_socket(fd):
        return fd
    try:
        tmp_file = tempfile.NamedTemporaryFile(delete=True)
        pool_fd = os.dup(tmp_file.fileno())
        tmp_file.close()

        t = threading.Thread(target=_pool_pipe_worker, args=(fd, pool_fd), daemon=True)
        t.start()
        logger.info(f"Started background thread pooling pipe fd {fd} -> seekable anonymous fd {pool_fd} for '{file_name}'")
        return pool_fd
    except Exception as e:
        logger.error(f"Failed to pool pipe fd {fd} to anonymous file: {e}")
        return fd


async def _read_http_request(reader: asyncio.StreamReader) -> Optional[Tuple[str, str, Dict[str, str]]]:
    request_line = await reader.readline()
    if not request_line:
        return None

    parts = request_line.decode("utf-8", errors="ignore").strip().split(" ")
    if len(parts) < 2:
        return None

    method, path_str = parts[0], parts[1]
    headers: Dict[str, str] = {}
    while True:
        h_line = await reader.readline()
        if not h_line or h_line in (b"\r\n", b"\n"):
            break
        h_str = h_line.decode("utf-8", errors="ignore").strip()
        if ":" in h_str:
            k, v = h_str.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return method, path_str, headers


def _build_dlna_features(clean_mime: str, seekable: bool) -> str:
    op = "01" if seekable else "00"
    features = f"DLNA.ORG_OP={op};DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"
    if clean_mime == "video/mp4":
        return "DLNA.ORG_PN=AVC_MP4_MP_SD_AAC;" + features
    return features


async def _stream_pipe_fd(val: int, clean_mime: str, filename: str, method: str, writer: asyncio.StreamWriter) -> None:
    dlna_features = _build_dlna_features(clean_mime, seekable=False)
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


def _parse_range_header(range_header: Optional[str], file_size: int) -> Tuple[int, int, bool]:
    start_byte = 0
    end_byte = max(0, file_size - 1)
    if not range_header or not range_header.startswith("bytes="):
        return start_byte, end_byte, True

    is_open_ended = False
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

    if start_byte >= file_size and file_size > 0:
        start_byte = max(0, file_size - 1)
    return start_byte, end_byte, is_open_ended


async def _read_pread_chunk_with_wait(val: int, chunk_max: int, offset: int, is_open_ended: bool, stuck_count: int) -> Tuple[bytes, int]:
    chunk = os.pread(val, chunk_max, offset)
    if chunk or not is_open_ended:
        return chunk, 0
    await asyncio.sleep(0.1)
    chunk = os.pread(val, chunk_max, offset)
    if chunk:
        return chunk, 0
    return b"", stuck_count + 1


async def _stream_seekable_fd_chunks(val: int, start_byte: int, content_len: int, is_open_ended: bool, writer: asyncio.StreamWriter) -> int:
    offset = start_byte
    bytes_sent = 0
    stuck_count = 0
    while is_open_ended or (bytes_sent < content_len):
        chunk_max = 65536 if is_open_ended else min(65536, content_len - bytes_sent)
        chunk, stuck_count = await _read_pread_chunk_with_wait(val, chunk_max, offset, is_open_ended, stuck_count)
        if not chunk:
            if is_open_ended and stuck_count <= 30:
                continue
            break
        writer.write(chunk)
        await writer.drain()
        offset += len(chunk)
        bytes_sent += len(chunk)
    return bytes_sent


async def _stream_seekable_fd(val: int, clean_mime: str, filename: str, method: str, headers: Dict[str, str], writer: asyncio.StreamWriter) -> None:
    for _ in range(30):
        if os.fstat(val).st_size >= 1024:
            break
        await asyncio.sleep(0.05)

    file_size = os.fstat(val).st_size
    range_header = headers.get("range")
    start_byte, end_byte, is_open_ended = _parse_range_header(range_header, file_size)
    content_len = max(0, end_byte - start_byte + 1)

    status_line = "HTTP/1.1 206 Partial Content" if range_header else "HTTP/1.1 200 OK"
    dlna_features = _build_dlna_features(clean_mime, seekable=True)

    res_headers = [
        status_line,
        f"Content-Type: {clean_mime}",
        f"Content-Length: {content_len}",
        "Accept-Ranges: bytes",
        f"contentFeatures.dlna.org: {dlna_features}",
        "transferMode.dlna.org: Streaming",
    ]
    if range_header:
        res_headers.append(f"Content-Range: bytes {start_byte}-{end_byte}/{file_size}")
    res_headers.extend([
        f'Content-Disposition: inline; filename="{filename}"',
        "Connection: close",
        "\r\n"
    ])

    writer.write("\r\n".join(res_headers).encode("utf-8"))
    await writer.drain()

    if method.upper() == "HEAD":
        return

    bytes_sent = await _stream_seekable_fd_chunks(val, start_byte, content_len, is_open_ended, writer)
    fd_size = os.fstat(val).st_size
    asked_str = f"range {start_byte}-{end_byte} ({content_len} bytes)" if not is_open_ended else f"range {start_byte}-EOF (open-ended)"
    logger.info(f"Streamed '{filename}' from fd {val} -> sent: {bytes_sent} bytes, asked: {asked_str}, fd_size: {fd_size} bytes")


async def _stream_fd_item(val: int, mime_type: str, filename: str, method: str, headers: Dict[str, str], writer: asyncio.StreamWriter) -> None:
    try:
        clean_mime = mime_type.split(";")[0].strip().lower()
        if is_fd_pipe_or_socket(val):
            await _stream_pipe_fd(val, clean_mime, filename, method, writer)
        else:
            await _stream_seekable_fd(val, clean_mime, filename, method, headers, writer)
    except Exception as e:
        logger.error(f"Error streaming file descriptor {val}: {e}")
    finally:
        writer.close()


async def _stream_file_path_item(file_path: str, mime_type: str, filename: str, method: str, writer: asyncio.StreamWriter) -> None:
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

        if method.upper() != "HEAD":
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


async def _stream_bytes_item(val: object, mime_type: str, filename: str, writer: asyncio.StreamWriter) -> None:
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


async def _send_not_found(writer: asyncio.StreamWriter, with_body: bool = False) -> None:
    if with_body:
        res = "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nNot Found"
    else:
        res = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
    writer.write(res.encode("utf-8"))
    await writer.drain()
    writer.close()


async def serve_http_media_request(hosted_files: Dict[str, Tuple[object, str, str]], reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        parsed = await _read_http_request(reader)
        if not parsed:
            writer.close()
            return

        method, path_str, headers = parsed
        peer = writer.get_extra_info("peername")
        logger.info(f"[HTTP Media Request] {method} {path_str} HTTP/1.1 from {peer[0] if peer else 'unknown'}")

        if not path_str.startswith("/files/"):
            await _send_not_found(writer, with_body=True)
            return

        file_id = path_str.removeprefix("/files/").split("?")[0]
        item = hosted_files.get(file_id)
        if not item:
            await _send_not_found(writer, with_body=False)
            return

        val, mime_type, filename = item
        if isinstance(val, int):
            await _stream_fd_item(val, mime_type, filename, method, headers, writer)
        elif isinstance(val, str) and (os.path.isfile(val) or val.startswith("/proc/")):
            await _stream_file_path_item(val, mime_type, filename, method, writer)
        else:
            await _stream_bytes_item(val, mime_type, filename, writer)
    except Exception as ex:
        logger.debug(f"HTTP Media Request error: {ex}")
        try:
            writer.close()
        except Exception:
            pass
