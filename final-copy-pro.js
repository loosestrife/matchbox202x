#!/usr/bin/env node
// usage:
// $ final-copy-pro.js cat.png                                      # Copies file to clipboard via ui.Copy (no dialog)
// $ final-copy-pro.js --intent fs.SendTo cat.png                 # Sends file via fs.SendTo (opens Zenity target dialog)
// $ final-copy-pro.js --intent fs.SendTo --app cool-clips cat.png # Sends file via fs.SendTo directly to cool-clips
// $ final-copy-pro.js --select-app cat.png                        # Copies file via ui.Copy with Zenity target dialog
// $ final-copy-pro.js --intent ui.Copy --echo "<b>html</b>"       # Copy text to clipboard

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const xintent = require('./x11-promises/xintent');
const {connectToRouter, createClientWindow, sendXIntentIntentV0, XBlobCreate} = xintent;
const x11 = require('./x11-promises/x11-promises');

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/x-wav',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function fetchApiTags(port = parseInt(process.env.XINTENT_PORT || process.env.PORT || '12345', 10)) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/tags`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function discoverSendToTargets() {
  const targets = [];
  const seen = new Set();

  const tagsData = await fetchApiTags();
  if (tagsData) {
    const sendToIntents = [
      ...(tagsData.intents?.['fs.SendTo'] || []),
      ...(tagsData.intents?.['fs.SaveAs'] || []),
      ...(tagsData.intents?.['media.Play'] || []),
    ];

    for (const appId of sendToIntents) {
      if (!seen.has(appId)) {
        seen.add(appId);
        const appInfo = tagsData.apps?.[appId] || {};
        let friendlyName = appInfo.name || appId;
        if (appId.startsWith('dlna-')) {
          friendlyName = appInfo.name || `DLNA (${appId.replace('dlna-', '')})`;
        } else if (appId === 'cool-clips') {
          friendlyName = 'Cool Clips (Desktop Clipboard & Files)';
        } else if (appId === 'user-phone:flammenwerfer') {
          friendlyName = 'User Phone (Flammenwerfer)';
        }
        targets.push({
          appId,
          name: friendlyName,
          description: appInfo.description || 'Active XIntent Destination',
        });
      }
    }
  }

  return targets;
}

function selectTargetWithZenity(targets, fileName) {
  if (!targets || targets.length === 0) return null;

  const columns = ['--column=App ID', '--column=Destination Name', '--column=Description'];
  const listArgs = [
    '--list',
    '--title=XIntent - Select Destination',
    `--text=Select target destination for: ${fileName || 'attachment'}`,
    '--print-column=1',
    '--hide-column=1',
    '--width=600',
    '--height=380',
    ...columns,
  ];

  for (const t of targets) {
    listArgs.push(t.appId, t.name, t.description);
  }

  try {
    const res = spawnSync('zenity', listArgs, { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      const selected = res.stdout.trim();
      return selected || null;
    }
  } catch (e) {
    console.warn('[final-copy-pro] Zenity dialog unavailable:', e.message);
  }

  return null;
}

async function main() {
  const args = process.argv.slice(2);
  let typeArg = null;
  let echoArg = null;
  let fileArg = null;
  let intentArg = null;
  let targetAppArg = null;
  let selectAppArg = false;
  let positionalArg = null;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--type' || args[i] === '-t') && args[i + 1]) {
      typeArg = args[i + 1];
      i++;
    } else if ((args[i] === '--intent' || args[i] === '-i') && args[i + 1]) {
      intentArg = args[i + 1];
      i++;
    } else if ((args[i] === '--target' || args[i] === '-a' || args[i] === '--app') && args[i + 1]) {
      targetAppArg = args[i + 1];
      i++;
    } else if (args[i] === '--select-app' || args[i] === '-s') {
      selectAppArg = true;
    } else if ((args[i] === '--echo' || args[i] === '-e') && args[i + 1]) {
      echoArg = args[i + 1];
      i++;
    } else if ((args[i] === '--file' || args[i] === '-f') && args[i + 1]) {
      fileArg = args[i + 1];
      i++;
    } else if (!positionalArg) {
      positionalArg = args[i];
    }
  }

  const stdinData = await readStdin();
  let xblobPayload = null;

  if (echoArg !== null) {
    const textBuf = Buffer.from(echoArg, 'utf8');
    const mimeType = typeArg || 'text/plain';
    xblobPayload = {
      xblobType: 'Blob',
      type: mimeType,
      size: textBuf.length,
      _dataType: 'text',
      data: echoArg,
    };
  } else if (stdinData && stdinData.length > 0) {
    const mimeType = typeArg || 'text/plain';
    const isText = mimeType.startsWith('text/') || mimeType === 'application/json';
    xblobPayload = {
      xblobType: 'Blob',
      type: mimeType,
      size: stdinData.length,
      _dataType: isText ? 'text' : 'base64',
      data: isText ? stdinData.toString('utf8') : stdinData.toString('base64'),
    };
  } else if (fileArg || (positionalArg && fs.existsSync(positionalArg))) {
    const filePath = path.resolve(fileArg || positionalArg);
    const fileName = path.basename(filePath);
    const mimeType = typeArg || getMimeType(filePath);
    const stats = fs.statSync(filePath);

    xblobPayload = {
      xblobType: 'File',
      name: fileName,
      type: mimeType,
      size: stats.size,
      url: `file://${filePath}`,
      _dataType: 'fd-rights',
      contentEncoding: 'fd-rights',
      data: filePath,
    };
  } else if (positionalArg) {
    const textBuf = Buffer.from(positionalArg, 'utf8');
    xblobPayload = {
      xblobType: 'Blob',
      type: typeArg || 'text/plain',
      size: textBuf.length,
      _dataType: 'text',
      data: positionalArg,
    };
  } else {
    console.error('Error: No input provided via --echo, stdin, or positional arguments.');
    process.exit(1);
  }

  // Default intent is ui.Copy unless explicitly specified via --intent
  const intentName = intentArg || 'ui.Copy';

  // Prompt user with Zenity selection dialog if --select-app is requested OR if intent is fs.SendTo without an explicit target app
  const shouldPromptApp = selectAppArg || (!targetAppArg && intentName === 'fs.SendTo');

  if (shouldPromptApp) {
    console.log(`Discovering registered ${intentName} destinations...`);
    const availableTargets = await discoverSendToTargets();
    const chosenTarget = selectTargetWithZenity(availableTargets, xblobPayload.name);

    if (!chosenTarget) {
      console.log(`[${intentName}] Target selection cancelled by user.`);
      process.exit(0);
    }
    targetAppArg = chosenTarget;
    console.log(`User selected target destination: ${targetAppArg}`);
  }

  const { X, root } = await x11.createClientWithPromises();
  await connectToRouter(X, root);
  if (!xintent.routerWin) {
    console.error('Error: Could not connect to XINTENT router.');
    process.exit(1);
  }

  const clientWin = await createClientWindow(X, root, 'final-copy-pro');
  const dataBlobAtom = await XBlobCreate(X, xintent.routerWin, clientWin, xblobPayload);

  console.log(`Sending intent '${intentName}' to '${targetAppArg || 'all'}' (dataBlob: ${dataBlobAtom})...`);
  await sendXIntentIntentV0(X, xintent.routerWin, {
    senderWin: clientWin,
    dataBlob: dataBlobAtom,
    payload: {
      intent: intentName,
      app: targetAppArg || undefined,
      name: xblobPayload.name,
      mimeType: xblobPayload.type,
      size: xblobPayload.size,
    },
  });

  console.log(`[${intentName}] Successfully sent ${xblobPayload.name || xblobPayload.xblobType} (${xblobPayload.type}) to '${targetAppArg || 'default'}'.`);
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  console.error('[final-copy-pro] Error:', err);
  process.exit(1);
});
