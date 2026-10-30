#!/usr/bin/env python3
"""
DLNA UPnP SOAP & XML Helpers
============================
Handles UPnP device description XML parsing, ConnectionManager.GetProtocolInfo
SOAP queries, DIDL-Lite metadata generation, and AVTransport SOAP playback calls.
"""

import html
import logging
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from typing import Optional, Set, Tuple

from dlna_probe import DLNADevice, apply_device_quirks, build_accept_header_from_sink

logger = logging.getLogger("dlna_media_manager")

DEFAULT_MIMES = {"video/mpeg", "video/vnd.dlna.mpeg-tts", "video/mp4", "video/webm", "audio/mpeg", "text/plain"}
DEFAULT_ACCEPT = 'video/mpeg; codecs="h264, aac", video/mp4; codecs="h264, aac", video/webm; codecs="vp8, vorbis", text/plain'

UPNP_CLASS_PREFIXES = (
    ("audio/", "object.item.audioItem.musicItem"),
    ("image/", "object.item.imageItem.photo"),
)


def _extract_sink_mimes(sink_text: str) -> Set[str]:
    supported_mimes: Set[str] = set()
    for raw_entry in sink_text.split(","):
        entry = raw_entry.strip()
        if not entry.startswith("http-get:"):
            continue
        parts = entry.split(":")
        if len(parts) >= 3:
            mime = parts[2].strip().lower()
            if mime and mime != "*":
                supported_mimes.add(mime)
    return supported_mimes


def query_get_protocol_info_soap(connection_manager_url: str, dev: Optional[DLNADevice] = None) -> Tuple[Set[str], str]:
    """
    Queries ConnectionManager.GetProtocolInfo via UPnP SOAP to obtain the renderer's supported Sink MIME types and codecs.
    """
    if not connection_manager_url:
        return (set(DEFAULT_MIMES), DEFAULT_ACCEPT)

    soap_body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        '<s:Body>'
        '<u:GetProtocolInfo xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1"/>'
        '</s:Body>'
        '</s:Envelope>'
    )
    supported_mimes: Set[str] = set()
    accept_val = DEFAULT_ACCEPT

    try:
        req = urllib.request.Request(
            connection_manager_url,
            data=soap_body.encode("utf-8"),
            headers={
                "Content-Type": 'text/xml; charset="utf-8"',
                "SOAPACTION": '"urn:schemas-upnp-org:service:ConnectionManager:1#GetProtocolInfo"'
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            xml_resp = resp.read()

        root = ET.fromstring(xml_resp)
        sink_text = root.findtext(".//Sink") or root.findtext(".//sink") or ""

        logger.info(f"=== [DLNA Device Sink Capabilities] Response from {connection_manager_url} ===")
        logger.info(f"{sink_text}")
        logger.info("==========================================================================")

        supported_mimes = _extract_sink_mimes(sink_text)
        accept_val = build_accept_header_from_sink(sink_text, supported_mimes)
        if dev:
            _, supported_mimes, accept_val = apply_device_quirks(dev, sink_text, supported_mimes, accept_val)
    except Exception as e:
        logger.debug(f"GetProtocolInfo query error for {connection_manager_url}: {e}")

    if not supported_mimes:
        return (set(DEFAULT_MIMES), DEFAULT_ACCEPT)

    supported_mimes.add("text/plain")
    return (supported_mimes, accept_val)


def _find_xml_text(elem: ET.Element, tag: str, ns: dict, default: str = "") -> str:
    return (elem.findtext(f"ns:{tag}", "", ns) or elem.findtext(tag, default)).strip()


def _populate_device_services(dev: DLNADevice, dev_elem: ET.Element, ns: dict, location: str) -> None:
    services = dev_elem.findall(".//ns:service", ns) or dev_elem.findall(".//service")
    for s in services:
        stype = _find_xml_text(s, "serviceType", ns)
        curl = _find_xml_text(s, "controlURL", ns)
        if not curl:
            continue
        full_url = urllib.parse.urljoin(location, curl)
        if "AVTransport" in stype:
            dev.av_transport_control_url = full_url
        elif "ConnectionManager" in stype:
            dev.connection_manager_control_url = full_url


def fetch_and_parse_device_description(location: str, protocol_info_fetcher) -> Optional[DLNADevice]:
    try:
        req = urllib.request.Request(location, headers={"User-Agent": "DLNA-XIntent-Bridge/1.0"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            xml_data = resp.read()
        root = ET.fromstring(xml_data)

        ns = {"ns": "urn:schemas-upnp-org:device-1-0"}
        dev_elem = root.find(".//ns:device", ns) or root.find(".//device")
        if dev_elem is None or "MediaRenderer" not in _find_xml_text(dev_elem, "deviceType", ns):
            return None

        udn = _find_xml_text(dev_elem, "UDN", ns) or f"uuid:{uuid.uuid4()}"
        dev = DLNADevice(location=location, udn=udn)
        dev.friendly_name = _find_xml_text(dev_elem, "friendlyName", ns, "DLNA TV")
        dev.manufacturer = _find_xml_text(dev_elem, "manufacturer", ns)
        dev.model_name = _find_xml_text(dev_elem, "modelName", ns)

        _populate_device_services(dev, dev_elem, ns, location)
        if not dev.av_transport_control_url:
            return None

        mimes, accept_val = protocol_info_fetcher(dev.connection_manager_control_url, dev=dev)
        dev.supported_mime_types = mimes
        dev.accept_header_val = accept_val

        logger.info(f"Fetched DLNA Renderer capabilities for [{dev.friendly_name}]:")
        logger.info(f"  Supported MIME Types ({len(dev.supported_mime_types)}): {sorted(list(dev.supported_mime_types))}")
        logger.info(f"  Accept Header: {dev.accept_header_val}")
        return dev
    except Exception as e:
        logger.debug(f"Error fetching device info from {location}: {e}")
        return None


def build_didl_lite_metadata(name: str, clean_mime: str, media_url: str, is_live_stream: bool = False) -> str:
    upnp_class = "object.item.videoItem"
    for prefix, cls_name in UPNP_CLASS_PREFIXES:
        if clean_mime.startswith(prefix):
            upnp_class = cls_name
            break

    op = "00" if is_live_stream else "01"
    ci = "1" if is_live_stream else "0"
    dlna_flags = f"DLNA.ORG_OP={op};DLNA.ORG_CI={ci};DLNA.ORG_FLAGS=01700000000000000000000000000000"
    protocol_info = f"http-get:*:{clean_mime}:{dlna_flags}"

    raw_didl = (
        '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
        'xmlns:sec="http://www.samsung.com/schemas/dlna/sec">'
        '<item id="0" parentID="-1" restricted="1">'
        f'<dc:title>{html.escape(name)}</dc:title>'
        f'<upnp:class>{upnp_class}</upnp:class>'
        f'<res protocolInfo="{protocol_info}">{html.escape(media_url)}</res>'
        '</item></DIDL-Lite>'
    )
    return html.escape(raw_didl)


def _post_soap_action(control_url: str, action: str, soap_xml: str) -> None:
    req = urllib.request.Request(
        control_url,
        data=soap_xml.encode("utf-8"),
        headers={
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPACTION": f'"urn:schemas-upnp-org:service:AVTransport:1#{action}"'
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        resp.read()


def execute_soap_playback(dev: DLNADevice, media_url: str, didl_xml: str) -> None:
    try:
        soap_set_uri = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
            '<s:Body>'
            '<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID>'
            f'<CurrentURI>{html.escape(media_url)}</CurrentURI>'
            f'<CurrentURIMetaData>{didl_xml}</CurrentURIMetaData>'
            '</u:SetAVTransportURI>'
            '</s:Body>'
            '</s:Envelope>'
        )
        _post_soap_action(dev.av_transport_control_url, "SetAVTransportURI", soap_set_uri)

        soap_play = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
            '<s:Body>'
            '<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">'
            '<InstanceID>0</InstanceID>'
            '<Speed>1</Speed>'
            '</u:Play>'
            '</s:Body>'
            '</s:Envelope>'
        )
        _post_soap_action(dev.av_transport_control_url, "Play", soap_play)
        logger.info(f"Playback successfully initiated on DLNA device '{dev.friendly_name}'")
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="ignore")
        except Exception:
            pass
        headers_str = "\n".join([f"  {k}: {v}" for k, v in e.headers.items()])
        logger.error(
            f"SOAP playback call failed for '{dev.friendly_name}' [HTTP {e.code} {e.reason}]\n"
            f"--- Response Headers ---\n{headers_str}\n"
            f"--- Response Body ---\n{body}"
        )
    except Exception as e:
        logger.error(f"SOAP playback call failed for '{dev.friendly_name}': {e}")
