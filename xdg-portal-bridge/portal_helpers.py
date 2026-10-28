#!/usr/bin/env python3
"""
XIntent Portal Bridge Helpers
-----------------------------
Payload extraction, multipart HTTP response parsing, and temporary file persistence
helpers for the XDG Desktop Portal FileChooser daemon.
"""

import base64
import json
import os
import re
import tempfile
import urllib.parse
import urllib.request


def extract_blob_dict_bytes(blob_obj: dict, default_name: str):
    file_name = blob_obj.get("name") or default_name
    d = blob_obj.get("data")
    if blob_obj.get("_dataType") == "base64" and isinstance(d, str):
        return file_name, base64.b64decode(d)
    if isinstance(d, str):
        return file_name, d.encode("utf-8")
    if isinstance(d, (bytes, bytearray)):
        return file_name, bytes(d)
    return file_name, None


def extract_native_response_file(x11_client, response_data: dict):
    resp_payload = response_data.get("payload", {})
    data_blob = response_data.get("data_blob", 0)
    file_name = "picked_desktop_file"
    file_data = None

    if data_blob:
        try:
            blob_content = x11_client.blob_read(data_blob)
            if isinstance(blob_content, dict):
                file_name = blob_content.get("name") or file_name
                file_data = blob_content.get("data")
            elif isinstance(blob_content, (bytes, bytearray)):
                file_data = bytes(blob_content)
        except Exception as e:
            print(f"[xintent-portal] Error reading response data_blob {hex(data_blob)}: {e}")

    if not file_data and isinstance(resp_payload, dict) and isinstance(resp_payload.get("blob"), dict):
        file_name, file_data = extract_blob_dict_bytes(resp_payload["blob"], file_name)

    return file_name, file_data


def detect_multipart_boundary(raw_bytes: bytes, content_type: str):
    m = re.search(r"boundary=([^\s;]+)", content_type, re.IGNORECASE)
    if m:
        return m.group(1).strip('"')

    raw_str = raw_bytes[:512].decode("latin1", errors="ignore")
    for line in raw_str.splitlines():
        if "MatchboxFrameBoundary" in line:
            return line.strip().lstrip("-").rstrip("-").strip()
    return None


def parse_multipart_parts(raw_bytes: bytes, boundary: str):
    delimiter = f"--{boundary}".encode("latin1")
    found_name = "picked_desktop_file"
    for part in raw_bytes.split(delimiter):
        if not part or part in (b"--\r\n", b"--"):
            continue
        header_end = part.find(b"\r\n\r\n")
        if header_end == -1:
            continue
        headers_text = part[:header_end].decode("utf-8", errors="ignore")
        body_bytes = part[header_end + 4:].rstrip(b"\r\n")
        cd_match = re.search(r'filename\s*=\s*"?([^";\r\n]+)"?', headers_text, re.IGNORECASE)
        if cd_match:
            found_name = cd_match.group(1).strip()
        if "application/json" not in headers_text.lower() and body_bytes:
            return found_name, body_bytes
    return None


def parse_http_pick_response(raw_bytes: bytes, content_type: str):
    if not raw_bytes:
        return "picked_file", None

    try:
        json_obj = json.loads(raw_bytes.decode("utf-8"))
        if json_obj.get("status") == "ok" and isinstance(json_obj.get("blob"), dict):
            return extract_blob_dict_bytes(json_obj["blob"], "picked_file")
    except Exception:
        pass

    boundary = detect_multipart_boundary(raw_bytes, content_type)
    if boundary:
        parsed_part = parse_multipart_parts(raw_bytes, boundary)
        if parsed_part:
            return parsed_part

    return "picked_desktop_file", raw_bytes


def dispatch_http_pick_file(bus_url: str, target_app: str, payload: dict, user_agent: str):
    encoded_target = urllib.parse.quote(target_app)
    request_url = f"{bus_url}/intent/fs/PickFile?app={encoded_target}"
    json_data = json.dumps(payload).encode("utf-8")

    headers = {
        "User-Agent": user_agent,
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "*/*",
        "X-Forwarded-By": "xintent-desktop-portal",
        "X-Channel-Control": "SYN"
    }

    try:
        req = urllib.request.Request(request_url, data=json_data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            status_code = resp.status
            raw_bytes = resp.read()
            content_type = resp.headers.get("Content-Type", "")

        if status_code in (200, 201):
            return parse_http_pick_response(raw_bytes, content_type)
    except Exception as e:
        print(f"[xintent-portal] HTTP bridge fallback error: {e}")

    return "picked_file", None


def save_picked_file_to_temp(file_name: str, file_bytes: bytes) -> str:
    tmp_dir = os.path.join(tempfile.gettempdir(), "xintent_picked_files")
    os.makedirs(tmp_dir, exist_ok=True)
    saved_file_path = os.path.join(tmp_dir, file_name)

    with open(saved_file_path, "wb") as f:
        f.write(file_bytes)

    file_uri = f"file://{os.path.abspath(saved_file_path)}"
    print(f"[xintent-portal] Picked file saved to: {file_uri} ({len(file_bytes)} bytes)")
    return file_uri
