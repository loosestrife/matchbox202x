#!/usr/bin/env bash
set -e

export PORT=12355
export XINTENT_PORT=12355

echo "================================================================="
echo "=== Running Matchbox202x Integration Tests in Isolated Xvfb ==="
echo "================================================================="

xvfb-run -a bash -c "
  set -e
  export PORT=12355
  export XINTENT_PORT=12355

  echo ''
  echo '--- 1. Running XBlob Unit Tests ---'
  node /home/user/matchbox202x/tests/test-xblob.js

  echo ''
  echo '--- 2. Running Zero-Copy Append Paste Test ---'
  node /home/user/matchbox202x/tests/test_zero_copy_append_paste.js

  echo ''
  echo '--- 3. Running DLNA Bridge Integration Test ---'
  python3 /home/user/matchbox202x/test_dlna_dry_run.py

  echo ''
  echo '--- 4. Running Python libxintent.py fd-rights UNIX Socket Test ---'
  uv run python3 /home/user/matchbox202x/tests/test_fd_rights_python.py

  echo ''
  echo '--- 5. Running E2E Integration Pipeline ---'
  node /home/user/matchbox202x/tests/test-e2e-pipeline.js
"

echo ""
echo "================================================================="
echo "=== ALL MATCHBOX 202X TESTS PASSED CLEANLY IN ISOLATED XVFB ==="
echo "================================================================="
