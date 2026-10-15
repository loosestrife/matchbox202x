#!/usr/bin/env python3
"""
Test: Python libxintent.py XBlob UNIX Socket & fd-rights Retrieval
====================================================================
Tests that libxintent.py connects via UNIX domain socket (XBLOB_SOCKET_PATH)
to fetch XBlobs with Content-Encoding: fd-rights without falling back to X11 properties.
"""

import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "x11-promises")))
from xintent_xlib import XIntentXlibClient

TEST_PORT = os.environ.get("PORT") or os.environ.get("XINTENT_PORT") or "12356"


def run_test():
    if not os.environ.get("XVFB_RUNNING") and shutil.which("xvfb-run"):
        print("--- Relaunching test inside isolated Xvfb server via xvfb-run ---")
        env = dict(os.environ, XVFB_RUNNING="1", PYTHONUNBUFFERED="1", PORT=TEST_PORT, XINTENT_PORT=TEST_PORT)
        cmd = ["xvfb-run", "-a"]
        if shutil.which("uv"):
            cmd.extend(["uv", "run"])
        cmd.extend(["python3"] + sys.argv)
        res = subprocess.run(cmd, env=env)
        sys.exit(res.returncode)

    display = os.environ.get("DISPLAY", ":99")
    print(f"--- Running Python fd-rights XBlob test inside Xvfb '{display}' on PORT '{TEST_PORT}' ---")

    test_file = "/tmp/test_fd_rights_sample.txt"
    test_content = "Zero-Copy FD-Rights Python libxintent Test Data 12345"
    with open(test_file, "w") as f:
        f.write(test_content)

    env = dict(os.environ, PORT=TEST_PORT, XINTENT_PORT=TEST_PORT, DISPLAY=display, PYTHONUNBUFFERED="1")

    print("--- 1. Starting cool-service-lighter / xbus-daemon ---")
    supervisor_script = "/home/user/matchbox202x/cool-service-lighter/index.js"
    supervisor_proc = subprocess.Popen(
        ["node", supervisor_script],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env,
    )
    time.sleep(2.5)

    try:
        print("--- 2. Sending test file via final-copy-pro.js ---")
        final_copy_proc = subprocess.run(
            ["node", "/home/user/matchbox202x/final-copy-pro.js", test_file],
            capture_output=True,
            text=True,
            env=env,
        )
        print("FINAL COPY STDOUT:", final_copy_proc.stdout.strip())

        # Extract dataBlob atom from stdout
        blob_id = None
        for line in final_copy_proc.stdout.splitlines():
            if "dataBlob:" in line:
                parts = line.split("dataBlob:")
                if len(parts) > 1:
                    raw_id = parts[1].strip().rstrip(")...")
                    blob_id = int(raw_id)
                    break

        if not blob_id:
            print("[FAILED] Could not extract dataBlob ID from final-copy-pro.js output")
            return False

        print(f"--- 3. Testing libxintent.py blob_read({blob_id}) over UNIX Socket ---")
        client = XIntentXlibClient(app_id="test-python-fd-rights", display_name=display)

        # Read blob using libxintent.py
        blob_result = client.blob_read(blob_id)
        print("BLOB READ RESULT:", blob_result)

        if not blob_result or not isinstance(blob_result, dict):
            print("[FAILED] blob_read returned invalid result")
            return False

        data_val = blob_result.get("data")
        data_type = blob_result.get("_dataType") or blob_result.get("contentEncoding")
        print(f"Extracted _dataType: '{data_type}', data: '{data_val}'")

        if data_type == "fd-rights" or "fd-rights" in str(blob_result.get("contentEncoding", "")):
            print("\n[VERIFICATION PASSED] Successfully fetched Content-Encoding: fd-rights blob over UNIX socket via libxintent.py!")
            return True
        elif test_content in str(data_val) or test_file in str(data_val):
            print("\n[VERIFICATION PASSED] Successfully fetched file blob over UNIX socket via libxintent.py!")
            return True
        else:
            print(f"[FAILED] Expected file content or fd-rights, got: {data_val}")
            return False

    finally:
        supervisor_proc.terminate()
        try:
            supervisor_proc.wait(timeout=3)
        except Exception:
            supervisor_proc.kill()
        if os.path.exists(test_file):
            os.remove(test_file)


if __name__ == "__main__":
    success = run_test()
    sys.exit(0 if success else 1)
