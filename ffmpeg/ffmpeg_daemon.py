#!/usr/bin/env python3
import sys
import json
import subprocess
import os

def run_ffmpeg_file_transform(src_path, dest_path, target_mime):
    """Executes a standard one-shot zero-copy file transcode."""
    cmd = ["ffmpeg", "-y", "-i", src_path]
    
    if "audio/" in target_mime:
        cmd.extend(["-vn", "-acodec", "aac" if "m4a" in target_mime else "libopus"])
    else:
        cmd.extend(["-vcodec", "h264", "-acodec", "aac"])
        
    cmd.append(dest_path)
    subprocess.run(cmd, check=True)

def handle_stream_transform(intent_data):
    payload = intent_data.get("payload", {})
    action = intent_data.get("action")
    sender = intent_data.get("sender")
    channel = intent_data.get("channel")
    
    transport = payload.get("transport", "file")
    target_mime = payload.get("target_mime", "video/mp4")
    src_path = payload.get("source_path")
    
    if transport == "file" and src_path:
        out_path = f"/tmp/transcode_{os.getpid()}.mp4"
        run_ffmpeg_file_transform(src_path, out_path, target_mime)
        
        # 1. Zero-copy file transfer handoff
        transfer_msg = {
            "type": "intent",
            "action": "sys.TransferFile",
            "payload": {
                "source_path": out_path,
                "target_app": sender,
                "read_only": False
            }
        }
        sys.stdout.write(json.dumps(transfer_msg) + "\n")
        
        # 2. Synchronous completion response
        if channel:
            response = {
                "type": "intent",
                "action": "sys.SendData",
                "disposition": "final-response",
                "channel": channel,
                "payload": {
                    "status": "completed",
                    "file_path": out_path,
                    "mime": target_mime
                }
            }
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()

def main():
    for line in sys.stdin:
        if not line.strip(): continue
        try:
            data = json.loads(line)
            if data.get("action") == "media.TransformStream":
                handle_stream_transform(data)
        except Exception as e:
            sys.stderr.write(f"FFmpeg daemon error: {e}\n")

if __name__ == "__main__":
    main()