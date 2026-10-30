#!/usr/bin/env python3
"""
xintent_blob_http.py - UNIX domain socket and HTTP transport helpers for XBlob PUT/GET.
"""

import array
import json
import logging
import os
import socket
import stat
import struct
import sys
import urllib.request

from xintent_at_rest import parse_xblob_at_rest

logger = logging.getLogger("xintent_xlib")

REST_HEADER_MAP = (
    ("content-type", "Content-Type"),
    ("content-length", "Content-Length"),
    ("content-encoding", "Content-Encoding"),
    ("content-disposition", "Content-Disposition"),
    ("x-xblob-type", "X-XBlob-Type"),
)


def _serialize_dict_data_field(blob_data: dict, d) -> bytes:
    if isinstance(d, (bytes, bytearray)):
        return bytes(d)
    if isinstance(d, str):
        return d.encode("utf-8")
    if d is not None:
        return json.dumps(d).encode("utf-8")
    return json.dumps(blob_data).encode("utf-8")


def _normalize_fd_rights_dict(blob_data: dict) -> dict:
    d = blob_data.get("data")
    updated = dict(blob_data)
    updated["_dataType"] = "file-path"
    updated["contentEncoding"] = "file-path"
    if isinstance(d, int) and d >= 0:
        updated["data"] = f"/proc/{os.getpid()}/fd/{d}"
        return updated
    if isinstance(d, str):
        return updated
    msg = f"XBlob fd-rights requires an integer file descriptor or file path string, got '{type(d).__name__}': {d}"
    logger.error(msg)
    raise ValueError(msg)


def _read_local_fd_or_path_bytes(d):
    target_path = None
    if isinstance(d, int) and d >= 0:
        target_path = f"/proc/{os.getpid()}/fd/{d}"
    elif isinstance(d, str) and (d.startswith("/proc/") or os.path.exists(d)):
        target_path = d
    if target_path:
        try:
            with open(target_path, "rb") as f:
                return f.read()
        except Exception:
            pass
    return None


def _resolve_dict_content_encoding(blob_data: dict, allow_fd_path: bool):
    dt = blob_data.get("_dataType")
    ce = blob_data.get("contentEncoding")
    if dt in ("fd-rights", "file-path") or ce in ("fd-rights", "file-path"):
        if allow_fd_path:
            return "file-path", _normalize_fd_rights_dict(blob_data)
        raw_bytes = _read_local_fd_or_path_bytes(blob_data.get("data"))
        updated = dict(blob_data)
        if raw_bytes is not None:
            updated["data"] = raw_bytes
            updated["_dataType"] = "binary"
        updated["contentEncoding"] = "identity"
        return "identity", updated
    if dt == "base64" or ce == "base64":
        return "base64", blob_data
    return (ce or "identity"), blob_data


def _prepare_dict_put_payload(blob_data: dict, allow_fd_path: bool):
    d = blob_data.get("data")
    default_mime = "application/octet-stream" if isinstance(d, (bytes, bytearray)) else "application/json"
    mime_type = blob_data.get("type") or default_mime
    content_enc, updated_dict = _resolve_dict_content_encoding(blob_data, allow_fd_path)
    if content_enc == "file-path" and allow_fd_path:
        body_bytes = json.dumps(updated_dict).encode("utf-8")
    else:
        body_bytes = _serialize_dict_data_field(updated_dict, updated_dict.get("data"))
    return body_bytes, mime_type, content_enc, updated_dict.get("xblobType", "Blob")


def _prepare_primitive_put_payload(blob_data):
    if isinstance(blob_data, (bytes, bytearray)):
        return bytes(blob_data), "application/octet-stream", "identity", "Blob"
    if isinstance(blob_data, str):
        return blob_data.encode("utf-8"), "text/plain", "identity", "Blob"
    return json.dumps(blob_data).encode("utf-8"), "application/json", "identity", "Blob"


def _prepare_put_payload(blob_data, allow_fd_path: bool):
    if allow_fd_path and isinstance(blob_data, int) and blob_data >= 0:
        body = f"/proc/{os.getpid()}/fd/{blob_data}".encode("utf-8")
        return body, "application/octet-stream", "file-path", "Blob"
    if isinstance(blob_data, dict):
        return _prepare_dict_put_payload(blob_data, allow_fd_path)
    return _prepare_primitive_put_payload(blob_data)


def _build_origin_and_sender(sender_win):
    hostname = socket.gethostname()
    display = (os.environ.get("DISPLAY") or ":0").replace(":", "")
    wid_hex = hex(sender_win) if sender_win else "0x0"
    return f"{hostname}:{display}/{wid_hex}", wid_hex


def _parse_blob_id_int(raw_blob_id):
    if not raw_blob_id:
        return None
    if isinstance(raw_blob_id, int):
        return raw_blob_id
    x_str = str(raw_blob_id).strip()
    if x_str.startswith("0x") or x_str.startswith("0X"):
        return int(x_str, 16)
    return int(x_str)


def _extract_blob_id_from_body_str(body_str: str):
    if not body_str:
        return None
    try:
        js = json.loads(body_str)
        return js.get("blobId") or js.get("blob")
    except Exception:
        return None


def _extract_blob_id_from_raw_response(res_data: bytes):
    res_str = res_data.decode("utf-8", errors="replace")
    header_end = res_str.find("\r\n\r\n")
    headers_str = res_str[:header_end] if header_end != -1 else res_str
    body_str = res_str[header_end + 4:] if header_end != -1 else ""

    x_blob_id = None
    for line in headers_str.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            if k.strip().lower() == "x-blob-id":
                x_blob_id = v.strip()
                break

    if not x_blob_id:
        x_blob_id = _extract_blob_id_from_body_str(body_str)
    return _parse_blob_id_int(x_blob_id)


def _is_http_response_complete(chunks: list) -> bool:
    data = b"".join(chunks)
    sep = data.find(b"\r\n\r\n")
    if sep == -1:
        return False
    header_text = data[:sep].decode("latin1", errors="replace")
    body_len = len(data) - (sep + 4)
    for line in header_text.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            if k.strip().lower() == "content-length":
                try:
                    return body_len >= int(v.strip())
                except ValueError:
                    return False
    return False


def _send_and_recv_unix_socket(socket_path: str, req_bytes: bytes, fd_to_pass=None) -> bytes:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(3.0)
    sock.connect(socket_path)
    if fd_to_pass is not None:
        ancillary = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd_to_pass]).tobytes())]
        sock.sendmsg([req_bytes], ancillary)
    else:
        sock.sendall(req_bytes)

    chunks = []
    while True:
        try:
            chunk = sock.recv(4096)
        except (socket.timeout, TimeoutError):
            if chunks:
                break
            sock.close()
            raise
        if not chunk:
            break
        chunks.append(chunk)
        if _is_http_response_complete(chunks):
            break
    sock.close()
    return b"".join(chunks)


def _http_put_blobs_unix_socket(socket_path: str, blob_data, sender_win=None):
    try:
        body_bytes, mime_type, content_enc, xblob_type = _prepare_put_payload(blob_data, allow_fd_path=True)
        origin, wid_hex = _build_origin_and_sender(sender_win)
        req_lines = [
            "PUT /blobs HTTP/1.1",
            "Host: localhost",
            f"Origin: {origin}",
            f"X-Sender-Win: {wid_hex}",
            f"Content-Type: {mime_type}",
            f"Content-Length: {len(body_bytes)}",
            f"Content-Encoding: {content_enc}",
            f"X-XBlob-Type: {xblob_type}",
            "Accept-Encoding: identity, base64, fd-rights, file-path",
            "Connection: close",
            "",
            "",
        ]
        req_header = "\r\n".join(req_lines).encode("latin1")
        res_data = _send_and_recv_unix_socket(socket_path, req_header + body_bytes)
        return _extract_blob_id_from_raw_response(res_data)
    except Exception as e:
        sys.stderr.write(f"[libxintent.py debug] unix socket PUT /blobs error: {e}\n")
        sys.stderr.flush()
    return None


def _http_put_blobs_http(port: int, blob_data, sender_win=None):
    try:
        body_bytes, mime_type, content_enc, xblob_type = _prepare_put_payload(blob_data, allow_fd_path=False)
        origin, wid_hex = _build_origin_and_sender(sender_win)
        req = urllib.request.Request(
            f"http://localhost:{port}/blobs",
            data=body_bytes,
            method="PUT",
            headers={
                "Content-Type": mime_type,
                "Content-Encoding": content_enc,
                "Accept-Encoding": "identity, base64, fd-rights, file-path",
                "X-XBlob-Type": xblob_type,
                "Origin": origin,
                "X-Sender-Win": wid_hex,
            },
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw_blob_id = resp.headers.get("X-Blob-Id")
            if not raw_blob_id:
                res_body = resp.read().decode("utf-8", errors="replace")
                raw_blob_id = _extract_blob_id_from_body_str(res_body)
            return _parse_blob_id_int(raw_blob_id)
    except Exception as e:
        sys.stderr.write(f"[libxintent.py debug] HTTP PUT /blobs error: {e}\n")
        sys.stderr.flush()
    return None


def _extract_scm_rights_fds(ancdata) -> list:
    fds = []
    if not ancdata:
        return fds
    int_size = struct.calcsize("i")
    for cmsg_level, cmsg_type, cmsg_data in ancdata:
        if cmsg_level == socket.SOL_SOCKET and cmsg_type == socket.SCM_RIGHTS:
            num_fds = len(cmsg_data) // int_size
            if num_fds > 0:
                fds.extend(struct.unpack(f"{num_fds}i", cmsg_data[: num_fds * int_size]))
    return fds


def _recv_one_unix_chunk(sock, ancbufsize: int):
    try:
        msg, ancdata, _, _ = sock.recvmsg(65536, ancbufsize)
        return msg, _extract_scm_rights_fds(ancdata)
    except (AttributeError, OSError, socket.error):
        try:
            return sock.recv(65536), []
        except Exception:
            return b"", []
    except Exception:
        return b"", []


def _recv_unix_get_response(sock):
    chunks = []
    received_fds = []
    ancbufsize = socket.CMSG_LEN(struct.calcsize("i") * 16)
    while True:
        chunk, fds = _recv_one_unix_chunk(sock, ancbufsize)
        if not chunk:
            break
        chunks.append(chunk)
        received_fds.extend(fds)
        if _is_http_response_complete(chunks):
            break
    return b"".join(chunks), received_fds


def _parse_unix_get_http_payload(res_data: bytes, received_fds: list):
    sep_pos = res_data.find(b"\r\n\r\n")
    if sep_pos == -1:
        return None
    header_lines = res_data[:sep_pos].decode("latin1", errors="replace").splitlines()
    status_line = header_lines[0] if header_lines else ""
    if " 200 " not in status_line and " 201 " not in status_line:
        return None

    headers = {}
    for line in header_lines:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()

    rest_headers = [
        f"{canon}: {headers[lower]}"
        for lower, canon in REST_HEADER_MAP
        if lower in headers
    ]
    raw_at_rest = ("\r\n".join(rest_headers) + "\r\n\r\n").encode("latin1") + res_data[sep_pos + 4:]
    return parse_xblob_at_rest(raw_at_rest, received_fds=received_fds)


def _http_get_blob_unix_socket(socket_path: str, blob_hex_id: str, user_agent=None, accept_readable_stream: bool = False):
    try:
        ua = user_agent or f"{socket.gethostname()}:{os.environ.get('DISPLAY') or ''}/0x0 (app=xintent)"
        accept_xblob = "ReadableStream, Blob, File" if accept_readable_stream else "Blob, File"
        req_lines = [
            f"GET /blobs/{blob_hex_id} HTTP/1.1",
            "Host: localhost",
            f"User-Agent: {ua}",
            "Accept: application/json, */*",
            "Accept-Encoding: identity, base64, fd-rights",
            f"X-Accept-XBlob-Type: {accept_xblob}",
            "Connection: close",
            "",
            "",
        ]
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5.0 if accept_readable_stream else 30.0)
        sock.connect(socket_path)
        sock.sendall("\r\n".join(req_lines).encode("latin1"))
        res_data, received_fds = _recv_unix_get_response(sock)
        sock.close()
        return _parse_unix_get_http_payload(res_data, received_fds)
    except Exception as e:
        sys.stderr.write(f"[libxintent.py debug] unix socket GET /blobs/{blob_hex_id} error: {e}\n")
        sys.stderr.flush()
    return None


def _hydrate_blob_file_bytes(blob_data: dict, file_path):
    target_path = None
    if isinstance(file_path, str) and (file_path.startswith("/proc/") or os.path.exists(file_path)):
        target_path = file_path
    elif isinstance(file_path, int) and file_path >= 0:
        target_path = f"/proc/self/fd/{file_path}"

    if target_path:
        try:
            st_mode = os.stat(target_path).st_mode
            if stat.S_ISFIFO(st_mode) or stat.S_ISSOCK(st_mode) or blob_data.get("xblobType") == "ReadableStream":
                blob_data["data"] = os.open(target_path, os.O_RDONLY | os.O_CLOEXEC)
                blob_data["_dataType"] = "fd-rights"
                blob_data["contentEncoding"] = "fd-rights"
                return
            with open(target_path, "rb") as f:
                blob_data["data"] = f.read()
                blob_data["_dataType"] = "binary"
                blob_data["contentEncoding"] = "identity"
        except Exception:
            pass


def post_process_blob_read_data(blob_data: dict, receive_fd: bool, accept_readable_stream: bool = False) -> dict:
    file_path = blob_data.get("data")
    if not receive_fd and not accept_readable_stream and blob_data.get("xblobType") != "ReadableStream":
        _hydrate_blob_file_bytes(blob_data, file_path)
        return blob_data

    if isinstance(file_path, str) and (file_path.startswith("/proc/") or os.path.exists(file_path)):
        try:
            blob_data["data"] = os.open(file_path, os.O_RDONLY | os.O_CLOEXEC)
            blob_data["_dataType"] = "fd-rights"
            blob_data["contentEncoding"] = "fd-rights"
        except Exception:
            pass
    return blob_data
