#!/usr/bin/env python3
"""
xintent_at_rest.py - Serialization and parsing for XBlob at-rest HTTP-like payloads.
"""

import base64
import json
import re

HEADER_LINE_RE = re.compile(
    r"^(Content-Type|X-XBlob-Type|Content-Length|Content-Disposition|Content-Encoding|Content-Transfer-Encoding)\s*:",
    re.IGNORECASE,
)


def _is_blob_wrapper(blob_data) -> bool:
    return isinstance(blob_data, dict) and ("data" in blob_data or "xblobType" in blob_data)


def _serialize_wrapper_data(d, data_type):
    if isinstance(d, (bytes, bytearray)):
        return bytes(d), (data_type or "binary")
    if isinstance(d, (dict, list)):
        return json.dumps(d).encode("utf-8"), (data_type or "json")
    body = str(d).encode("utf-8") if d is not None else b""
    return body, data_type


def _extract_wrapper_at_rest_fields(blob_data: dict) -> dict:
    data_type = blob_data.get("_dataType")
    body_bytes = b""
    if "data" in blob_data:
        body_bytes, data_type = _serialize_wrapper_data(blob_data["data"], data_type)
    return {
        "xblob_type": blob_data.get("xblobType", "Blob"),
        "name": blob_data.get("name"),
        "mime_type": blob_data.get("type"),
        "size": blob_data.get("size"),
        "data_type": data_type,
        "body_bytes": body_bytes,
    }


def _extract_raw_at_rest_fields(blob_data) -> dict:
    if isinstance(blob_data, dict):
        return {
            "xblob_type": "Blob",
            "name": None,
            "mime_type": "application/json",
            "size": None,
            "data_type": "json",
            "body_bytes": json.dumps(blob_data).encode("utf-8"),
        }
    if isinstance(blob_data, (bytes, bytearray)):
        return {
            "xblob_type": "Blob",
            "name": None,
            "mime_type": None,
            "size": None,
            "data_type": "binary",
            "body_bytes": bytes(blob_data),
        }
    return {
        "xblob_type": "Blob",
        "name": None,
        "mime_type": None,
        "size": None,
        "data_type": None,
        "body_bytes": str(blob_data).encode("utf-8"),
    }


def _resolve_at_rest_types(data_type, mime_type):
    resolved_dt = data_type or ("json" if (mime_type and "json" in mime_type) else "text")
    if mime_type:
        return resolved_dt, mime_type
    if resolved_dt == "json":
        return resolved_dt, "application/json"
    if resolved_dt in ("base64", "binary"):
        return resolved_dt, "application/octet-stream"
    return resolved_dt, "text/plain"


def _resolve_at_rest_encoding(blob_data, data_type):
    if isinstance(blob_data, dict):
        enc = blob_data.get("contentEncoding") or blob_data.get("content_encoding")
        if enc:
            return enc
    if data_type in ("fd-rights", "base64"):
        return data_type
    return None


def format_xblob_at_rest(blob_data) -> bytes:
    if blob_data is None:
        blob_data = {}

    fields = (
        _extract_wrapper_at_rest_fields(blob_data)
        if _is_blob_wrapper(blob_data)
        else _extract_raw_at_rest_fields(blob_data)
    )
    data_type, mime_type = _resolve_at_rest_types(fields["data_type"], fields["mime_type"])
    body_bytes = fields["body_bytes"]
    size = fields["size"] if fields["size"] is not None else len(body_bytes)
    xblob_type = fields["xblob_type"]
    name = fields["name"]

    headers = [f"Content-Type: {mime_type}", f"Content-Length: {size}"]
    content_enc = _resolve_at_rest_encoding(blob_data, data_type)
    if content_enc and content_enc != "identity":
        headers.append(f"Content-Encoding: {content_enc}")

    accept_enc = (
        (blob_data.get("acceptEncoding") or blob_data.get("accept_encoding"))
        if isinstance(blob_data, dict)
        else None
    )
    if accept_enc:
        headers.append(f"Accept-Encoding: {accept_enc}")

    if name:
        headers.append(f'Content-Disposition: attachment; filename="{name}"')
        if isinstance(blob_data, dict) and "xblobType" not in blob_data:
            xblob_type = "File"
    headers.append(f"X-XBlob-Type: {xblob_type}")

    header_bytes = ("\r\n".join(headers) + "\r\n\r\n").encode("latin1")
    return header_bytes + body_bytes


def _parse_header_map(header_text: str) -> dict:
    headers = {}
    for line in header_text.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return headers


def _parse_content_length(size_val, fallback_len: int) -> int:
    if not size_val:
        return fallback_len
    try:
        return int(size_val)
    except ValueError:
        return fallback_len


def _extract_filename(content_disp: str):
    if not content_disp:
        return None
    fn_match = re.search(r'filename\s*=\s*"?([^";]+)"?', content_disp, re.IGNORECASE)
    return fn_match.group(1) if fn_match else None


def _split_bytes_headers_and_body(raw_bytes: bytes):
    sep_pos = raw_bytes.find(b"\r\n\r\n")
    if sep_pos != -1:
        return raw_bytes[:sep_pos].decode("latin1", errors="replace"), raw_bytes[sep_pos + 4:]
    lf_pos = raw_bytes.find(b"\n\n")
    if lf_pos != -1:
        return raw_bytes[:lf_pos].decode("latin1", errors="replace"), raw_bytes[lf_pos + 2:]
    return "", raw_bytes


def _strip_chunked_tail(body_sub: bytes) -> bytes:
    tail_idx = body_sub.rfind(b"\r\n0\r\n\r\n")
    if tail_idx != -1:
        return body_sub[:tail_idx]
    if body_sub.endswith(b"\r\n\r\n"):
        return body_sub[:-4]
    return body_sub


def _strip_chunked_framing(body_bytes: bytes) -> bytes:
    if not body_bytes:
        return body_bytes
    try:
        c_idx = body_bytes.find(b"\r\n")
        if c_idx == -1:
            return body_bytes
        first_hex = body_bytes[:c_idx].strip()
        if first_hex and all(c in b"0123456789abcdefABCDEF" for c in first_hex):
            return _strip_chunked_tail(body_bytes[c_idx + 2:])
    except Exception:
        pass
    return body_bytes


def _unwrap_inner_blob_json(inner_blob: dict) -> dict:
    inner_data = inner_blob.get("data")
    if inner_data is None and any(k in inner_blob for k in ("intent", "event", "action")):
        inner_data = inner_blob
    elif isinstance(inner_data, str) and (inner_data.startswith("{") or inner_data.startswith("[")):
        try:
            inner_data = json.loads(inner_data)
        except Exception:
            pass
    return {
        "xblobType": inner_blob.get("xblobType") or "Blob",
        "type": inner_blob.get("type") or "application/json",
        "size": inner_blob.get("size") or 0,
        "name": inner_blob.get("name"),
        "data": inner_data,
        "_dataType": inner_blob.get("_dataType") or "json",
        "contentEncoding": inner_blob.get("contentEncoding") or "identity",
    }


def _try_parse_json_bytes_body(body_bytes: bytes):
    trimmed = body_bytes.strip()
    if not (trimmed.startswith(b"{") or trimmed.startswith(b"[")):
        return None, None
    try:
        parsed_json = json.loads(trimmed.decode("utf-8"))
        if isinstance(parsed_json, dict) and isinstance(parsed_json.get("blob"), dict):
            return _unwrap_inner_blob_json(parsed_json["blob"]), None
        return None, parsed_json
    except Exception:
        return None, None


def _decode_fd_rights_body(body_bytes: bytes, received_fds):
    if received_fds and len(received_fds) > 0:
        return received_fds[0], "fd-rights"
    body_str = body_bytes.decode("utf-8", errors="replace").strip()
    return (int(body_str) if body_str.isdigit() else body_str), "fd-rights"


def _decode_bytes_body_by_encoding(body_bytes: bytes, transfer_enc: str, received_fds, json_data):
    lower_enc = transfer_enc.lower()
    if "fd-rights" in lower_enc:
        return _decode_fd_rights_body(body_bytes, received_fds)
    if "base64" in lower_enc:
        try:
            return base64.b64decode(body_bytes.strip()), "binary"
        except Exception:
            return body_bytes, "base64"
    if json_data is not None:
        return json_data, "json"
    if "identity" in lower_enc:
        return body_bytes.decode("utf-8", errors="replace"), "text"
    return body_bytes, "binary"


def _parse_bytes_xblob_at_rest(raw_bytes: bytes, received_fds) -> dict:
    header_text, body_bytes = _split_bytes_headers_and_body(raw_bytes)
    headers = _parse_header_map(header_text)
    content_type = headers.get("content-type", "application/octet-stream")
    size = _parse_content_length(headers.get("content-length"), len(body_bytes))
    name = _extract_filename(headers.get("content-disposition", ""))
    xblob_type = headers.get("x-xblob-type") or headers.get("x-blob-type") or "Blob"
    transfer_enc = headers.get("content-encoding") or headers.get("content-transfer-encoding", "")

    body_bytes = _strip_chunked_framing(body_bytes)
    early_blob, json_data = _try_parse_json_bytes_body(body_bytes)
    if early_blob is not None:
        return early_blob

    data, data_type = _decode_bytes_body_by_encoding(body_bytes, transfer_enc, received_fds, json_data)
    return {
        "xblobType": xblob_type,
        "type": content_type,
        "size": size,
        "name": name,
        "data": data,
        "_dataType": data_type,
    }


def _split_str_headers_and_body(raw_str: str):
    crlf_pos = raw_str.find("\r\n\r\n")
    if crlf_pos != -1:
        return True, raw_str[:crlf_pos], raw_str[crlf_pos + 4:]
    lf_pos = raw_str.find("\n\n")
    if lf_pos != -1:
        return True, raw_str[:lf_pos], raw_str[lf_pos + 2:]
    if HEADER_LINE_RE.match(raw_str):
        return True, raw_str, ""
    return False, "", raw_str


def _parse_headerless_str_blob(raw_str: str) -> dict:
    try:
        parsed = json.loads(raw_str)
        if isinstance(parsed, dict):
            if any(k in parsed for k in ("_dataType", "xblobType", "data")):
                return parsed
            res = dict(parsed)
            res.update({
                "xblobType": "Blob",
                "type": "application/json",
                "size": len(raw_str.encode("utf-8")),
                "name": None,
                "data": parsed,
                "_dataType": "json",
            })
            return res
    except Exception:
        pass
    return {
        "xblobType": "Blob",
        "type": "text/plain",
        "size": len(raw_str.encode("utf-8")),
        "name": None,
        "data": raw_str,
        "_dataType": "text",
    }


def _resolve_str_xblob_type(headers: dict, name, content_type: str) -> str:
    explicit = headers.get("x-xblob-type") or headers.get("x-blob-type")
    if explicit:
        return explicit
    content_disp = headers.get("content-disposition", "")
    if name or "attachment" in content_disp.lower():
        return "File"
    if content_type == "multipart/mixed" or headers.get("transfer-encoding") == "chunked":
        return "ReadableStream"
    return "Blob"


def _decode_str_body(body_text: str, headers: dict, content_type: str):
    transfer_enc = headers.get("content-encoding") or headers.get("content-transfer-encoding", "")
    if "base64" in transfer_enc.lower():
        return body_text, "base64", None
    if "application/json" in content_type or "+json" in content_type:
        try:
            parsed_obj = json.loads(body_text)
            return parsed_obj, "json", parsed_obj
        except Exception:
            return body_text, "json", None
    return body_text, "text", None


def _parse_str_xblob_at_rest(raw_str: str) -> dict:
    has_headers, header_text, body_text = _split_str_headers_and_body(raw_str)
    if not has_headers:
        return _parse_headerless_str_blob(raw_str)

    headers = _parse_header_map(header_text)
    content_type = headers.get("content-type", "text/plain")
    size = _parse_content_length(headers.get("content-length"), len(body_text.encode("utf-8")))
    name = _extract_filename(headers.get("content-disposition", ""))
    xblob_type = _resolve_str_xblob_type(headers, name, content_type)
    data, data_type, parsed_json_obj = _decode_str_body(body_text, headers, content_type)

    result = {
        "xblobType": xblob_type,
        "type": content_type,
        "size": size,
        "name": name,
        "data": data,
        "_dataType": data_type,
    }
    if isinstance(parsed_json_obj, dict):
        for k, v in parsed_json_obj.items():
            if k not in result:
                result[k] = v
    return result


def parse_xblob_at_rest(raw, received_fds=None):
    if not raw:
        return {
            "xblobType": "Blob",
            "type": "text/plain",
            "size": 0,
            "name": None,
            "data": b"",
            "_dataType": "text",
        }
    if isinstance(raw, (bytes, bytearray)):
        return _parse_bytes_xblob_at_rest(bytes(raw), received_fds)
    return _parse_str_xblob_at_rest(str(raw))
