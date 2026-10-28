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
const TOML = require('@iarna/toml');
const { spawnSync } = require('child_process');
const xintent = require('./x11-promises/xintent');
const { connectToRouter, createClientWindow, sendXIntentIntentV0, XBlobCreate } = xintent;
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

const FRIENDLY_APP_NAMES = {
  'cool-clips': 'Cool Clips (Desktop Clipboard & Files)',
  'user-phone:flammenwerfer': 'User Phone (Flammenwerfer)',
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

async function fetchAggregateTomlFromRouter(X, routerWin) {
  if (!X || !routerWin) return null;
  try {
    const aggregateAtom = await X.InternAtom(false, 'AGGREGATE_TOML');
    const prop = await X.GetProperty(0, routerWin, aggregateAtom, 0, 0, 1000000);
    if (prop && prop.data && prop.data.length > 0) {
      return TOML.parse(prop.data.toString('utf8'));
    }
  } catch (_) {}
  return null;
}

function formatAppFriendlyName(appId, appInfo) {
  if (FRIENDLY_APP_NAMES[appId]) return FRIENDLY_APP_NAMES[appId];
  if (appId.startsWith('dlna-')) {
    return appInfo.name || `DLNA (${appId.replace('dlna-', '')})`;
  }
  return appInfo.name || appId;
}

async function discoverSendToTargets(X, routerWin) {
  let tagsData = await fetchAggregateTomlFromRouter(X, routerWin);
  if (!tagsData || !tagsData.intents) {
    tagsData = await fetchApiTags();
  }
  if (!tagsData) return [];

  const sendToIntents = [
    ...(tagsData.intents?.['fs.SendTo'] || []),
    ...(tagsData.intents?.['fs.SaveAs'] || []),
    ...(tagsData.intents?.['media.Play'] || []),
  ];

  const targets = [];
  const seen = new Set();
  for (const appId of sendToIntents) {
    if (seen.has(appId)) continue;
    seen.add(appId);
    const appInfo = tagsData.apps?.[appId] || {};
    targets.push({
      appId,
      name: formatAppFriendlyName(appId, appInfo),
      description: appInfo.description || 'Active XIntent Destination',
    });
  }
  return targets;
}

function selectTargetWithZenity(targets, fileName) {
  if (!targets || targets.length === 0) return null;

  const listArgs = [
    '--list',
    '--title=XIntent - Select Destination',
    `--text=Select target destination for: ${fileName || 'attachment'}`,
    '--print-column=1',
    '--hide-column=1',
    '--width=600',
    '--height=380',
    '--column=App ID',
    '--column=Destination Name',
    '--column=Description',
  ];

  for (const t of targets) {
    listArgs.push(t.appId, t.name, t.description);
  }

  try {
    const res = spawnSync('zenity', listArgs, { encoding: 'utf8' });
    if (res.status === 0 && res.stdout) {
      return res.stdout.trim() || null;
    }
  } catch (e) {
    console.warn('[final-copy-pro] Zenity dialog unavailable:', e.message);
  }
  return null;
}

const VALUE_FLAG_MAP = {
  '--type': 'typeArg',
  '-t': 'typeArg',
  '--intent': 'intentArg',
  '-i': 'intentArg',
  '--target': 'targetAppArg',
  '-a': 'targetAppArg',
  '--app': 'targetAppArg',
  '--echo': 'echoArg',
  '-e': 'echoArg',
  '--file': 'fileArg',
  '-f': 'fileArg',
};

const BOOLEAN_FLAG_MAP = {
  '--select-app': 'selectAppArg',
  '-s': 'selectAppArg',
};

function parseCliArgs(args) {
  const opts = {
    typeArg: null,
    echoArg: null,
    fileArg: null,
    intentArg: null,
    targetAppArg: null,
    selectAppArg: false,
    positionalArg: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const valueKey = VALUE_FLAG_MAP[arg];
    if (valueKey && args[i + 1]) {
      opts[valueKey] = args[++i];
    } else if (BOOLEAN_FLAG_MAP[arg]) {
      opts[BOOLEAN_FLAG_MAP[arg]] = true;
    } else if (!opts.positionalArg) {
      opts.positionalArg = arg;
    }
  }
  return opts;
}

function buildTextBlobPayload(text, typeArg) {
  const textBuf = Buffer.from(text, 'utf8');
  return {
    xblobType: 'Blob',
    type: typeArg || 'text/plain',
    size: textBuf.length,
    _dataType: 'text',
    data: text,
  };
}

function buildStdinBlobPayload(stdinData, typeArg) {
  const mimeType = typeArg || 'text/plain';
  const isText = mimeType.startsWith('text/') || mimeType === 'application/json';
  return {
    xblobType: 'Blob',
    type: mimeType,
    size: stdinData.length,
    _dataType: isText ? 'text' : 'base64',
    data: isText ? stdinData.toString('utf8') : stdinData.toString('base64'),
  };
}

function buildFileBlobPayload(rawPath, typeArg) {
  const filePath = path.resolve(rawPath);
  const stats = fs.statSync(filePath);
  return {
    xblobType: 'File',
    name: path.basename(filePath),
    type: typeArg || getMimeType(filePath),
    size: stats.size,
    url: `file://${filePath}`,
    _dataType: 'fd-rights',
    contentEncoding: 'fd-rights',
    data: filePath,
  };
}

const COMMAND_HANDLERS = {
  echo: (opts) => buildTextBlobPayload(opts.echoArg, opts.typeArg),
  stdin: (opts, stdinData) => buildStdinBlobPayload(stdinData, opts.typeArg),
  file: (opts) => buildFileBlobPayload(opts.fileArg || opts.positionalArg, opts.typeArg),
  positionalText: (opts) => buildTextBlobPayload(opts.positionalArg, opts.typeArg),
};

function selectInputMode(opts, stdinData) {
  if (opts.echoArg !== null) return 'echo';
  if (stdinData && stdinData.length > 0) return 'stdin';
  if (opts.fileArg || (opts.positionalArg && fs.existsSync(opts.positionalArg))) return 'file';
  if (opts.positionalArg) return 'positionalText';
  return null;
}

async function promptForTargetAppIfNeeded(X, intentName, targetAppArg, selectAppArg, fileName) {
  const shouldPrompt = selectAppArg || (!targetAppArg && intentName === 'fs.SendTo');
  if (!shouldPrompt) return targetAppArg;

  console.log(`Discovering registered ${intentName} destinations...`);
  const availableTargets = await discoverSendToTargets(X, xintent.routerWin);
  const chosenTarget = selectTargetWithZenity(availableTargets, fileName);
  if (!chosenTarget) {
    console.log(`[${intentName}] Target selection cancelled by user.`);
    process.exit(0);
  }
  console.log(`User selected target destination: ${chosenTarget}`);
  return chosenTarget;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const stdinData = await readStdin();
  const mode = selectInputMode(opts, stdinData);
  const handler = mode ? COMMAND_HANDLERS[mode] : null;

  if (!handler) {
    console.error('Error: No input provided via --echo, stdin, or positional arguments.');
    process.exit(1);
  }

  const xblobPayload = handler(opts, stdinData);
  const intentName = opts.intentArg || 'ui.Copy';

  const { X, root } = await x11.createClientWithPromises();
  await connectToRouter(X, root);
  if (!xintent.routerWin) {
    console.error('Error: Could not connect to XINTENT router.');
    process.exit(1);
  }

  const targetApp = await promptForTargetAppIfNeeded(
    X, intentName, opts.targetAppArg, opts.selectAppArg, xblobPayload.name
  );

  const clientWin = await createClientWindow(X, root, 'final-copy-pro');
  const dataBlob = await XBlobCreate(X, xintent.routerWin, clientWin, xblobPayload);

  console.log(`Sending intent '${intentName}' to '${targetApp || 'all'}' (dataBlob: ${dataBlob})...`);
  await sendXIntentIntentV0(X, xintent.routerWin, {
    senderWin: clientWin,
    dataBlob: dataBlob,
    payload: {
      intent: intentName,
      app: targetApp || undefined,
      name: xblobPayload.name,
      mimeType: xblobPayload.type,
      size: xblobPayload.size,
    },
  });

  console.log(`[${intentName}] Successfully sent ${xblobPayload.name || xblobPayload.xblobType} (${xblobPayload.type}) to '${targetApp || 'default'}'.`);
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  console.error('[final-copy-pro] Error:', err);
  process.exit(1);
});
