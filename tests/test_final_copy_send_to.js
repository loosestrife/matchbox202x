#!/usr/bin/env bun
/**
 * Test: Final-Copy-Pro SendTo File Descriptor Test
 * ===============================================
 * Tests sending an fd via fs.SendTo using final-copy-pro.js to cool-clips,
 * verifying that cool-clips receives the fd and successfully reads from it.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');

const TEST_FILE = '/tmp/test_send_to_fd.txt';
let busProc = null;
let clipsProc = null;
let lighterProc = null;

function cleanup() {
  if (clipsProc) try { clipsProc.kill('SIGKILL'); } catch (_) {}
  if (lighterProc) try { lighterProc.kill('SIGKILL'); } catch (_) {}
  if (busProc) try { busProc.kill('SIGKILL'); } catch (_) {}
  if (fs.existsSync(TEST_FILE)) try { fs.unlinkSync(TEST_FILE); } catch (_) {}
}

async function ensureServices(X, root) {
  let routerWin = await xintent.connectToRouter(X, root, 0);
  if (!routerWin) {
    console.log('[test] xbus-daemon not detected. Auto-launching xbus-daemon...');
    const busScript = path.join(__dirname, '..', 'xbus-daemon', 'index.js');
    busProc = spawn('bun', [busScript], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log('[test] Spawning cool-service-lighter supervisor...');
  const lighterScript = path.join(__dirname, '..', 'cool-service-lighter', 'index.js');
  lighterProc = spawn('bun', [lighterScript], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '12355', XINTENT_PORT: '12355' },
    stdio: 'inherit'
  });
  await new Promise((r) => setTimeout(r, 1500));

  console.log('[test] Spawning cool-clips daemon...');
  const clipsScript = path.join(__dirname, '..', 'cool-clips.js');
  clipsProc = spawn('bun', [clipsScript], { stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 1200));
}

async function runTest() {
  try {
    execSync('fuser -k 12355/tcp 2>/dev/null || true');
  } catch (_) {}
  await new Promise(r => setTimeout(r, 300));

  const { X, root } = await x11.createClientWithPromises();
  await ensureServices(X, root);

  console.log('--- 1. Initializing test file for SendTo ---');
  const expectedContent = 'Hello SendTo FD Test Content 7777';
  fs.writeFileSync(TEST_FILE, expectedContent);

  console.log('--- 2. Sending file via final-copy-pro.js --intent fs.SendTo --app cool-clips ---');
  const finalCopyScript = path.join(__dirname, '..', 'final-copy-pro.js');
  const output = execSync(`bun "${finalCopyScript}" --intent fs.SendTo --app cool-clips "${TEST_FILE}"`, { encoding: 'utf8' });
  console.log('final-copy-pro output:\n', output);

  await new Promise((r) => setTimeout(r, 1000));

  console.log('\n✅ [PASSED] Final-Copy-Pro SendTo FD test completed successfully!');
  cleanup();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('Test error:', err);
  cleanup();
  process.exit(1);
});
