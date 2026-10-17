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
  bun /home/user/matchbox202x/tests/test-xblob.js

  echo ''
  echo '--- 2. Running Zero-Copy Append Paste Test ---'
  bun /home/user/matchbox202x/tests/test_zero_copy_append_paste.js

  echo ''
  echo '--- 3. Running Final Copy SendTo Test ---'
  bun /home/user/matchbox202x/tests/test_final_copy_send_to.js

  echo ''
  echo '--- 4. Running DLNA Bridge Integration Test ---'
  bun /home/user/matchbox202x/tests/test-flammenwerfer-dlna.js

  echo ''
  echo '--- 5. Running Python libxintent.py fd-rights UNIX Socket Test ---'
  uv run python3 /home/user/matchbox202x/tests/test_fd_rights_python.py

  echo ''
  echo '--- 6. Running E2E Integration Pipeline ---'
  bun /home/user/matchbox202x/tests/test-e2e-pipeline.js

  echo ''
  echo '--- 7. Running Mock Flammenwerfer Transcode Integration Test ---'
  bun /home/user/matchbox202x/tests/test_transcode_mock_flammenwerfer.js

  echo ''
  echo '--- 8. Running Real Final-Copy-Pro Transcode Integration Test ---'
  bun /home/user/matchbox202x/tests/test_transcode_real_final_copy_pro.js
"

echo ""
echo "================================================================="
echo "=== ALL MATCHBOX 202X TESTS PASSED CLEANLY IN ISOLATED XVFB ==="
echo "================================================================="
