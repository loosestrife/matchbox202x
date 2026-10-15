#!/usr/bin/env node
/**
 * Test: Zero-Copy File Descriptor Passing & Live Append Paste
 * =========================================================
 * Tests copying a file with final-copy-pro.js, pasting from cool-clips,
 * appending new text to the file on disk, and verifying that subsequent pastes
 * dynamically stream the updated file content over zero-copy fd-rights.
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');

const TEST_FILE = '/tmp/test_zero_copy_append.txt';
let busProc = null;
let clipsProc = null;

function cleanup() {
  if (clipsProc) try { clipsProc.kill('SIGKILL'); } catch (_) {}
  if (fs.existsSync(TEST_FILE)) try { fs.unlinkSync(TEST_FILE); } catch (_) {}
}

async function ensureServices(X, root) {
  let routerWin = await xintent.connectToRouter(X, root, 0);
  if (!routerWin) {
    console.log('[test] xbus-daemon not detected. Auto-launching xbus-daemon...');
    const busScript = path.join(__dirname, '..', 'xbus-daemon', 'index.js');
    busProc = spawn('node', [busScript], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log('[test] Spawning cool-clips daemon...');
  const clipsScript = path.join(__dirname, '..', 'cool-clips.js');
  clipsProc = spawn('node', [clipsScript], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
}

async function pasteClipboardText() {
  const { X, root } = await x11.createClientWithPromises();
  await xintent.connectToRouter(X, root);
  const clientWin = await xintent.createClientWindow(X, root, 'test-paste-client');
  const targetAtom = await X.InternAtom(false, 'UTF8_STRING');
  const propAtom = await X.InternAtom(false, 'XSEL_DATA');
  const clipAtom = await X.InternAtom(false, 'CLIPBOARD');

  await X.DeleteProperty(clientWin, propAtom);
  X.ConvertSelection(clientWin, clipAtom, targetAtom, propAtom, 0);

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 3000);
    X.on('event', async (ev) => {
      if (ev.type === 31 && ev.requestor === clientWin) {
        clearTimeout(timeout);
        try {
          const prop = await X.GetProperty(0, clientWin, propAtom, 0, 0, 10000);
          resolve(prop && prop.data ? prop.data.toString('utf8') : null);
        } catch (e) {
          resolve(null);
        }
      }
    });
  });
}

async function runTest() {
  const { X, root } = await x11.createClientWithPromises();
  await ensureServices(X, root);

  console.log('--- 1. Initializing test file ---');
  fs.writeFileSync(TEST_FILE, 'Line 1: Initial content\n');

  console.log('--- 2. Copying file via final-copy-pro.js ---');
  const finalCopyScript = path.join(__dirname, '..', 'final-copy-pro.js');
  execSync(`node "${finalCopyScript}" "${TEST_FILE}"`, { stdio: 'inherit' });

  await new Promise((r) => setTimeout(r, 500));

  console.log('--- 3. Testing Paste #1 (Initial Content) ---');
  const paste1 = await pasteClipboardText();
  console.log('Paste #1 Result:\n' + JSON.stringify(paste1));

  if (!paste1 || !paste1.includes('Line 1: Initial content')) {
    console.error('FAILED: Paste #1 did not return expected initial content');
    cleanup();
    process.exit(1);
  }

  console.log('--- 4. Appending Line 2 to file on disk ---');
  fs.appendFileSync(TEST_FILE, 'Line 2: Appended live content\n');

  await new Promise((r) => setTimeout(r, 500));

  console.log('--- 5. Testing Paste #2 (After Live Append) ---');
  const paste2 = await pasteClipboardText();
  console.log('Paste #2 Result:\n' + JSON.stringify(paste2));

  if (!paste2 || !paste2.includes('Line 2: Appended live content')) {
    console.error('FAILED: Paste #2 did not stream updated live content');
    cleanup();
    process.exit(1);
  }

  console.log('\n✅ [PASSED] Zero-copy file descriptor live append test completed successfully!');
  cleanup();
  process.exit(0);
}

runTest().catch((err) => {
  console.error('Test error:', err);
  cleanup();
  process.exit(1);
});
