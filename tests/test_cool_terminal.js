#!/usr/bin/env bun
/**
 * Test: cool-terminal term.GetOutStream -> term.GetOutStreamResponse
 * ==================================================================
 * Verifies:
 * 1. Client creates a stdin pipe, wraps its read-end in a ReadableStream XBlob,
 *    and dispatches `term.GetOutStream` with the input ReadableStream in `dataBlob`.
 * 2. `cool-service-lighter` / `xbus-daemon` auto-launches `cool-terminal`, which
 *    opens the tty/pty device, pipes the input ReadableStream into the tty, creates
 *    an output ReadableStream pipe, and replies with `term.GetOutStreamResponse`
 *    carrying the output ReadableStream XBlob in `dataBlob`.
 * 3. Writing shell commands to the client's stdin pipe streams interactive terminal
 *    output back through the output ReadableStream XBlob pipe.
 */

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { dlopen, FFIType, ptr } = require('bun:ffi');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');

const libc = dlopen('libc.so.6', {
  pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
});

function createOsPipe() {
  const fds = new Int32Array(2);
  const rc = libc.symbols.pipe(ptr(fds));
  assert.strictEqual(rc, 0, 'pipe(2) must succeed');
  return { readFd: fds[0], writeFd: fds[1] };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function runTests() {
  const httpPort = parseInt(process.env.PORT, 10) || (await findFreePort());
  if (!process.env.XVFB_RUNNING) {
    const res = spawn(
      'xvfb-run',
      ['-a', 'bun', __filename],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          XVFB_RUNNING: '1',
          PORT: String(httpPort),
          XINTENT_PORT: String(httpPort),
        },
      }
    );
    const code = await new Promise((r) => res.on('exit', r));
    process.exit(code);
  }

  const sockPath = `/tmp/xblob-term-test-${process.pid}.sock`;
  process.env.XBLOB_SOCKET_PATH = sockPath;

  const lighterProc = spawn(
    'bun',
    [path.join(__dirname, '..', 'cool-service-lighter', 'index.js')],
    {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        XBLOB_SOCKET_PATH: sockPath,
      },
      stdio: 'inherit',
    }
  );

  const cleanup = () => {
    try { lighterProc.kill('SIGTERM'); } catch (_) {}
    if (fs.existsSync(sockPath)) {
      try { fs.unlinkSync(sockPath); } catch (_) {}
    }
  };

  try {
    await new Promise((r) => setTimeout(r, 2500));

    const { X, root } = await x11.createClientWithPromises();
    const routerWin = await xintent.connectToRouter(X, root);
    assert(routerWin > 0, 'Expected valid XIntent router window');

    const clientWin = await xintent.createClientWindow(X, root, 'test-cool-terminal-client');

    console.log('\n=== 1. Creating input ReadableStream pipe & dispatching term.GetOutStream ===');
    const { readFd: inReadFd, writeFd: inWriteFd } = createOsPipe();
    const inBlobId = await xintent.XBlobCreate(X, routerWin, clientWin, {
      xblobType: 'ReadableStream',
      type: 'application/octet-stream',
      name: 'stdin',
      data: `/proc/${process.pid}/fd/${inReadFd}`,
      _dataType: 'fd-rights',
      contentEncoding: 'fd-rights',
    });
    fs.closeSync(inReadFd);
    assert(inBlobId > 0, 'Expected non-zero input ReadableStream XBlob ID');
    console.log(`Created input ReadableStream XBlob: ${xintent.widString(inBlobId)}`);

    const txId = 777;
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for term.GetOutStreamResponse')), 10000);
      X.on('event', async (ev) => {
        if (ev.type === 33 && ev.message_type === xintent.atoms.XINTENT_EVENT_V0) {
          try {
            const frame = await xintent.parseXIntentIntentV0(X, routerWin, ev);
            if (frame.payload?.event === 'term.GetOutStreamResponse') {
              clearTimeout(timer);
              resolve(frame);
            }
          } catch (err) {
            clearTimeout(timer);
            reject(err);
          }
        }
      });
    });

    await xintent.sendXIntentIntentV0(X, routerWin, {
      senderWin: clientWin,
      txId,
      controlWord: 1, // SYN
      dataBlob: inBlobId,
      payload: {
        intent: 'term.GetOutStream',
      },
    });

    const respFrame = await responsePromise;
    console.log('Received term.GetOutStreamResponse:', respFrame.payload, 'dataBlob:', xintent.widString(respFrame.dataBlob));
    assert.strictEqual(respFrame.payload.status, 'ok');
    assert(respFrame.payload.tty && respFrame.payload.tty.startsWith('/dev/pts/'), `Expected /dev/pts/* tty, got ${respFrame.payload.tty}`);
    assert(respFrame.dataBlob > 0, 'Expected non-zero output ReadableStream XBlob ID in dataBlob');

    console.log('\n=== 2. Reading output ReadableStream pipe & exchanging terminal commands ===');
    const outBlob = await xintent.XBlobRead(
      X,
      routerWin,
      respFrame.dataBlob,
      null,
      null,
      clientWin,
      'test-cool-terminal-client',
      { receiveFd: true, acceptReadableStream: true }
    );
    assert.strictEqual(outBlob.xblobType, 'ReadableStream', `Expected ReadableStream, got ${outBlob.xblobType}`);
    assert.strictEqual(typeof outBlob.data, 'number', 'Expected open file descriptor for output ReadableStream');

    const outFd = outBlob.data;
    const stat = fs.fstatSync(outFd);
    assert(stat.isFIFO(), 'Expected output ReadableStream FD to be a FIFO/pipe');

    const outputReceivedPromise = new Promise((resolve, reject) => {
      let accumulated = '';
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for terminal output (got: ${JSON.stringify(accumulated)})`)), 5000);
      const outStream = fs.createReadStream(null, { fd: outFd, autoClose: true });
      outStream.on('data', (chunk) => {
        accumulated += chunk.toString('utf8');
        if (accumulated.includes('COOL_TERMINAL_RESULT=42')) {
          clearTimeout(timer);
          outStream.destroy();
          resolve(accumulated);
        }
      });
      outStream.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    fs.writeSync(inWriteFd, 'echo "COOL_TERMINAL_RESULT=$((20 + 22))"\nexit\n');
    fs.closeSync(inWriteFd);

    const terminalOutput = await outputReceivedPromise;
    console.log('Terminal output received from ReadableStream:\n' + terminalOutput.trim());
    assert(terminalOutput.includes('COOL_TERMINAL_RESULT=42'));

    console.log('\n=== 3. Verifying cool-terminal HTML Card (80x24 green font) & HTTP Bridge Stream Flow ===');
    const cardRes = await fetch(`http://localhost:${httpPort}/apps/cool-terminal`);
    assert.strictEqual(cardRes.status, 200, 'Expected HTTP 200 for /apps/cool-terminal card');
    const cardHtml = await cardRes.text();
    assert(cardHtml.includes('data-cols="80" data-rows="24"'), 'Expected 80x24 terminal screen in HTML card');
    assert(cardHtml.includes('--phosphor-green: #33ff33'), 'Expected green phosphor font styling in HTML card');

    const createInRes = await fetch(`http://localhost:${httpPort}/xblob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        xblobType: 'ReadableStream',
        type: 'application/octet-stream',
        name: 'tty-stdin',
      }),
    });
    const createInData = await createInRes.json();
    const webInBlobId = createInData.blobId;
    assert(webInBlobId, 'Expected webInBlobId from POST /xblob');

    const webIntentRes = await fetch(`http://localhost:${httpPort}/intent/term/GetOutStream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Channel-Control': 'SYN',
        'X-Attached-Blob-Id': String(webInBlobId),
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        intent: 'term.GetOutStream',
        Prefer: 'return=minimal',
      }),
    });
    const webMultipartText = await webIntentRes.text();
    const attachedMatch = webMultipartText.match(/X-Attached-Blob-Id:\s*([^\r\n]+)/i);
    assert(attachedMatch, `Expected X-Attached-Blob-Id in multipart response, got:\n${webMultipartText}`);
    const webOutBlobId = attachedMatch[1].trim();
    console.log(`Web card session allocated IN=${webInBlobId}, OUT=${webOutBlobId}`);

    const streamRes = await fetch(`http://localhost:${httpPort}/xblob/${encodeURIComponent(webOutBlobId)}`, {
      headers: { Accept: 'application/octet-stream' },
    });
    assert.strictEqual(streamRes.status, 200, 'Expected HTTP 200 streaming response for webOutBlobId');
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();

    await fetch(`http://localhost:${httpPort}/xblob/${encodeURIComponent(webInBlobId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'echo "WEB_CARD_80X24_OK=$((50 + 50))"\nexit\n', eof: true }),
    });

    let webAccumulated = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        webAccumulated += decoder.decode(value, { stream: true });
        if (webAccumulated.includes('WEB_CARD_80X24_OK=100')) {
          await reader.cancel();
          break;
        }
      }
    }
    console.log('Web card streamed output:\n' + webAccumulated.trim());
    assert(webAccumulated.includes('WEB_CARD_80X24_OK=100'), 'Expected WEB_CARD_80X24_OK=100 in web card stream');

    console.log('\n[VERIFICATION PASSED] cool-terminal term.GetOutStream -> term.GetOutStreamResponse and 80x24 HTML card succeeded!');
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err);
    cleanup();
    process.exit(1);
  }
}

runTests();
