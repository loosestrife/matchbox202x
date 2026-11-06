// xintent-router.js for xbus-daemon
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xintent-router' });
const xintent = require('../x11-promises/xintent');
const daemon = require('./index');
const xblob = require('./xblob');
const xchannel = require('./xchannel');
const registry = require('./xintent-registry');
const { evaluateRoutePolicy } = require('./xintent-policy');
const { cleanupDestroyedWindow } = require('./xintent-cleanup');

const intentsAwaitingServicesQueue = {}; // intent -> [xchannelFrame]
const liveMigrateSessions = new Map();   // oldCardWin -> { channelObj, oldCardWin, remoteWin, remoteRuntimeWin, initiatorWin }
const pendingMigrationAckWaiters = new Map(); // key -> resolveFn

function waitForMigrationAck(key, timeoutMs = 800) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingMigrationAckWaiters.delete(key);
      resolve({ timedOut: true, key });
    }, timeoutMs);
    pendingMigrationAckWaiters.set(key, (payload) => {
      clearTimeout(timer);
      pendingMigrationAckWaiters.delete(key);
      resolve({ timedOut: false, key, payload });
    });
  });
}

function resolveMigrationAck(parsedPayload) {
  if (!parsedPayload) return;
  if (parsedPayload.channel !== undefined) {
    const chKey = `channel:${parsedPayload.channel}`;
    if (pendingMigrationAckWaiters.has(chKey)) {
      pendingMigrationAckWaiters.get(chKey)(parsedPayload);
    }
  }
  const blobKeyVal = parsedPayload.blobId || parsedPayload.virtualBlobId || parsedPayload.nattedBlobId;
  if (blobKeyVal !== undefined) {
    const numId = parseWindowId(blobKeyVal);
    const bKey = `blob:${numId}`;
    if (pendingMigrationAckWaiters.has(bKey)) {
      pendingMigrationAckWaiters.get(bKey)(parsedPayload);
    }
  }
}

async function checkToDrainIntentsQueue(intentName) {
  const queue = intentsAwaitingServicesQueue[intentName];
  while (queue && queue.length) {
    tryToForwardTheFrame(queue.shift());
  }
}
registry.initXIntentRegistry({ checkToDrainIntentsQueue });

function formatActionString(xchannelFrame, ev) {
  return xintent.frameType(xchannelFrame || ev);
}

const handleXIntentIntentV0 = {
  parse: async (ev) => xintent.parseXIntentIntentV0(daemon.X, daemon.routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (xchannelFrame, ev) => ({
    source: { window: xchannelFrame.senderWin },
    action: formatActionString(xchannelFrame, ev),
    resources: [],
  }),
  accept: async (xchannelFrame) => {
    await tryToForwardTheFrame(xchannelFrame);
  },
};

const handleForwardingOfXChannelJsonFrame = {
  parse: async (ev) => xintent.parseXIntentEventV0(daemon.X, daemon.routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (xchannelFrame, ev) => ({
    source: { window: xchannelFrame.senderWin },
    action: formatActionString(xchannelFrame, ev),
  }),
  accept: async (xchannelFrame) => {
    await tryToForwardTheFrame(xchannelFrame);
  },
};
const handleXIntentEventV0 = handleForwardingOfXChannelJsonFrame;

function parseFramePayloadAndIntent(payload) {
  let parsedPayload = payload;
  if (typeof payload === 'string') {
    try {
      parsedPayload = JSON.parse(payload);
    } catch (_) {
      parsedPayload = payload;
    }
  }
  const direct = parsedPayload?.intent || parsedPayload?.event || parsedPayload?.action;
  const nested = (parsedPayload?.data && typeof parsedPayload.data === 'object')
    ? (parsedPayload.data.intent || parsedPayload.data.event || parsedPayload.data.action)
    : undefined;
  return { parsedPayload, intent: direct || nested };
}

function resolveOrCreateFrameChannel(xchannelFrame, intent, parsedPayload = null) {
  const { senderWin, channel } = xchannelFrame;
  const controlWord = xchannelFrame.controlWord ?? 3;
  const isSyn = (controlWord & 1) !== 0;

  let channelObj = isSyn ? (xchannel.getChannel(senderWin, channel) || xchannel.newChannel(senderWin, channel, xchannelFrame)) : null;
  if (!channelObj && intent) {
    channelObj = xchannel.createVirtualChannel(senderWin, xchannelFrame);
  }
  if (channelObj && parsedPayload) {
    const connHeader = String(parsedPayload.Connection || parsedPayload.connection || parsedPayload.headers?.Connection || parsedPayload.headers?.connection || '').toLowerCase();
    if (connHeader === 'keep-alive' || parsedPayload.keepChannelOpen === true) {
      channelObj.keepAlive = true;
    }
  }
  if (channelObj && xchannel.corkedWindows.has(senderWin) && !xchannel.isLiveMigrateChannel(channelObj)) {
    channelObj.corkedForWin = senderWin;
    channelObj.corkQueue = channelObj.corkQueue || [];
  }
  return channelObj;
}

async function dispatchMatchedIntent(policyResult, xchannelFrame, channelObj, actionStr) {
  const { selectedEntry, targetAppId } = policyResult;
  const { wid } = selectedEntry;
  logger.info(`[intent-router] Found service window (${xintent.widString(wid)}) for ${actionStr} (target app: ${targetAppId || 'any'})`);
  if (channelObj) {
    channelObj.handlerWin = wid;
  }
  await sendXIntentIntentV0(daemon.X, daemon.routerWin, {
    targetWin: wid,
    senderWin: daemon.routerWin,
    ...xchannel.getChannelToSend(wid, channelObj),
    payload: xchannelFrame.payload,
    payloadBlob: xchannelFrame.payloadBlob,
    dataBlob: xchannelFrame.dataBlob,
  });

  if (channelObj && channelObj.isVirtual) {
    logger.info(`Passed on message for ${channelObj.virtualSender}. Deleting transient virtual channel 0.`);
  }
}

function parseWindowId(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val >>> 0;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    const n = (trimmed.startsWith('0x') || trimmed.startsWith('0X')) ? parseInt(trimmed, 16) : Number(trimmed);
    return isNaN(n) ? 0 : (n >>> 0);
  }
  return 0;
}

async function executeLiveMigrateCommit({ xchannelFrame, parsedPayload, channelObj }) {
  const oldCardWin = parseWindowId(parsedPayload?.oldCardWin || parsedPayload?.cardWin) || xchannelFrame.senderWin;
  const session = liveMigrateSessions.get(oldCardWin);
  const newCardWin = parseWindowId(parsedPayload?.newCardWin || parsedPayload?.remoteWin) || session?.remoteWin;
  const remoteRuntimeWin = parseWindowId(parsedPayload?.remoteRuntimeWin) || session?.remoteRuntimeWin || newCardWin;

  if (!oldCardWin || !newCardWin) {
    logger.warn(`[live-migrate] sys.LiveMigrateCommit missing oldCardWin (${oldCardWin}) or newCardWin (${newCardWin})`);
    if (channelObj) {
      await xintent.sendXIntentEventV0(daemon.X, daemon.routerWin, {
        targetWin: xchannelFrame.senderWin,
        senderWin: daemon.routerWin,
        controlWord: 2,
        ...xchannel.getChannelToSend(xchannelFrame.senderWin, channelObj),
        payload: {
          event: 'sys.LiveMigrateCommitResponse',
          status: 'error',
          message: 'Missing oldCardWin or newCardWin',
        },
      });
      xchannel.closeChannel(channelObj);
    }
    return;
  }

  logger.info(
    `[live-migrate] Executing sys.LiveMigrateCommit: ${xintent.widString(oldCardWin)} -> ${xintent.widString(newCardWin)} (runtime: ${xintent.widString(remoteRuntimeWin)})`
  );

  const excludeBlobSet = new Set(
    (Array.isArray(parsedPayload?.excludeBlobs) ? parsedPayload.excludeBlobs : [])
      .map(parseWindowId)
      .filter(Boolean)
  );
  if (parsedPayload?.stateBlobId) {
    const sb = parseWindowId(parsedPayload.stateBlobId);
    if (sb) {
      excludeBlobSet.add(sb);
      xblob.implicitXBlobGrant(sb, newCardWin);
      if (remoteRuntimeWin && remoteRuntimeWin !== newCardWin) {
        xblob.xblobUnlink(sb, remoteRuntimeWin).catch(() => {});
      }
    }
  }

  // Build reverse NAT maps from old card's NAT table if it was already remapped once
  const reverseOldBlobNat = new Map();
  const rawBlobNat = parsedPayload?.natTables?.blobNat || parsedPayload?.blobNatTable || {};
  for (const [virtKey, locVal] of Object.entries(rawBlobNat)) {
    const vId = parseWindowId(virtKey);
    const lId = parseWindowId(locVal);
    if (vId && lId) reverseOldBlobNat.set(lId, vId);
  }

  const reverseOldChannelNat = new Map();
  const rawChannelNat = parsedPayload?.natTables?.channelNat || parsedPayload?.channelNatTable || {};
  for (const [virtTx, locTx] of Object.entries(rawChannelNat)) {
    const vTx = Number(virtTx);
    const lTx = Number(locTx);
    if (!isNaN(vTx) && !isNaN(lTx)) reverseOldChannelNat.set(lTx, vTx);
  }

  // 1. Redirect active channels and notify both ends
  const migratedChannels = xchannel.migrateWindowChannels(oldCardWin, newCardWin);
  const extraOpenChannels = Array.isArray(parsedPayload?.openChannels) ? parsedPayload.openChannels : [];
  for (const extraCh of extraOpenChannels) {
    const txId = Number(extraCh?.txId ?? extraCh);
    if (!isNaN(txId) && txId > 0 && !migratedChannels.some((c) => c.txId === txId || c.channelNum === txId)) {
      const foundCh = Object.values(xchannel.activeChannels).find(
        (c) => !xchannel.isLiveMigrateChannel(c) && (c.senderCookie === txId || c.channelNum === txId)
      );
      if (foundCh) {
        if (foundCh.senderWin !== newCardWin && foundCh.handlerWin !== newCardWin) {
          foundCh.senderWin = newCardWin;
          if (!xchannel.txidToChannel[newCardWin]) xchannel.txidToChannel[newCardWin] = {};
          xchannel.txidToChannel[newCardWin][foundCh.senderCookie] = foundCh;
        }
        migratedChannels.push({
          channelNum: foundCh.channelNum,
          role: foundCh.handlerWin === newCardWin ? 'handler' : 'sender',
          txId: foundCh.senderCookie || txId,
          intent: foundCh.intent,
          otherEndWin: foundCh.handlerWin === newCardWin ? foundCh.senderWin : foundCh.handlerWin,
        });
      }
    }
  }

  const ackPromises = [];

  for (const ch of migratedChannels) {
    if (ch.otherEndWin && ch.otherEndWin !== daemon.routerWin && ch.otherEndWin !== oldCardWin && ch.otherEndWin !== newCardWin) {
      try {
        await xintent.sendXIntentEventV0(daemon.X, daemon.routerWin, {
          targetWin: ch.otherEndWin,
          senderWin: daemon.routerWin,
          channel: ch.channelNum,
          controlWord: 0,
          payload: {
            event: 'sys.ChannelRedirected',
            intent: 'sys.ChannelRedirected',
            channel: ch.channelNum,
            txId: ch.txId,
            intentName: ch.intent,
            oldCardWin: xintent.widString(oldCardWin),
            newCardWin: xintent.widString(newCardWin),
          },
        });
        logger.info(`[live-migrate] Sent courtesy sys.ChannelRedirected for channel ${ch.channelNum} to ${xintent.widString(ch.otherEndWin)}`);
      } catch (err) {
        logger.warn(`[live-migrate] Failed sending sys.ChannelRedirected: ${err.message}`);
      }
    }

    const cardTxId = reverseOldChannelNat.get(ch.txId) ?? ch.txId;
    const redirectPayload = {
      intent: 'sys.ChannelRedirect',
      event: 'sys.ChannelRedirect',
      channel: ch.channelNum,
      txId: cardTxId,
      cardTxId,
      localChannelId: ch.txId,
      role: ch.role,
      intentName: ch.intent,
      oldCardWin: xintent.widString(oldCardWin),
      newCardWin: xintent.widString(newCardWin),
      remoteWin: xintent.widString(newCardWin),
    };

    ackPromises.push(waitForMigrationAck(`channel:${ch.channelNum}`, 800));
    await sendXIntentIntentV0(daemon.X, daemon.routerWin, {
      targetWin: newCardWin,
      senderWin: daemon.routerWin,
      txId: 0,
      controlWord: 1,
      payload: redirectPayload,
    });
    if (remoteRuntimeWin && remoteRuntimeWin !== newCardWin) {
      await sendXIntentIntentV0(daemon.X, daemon.routerWin, {
        targetWin: remoteRuntimeWin,
        senderWin: daemon.routerWin,
        txId: 0,
        controlWord: 1,
        payload: redirectPayload,
      });
    }
  }

  // 2. Transfer XBlobs and send sys.XBlobTransferred with NATted blob ID in dataBlob
  const { migratedLinks, migratedSoftLinks, migratedDetails } = xblob.migrateWindowBlobs(oldCardWin, newCardWin);
  const extraHeldBlobs = Array.isArray(parsedPayload?.heldBlobs) ? parsedPayload.heldBlobs : [];
  for (const hb of extraHeldBlobs) {
    const hbId = parseWindowId(hb);
    if (!hbId || excludeBlobSet.has(hbId)) continue;
    const regEntry = xblob.xblobRegistry[hbId];
    if (regEntry && !migratedDetails.some((d) => xblob.xblobRegistry[d.blobId] === regEntry)) {
      if (!regEntry.links.includes(newCardWin)) {
        regEntry.links.push(newCardWin);
      }
      regEntry.links = regEntry.links.filter((w) => w !== oldCardWin);
      migratedLinks.push(hbId);
      migratedDetails.push({ blobId: hbId, linkType: 'hard' });
    }
  }

  const transferredBlobsSummary = [];
  for (const item of migratedDetails) {
    const origBlobId = item.blobId;
    if (excludeBlobSet.has(origBlobId)) continue;

    const virtualBlobId = reverseOldBlobNat.get(origBlobId) || origBlobId;
    const nattedBlobId = xblob.linkBlobAlias(origBlobId, null, newCardWin) || origBlobId;
    try {
      await xintent.XBlobWrite(daemon.X, daemon.routerWin, daemon.routerWin, nattedBlobId, {
        aliasOf: origBlobId,
      });
    } catch (_) {}

    const blobTransferPayload = {
      intent: 'sys.XBlobTransferred',
      event: 'sys.XBlobTransferred',
      blobId: xintent.widString(virtualBlobId),
      virtualBlobId: xintent.widString(virtualBlobId),
      oldLocalBlobId: xintent.widString(origBlobId),
      linkType: item.linkType,
      oldCardWin: xintent.widString(oldCardWin),
      newCardWin: xintent.widString(newCardWin),
      remoteWin: xintent.widString(newCardWin),
    };

    ackPromises.push(waitForMigrationAck(`blob:${virtualBlobId}`, 800));
    xblob.implicitXBlobGrant(nattedBlobId, daemon.routerWin);
    await sendXIntentIntentV0(daemon.X, daemon.routerWin, {
      targetWin: newCardWin,
      senderWin: daemon.routerWin,
      txId: 0,
      controlWord: 1,
      payload: blobTransferPayload,
      dataBlob: nattedBlobId,
    });
    if (remoteRuntimeWin && remoteRuntimeWin !== newCardWin) {
      xblob.implicitXBlobGrant(nattedBlobId, daemon.routerWin);
      await sendXIntentIntentV0(daemon.X, daemon.routerWin, {
        targetWin: remoteRuntimeWin,
        senderWin: daemon.routerWin,
        txId: 0,
        controlWord: 1,
        payload: blobTransferPayload,
        dataBlob: nattedBlobId,
      });
    }

    transferredBlobsSummary.push({
      virtualBlobId: xintent.widString(virtualBlobId),
      nattedBlobId: xintent.widString(nattedBlobId),
      linkType: item.linkType,
    });
  }

  if (ackPromises.length > 0) {
    await Promise.all(ackPromises);
  }

  for (const queue of Object.values(intentsAwaitingServicesQueue)) {
    for (const frame of queue) {
      if (frame.senderWin === oldCardWin) {
        frame.senderWin = newCardWin;
      }
    }
  }

  await uncorkAndFlushWindowChannels(newCardWin);
  await xblob.uncorkAndFlushWindowBlobEvents(oldCardWin, newCardWin);

  // Step 5a: Send sys.LiveMigrateCommitResponse to local XHTML runtime / caller
  const commitResponsePayload = {
    event: 'sys.LiveMigrateCommitResponse',
    intent: 'sys.LiveMigrateCommitResponse',
    status: 'ok',
    oldCardWin: xintent.widString(oldCardWin),
    newCardWin: xintent.widString(newCardWin),
    remoteWin: xintent.widString(newCardWin),
    migratedChannels: migratedChannels.map((c) => ({
      channel: c.channelNum,
      txId: c.txId,
      role: c.role,
      intent: c.intent,
    })),
    transferredBlobs: transferredBlobsSummary,
  };

  await xintent.sendXIntentEventV0(daemon.X, daemon.routerWin, {
    targetWin: xchannelFrame.senderWin,
    senderWin: daemon.routerWin,
    controlWord: 2,
    ...xchannel.getChannelToSend(xchannelFrame.senderWin, channelObj),
    payload: commitResponsePayload,
  });
  if (channelObj) {
    xchannel.closeChannel(channelObj);
  }

  // Step 5b: Send sys.LiveMigrateComplete to remote XHTML runtime and newCardWin so it thaws/resumes the card
  const completePayload = {
    event: 'sys.LiveMigrateComplete',
    intent: 'sys.LiveMigrateComplete',
    status: 'ok',
    oldCardWin: xintent.widString(oldCardWin),
    newCardWin: xintent.widString(newCardWin),
    remoteWin: xintent.widString(newCardWin),
    migratedChannels: commitResponsePayload.migratedChannels,
    transferredBlobs: transferredBlobsSummary,
  };

  const notifiedRuntimeWins = new Set();
  if (remoteRuntimeWin) {
    notifiedRuntimeWins.add(remoteRuntimeWin);
    await sendXIntentIntentV0(daemon.X, daemon.routerWin, {
      targetWin: remoteRuntimeWin,
      senderWin: daemon.routerWin,
      txId: session?.channelObj?.channelNum || 0,
      controlWord: 2,
      payload: completePayload,
    });
  }
  if (newCardWin && !notifiedRuntimeWins.has(newCardWin)) {
    notifiedRuntimeWins.add(newCardWin);
    await sendXIntentIntentV0(daemon.X, daemon.routerWin, {
      targetWin: newCardWin,
      senderWin: daemon.routerWin,
      txId: 0,
      controlWord: 2,
      payload: completePayload,
    });
  }
  const allRuntimeEntries = registry.intentRegistry['xhtml.LiveMigrate'] || [];
  for (const rtEntry of allRuntimeEntries) {
    const rtWin = typeof rtEntry === 'object' ? rtEntry.wid : rtEntry;
    if (rtWin && !notifiedRuntimeWins.has(rtWin)) {
      notifiedRuntimeWins.add(rtWin);
      await sendXIntentIntentV0(daemon.X, daemon.routerWin, {
        targetWin: rtWin,
        senderWin: daemon.routerWin,
        txId: 0,
        controlWord: 2,
        payload: completePayload,
      });
    }
  }
  if (session?.channelObj && session.channelObj.intent === 'sys.LiveMigrate') {
    xchannel.closeChannel(session.channelObj);
  }
  liveMigrateSessions.delete(oldCardWin);
}

const tryToForwardTheFrame = async (xchannelFrame) => {
  const actionStr = formatActionString(xchannelFrame);
  const { parsedPayload, intent } = parseFramePayloadAndIntent(xchannelFrame.payload);

  if (intent === 'sys.ChannelRedirectResponse' || intent === 'sys.XBlobTransferredResponse') {
    resolveMigrationAck(parsedPayload);
    return;
  }

  const existingChannel = xchannel.getChannelForMessage(xchannelFrame);
  if (existingChannel && (await forwardMessageToChannel(existingChannel, xchannelFrame))) {
    return;
  }

  if (xchannelFrame.messageTypeAtom === xintent.atoms.XINTENT_EVENT_V0) {
    logger.info(`Dropping XINTENT_EVENT_V0 frame on closed/inactive channel: ${actionStr}`);
    return;
  }

  const channelObj = resolveOrCreateFrameChannel(xchannelFrame, intent, parsedPayload);
  if (!intent) {
    logger.info(`dropping xchannel frame without active channel ${actionStr}`, xchannelFrame);
    return;
  }

  if (intent === 'sys.BeginLiveMigrate') {
    const cardWin = parseWindowId(parsedPayload?.cardWin || parsedPayload?.oldCardWin) || xchannelFrame.senderWin;
    let corkedChannels = [];
    if (cardWin) {
      xchannel.beginLiveMigrateWindows.add(cardWin);
      corkedChannels = xchannel.corkWindowChannels(cardWin);
      xblob.corkWindowBlobEvents(cardWin);
    }
    logger.info(`[live-migrate] sys.BeginLiveMigrate corked window ${xintent.widString(cardWin)} (channels: ${corkedChannels.join(', ') || 'none'})`);
    await xintent.sendXIntentEventV0(daemon.X, daemon.routerWin, {
      targetWin: xchannelFrame.senderWin,
      senderWin: daemon.routerWin,
      controlWord: 2,
      ...xchannel.getChannelToSend(xchannelFrame.senderWin, channelObj),
      payload: {
        event: 'sys.BeginLiveMigrateResponse',
        intent: 'sys.BeginLiveMigrateResponse',
        status: 'ok',
        cardWin: xintent.widString(cardWin),
        corkedChannels,
      },
    });
    if (channelObj) xchannel.closeChannel(channelObj);
    return;
  }

  if (intent === 'sys.LiveMigrateCommit') {
    executeLiveMigrateCommit({ xchannelFrame, parsedPayload, channelObj }).catch((err) => {
      logger.error(`Error in executeLiveMigrateCommit: ${err.message}`);
    });
    return;
  }

  if (intent === 'sys.TraceRoute') {
    const chNum = Number(parsedPayload?.channel || 0);
    const chObj = xchannel.activeChannels[chNum];
    const hops = [
      xintent.widString(xchannelFrame.senderWin),
      xintent.widString(daemon.routerWin),
      ...(chObj?.handlerWin ? [xintent.widString(chObj.handlerWin)] : []),
    ];
    await xintent.sendXIntentEventV0(daemon.X, daemon.routerWin, {
      targetWin: xchannelFrame.senderWin,
      senderWin: daemon.routerWin,
      controlWord: 2,
      ...xchannel.getChannelToSend(xchannelFrame.senderWin, channelObj),
      payload: {
        event: 'sys.TraceRouteResponse',
        status: 'ok',
        channel: chNum,
        hops,
        hairpin: false,
      },
    });
    if (channelObj) xchannel.closeChannel(channelObj);
    return;
  }

  if (intent === 'sys.AdjustChannel') {
    const chNum = Number(parsedPayload?.channel || 0);
    const newTarget = parseWindowId(parsedPayload?.targetWin || parsedPayload?.newCardWin);
    if (chNum && newTarget) {
      xchannel.redirectChannel(chNum, newTarget);
    }
    await xintent.sendXIntentEventV0(daemon.X, daemon.routerWin, {
      targetWin: xchannelFrame.senderWin,
      senderWin: daemon.routerWin,
      controlWord: 2,
      ...xchannel.getChannelToSend(xchannelFrame.senderWin, channelObj),
      payload: {
        event: 'sys.AdjustChannelResponse',
        status: 'ok',
        channel: chNum,
      },
    });
    if (channelObj) xchannel.closeChannel(channelObj);
    return;
  }

  if (intent === 'xhtml.LiveMigrate' || intent === 'sys.LiveMigrate') {
    const migratingWin = parseWindowId(parsedPayload?.oldCardWin || parsedPayload?.cardWin) || xchannelFrame.senderWin;
    if (migratingWin) {
      xchannel.corkWindowChannels(migratingWin);
      xblob.corkWindowBlobEvents(migratingWin);
      liveMigrateSessions.set(migratingWin, {
        channelObj,
        oldCardWin: migratingWin,
        initiatorWin: xchannelFrame.senderWin,
        remoteWin: 0,
        remoteRuntimeWin: 0,
      });
    }
    if (intent === 'sys.LiveMigrate') {
      if (channelObj) channelObj.keepAlive = true;
    }
  }

  const effectiveIntent =
    intent === 'sys.LiveMigrate' &&
    (!registry.intentRegistry['sys.LiveMigrate'] || registry.intentRegistry['sys.LiveMigrate'].length === 0) &&
    registry.intentRegistry['xhtml.LiveMigrate']?.length > 0
      ? 'xhtml.LiveMigrate'
      : intent;

  const policyResult = await evaluateRoutePolicy({
    xchannelFrame,
    intent: effectiveIntent,
    parsedPayload,
    intentRegistry: registry.intentRegistry,
    windowRegistry: registry.windowRegistry,
    lighterRegistry: registry.lighterRegistry,
    getAllMatchboxToml: registry.getAllMatchboxToml,
    intentsAwaitingServicesQueue,
    sendXIntentIntentV0,
    X: daemon.X,
    routerWin: daemon.routerWin,
    formatActionString,
  });

  if (policyResult.status === 'matched') {
    await dispatchMatchedIntent(policyResult, xchannelFrame, channelObj, actionStr);
  }
};

function selectChannelSendFn(messageTypeAtom) {
  if (messageTypeAtom === xintent.atoms.XAUDIO_PLAY_RESPONSE_V0) {
    return xintent.sendXAudioPlayResponseV0;
  }
  if (messageTypeAtom === xintent.atoms.XINTENT_EVENT_V0) {
    return xintent.sendXIntentEventV0;
  }
  return xintent.sendXChannelJsonFrame;
}

const forwardMessageToChannel = async (channelObj, message) => {
  if (!channelObj || !channelObj.handlerWin) return false;

  const actionStr = formatActionString(message);
  let forwardTo = null;
  if (message.senderWin == channelObj.handlerWin) {
    forwardTo = channelObj.senderWin;
  } else if (message.senderWin == channelObj.senderWin) {
    forwardTo = channelObj.handlerWin;
  } else {
    logger.info(
      `Message ${actionStr} in channel ${message.channel} was sent by ${xintent.widString(message.senderWin)} not on channel (was the intent redirected?)`,
      message,
      channelObj,
    );
    return true;
  }

  if (channelObj.corkedForWin && forwardTo === channelObj.corkedForWin) {
    channelObj.corkQueue = channelObj.corkQueue || [];
    channelObj.corkQueue.push(message);
    logger.info(
      `[cork] Queued in-flight message ${actionStr} on channel ${channelObj.channelNum} for migrating window ${xintent.widString(forwardTo)} (queue len: ${channelObj.corkQueue.length})`,
    );
    return true;
  }

  const controlWord = message.controlWord ?? 3;
  const dataBlob = message.dataBlob || message.payload?.data_blob || message.payload?.blobId || message.payload?.blob || 0;
  const sendFn = selectChannelSendFn(message.messageTypeAtom);
  const { parsedPayload: msgPayload, intent: msgIntent } = parseFramePayloadAndIntent(message.payload);

  if (msgIntent === 'sys.LiveMigrateResponse' || msgIntent === 'xhtml.LiveMigrateResponse') {
    const oldWin = parseWindowId(msgPayload?.oldCardWin) || channelObj.xintentIntent?.payload?.oldCardWin;
    const oldWinNum = parseWindowId(oldWin);
    const newWinNum = parseWindowId(msgPayload?.remoteWin || msgPayload?.newCardWin);
    if (oldWinNum && liveMigrateSessions.has(oldWinNum)) {
      const sess = liveMigrateSessions.get(oldWinNum);
      sess.remoteWin = newWinNum;
      sess.remoteRuntimeWin = message.senderWin;
    }
  }

  await sendFn(daemon.X, daemon.routerWin, {
    targetWin: forwardTo,
    senderWin: daemon.routerWin,
    controlWord,
    ...xchannel.getChannelToSend(forwardTo, channelObj),
    payload: message.payload,
    payloadBlob: message.payloadBlob,
    dataBlob,
  });

  if ((controlWord & 2) !== 0) {
    const keepOpenForLiveMigrate =
      channelObj.keepAlive &&
      (msgIntent === 'sys.LiveMigrateResponse' || msgIntent === 'term.GetOutStreamResponse');
    if (!keepOpenForLiveMigrate) {
      xchannel.closeChannel(channelObj);
    }
  }
  return true;
};

async function uncorkAndFlushWindowChannels(newWin) {
  for (const channelObj of Object.values(xchannel.activeChannels)) {
    const isTarget = channelObj.corkedForWin === newWin || channelObj.senderWin === newWin || channelObj.handlerWin === newWin;
    if (!isTarget) continue;
    channelObj.corkedForWin = null;
    const queued = channelObj.corkQueue || [];
    channelObj.corkQueue = [];
    for (const queuedMsg of queued) {
      logger.info(`[uncork] Flushing queued frame on channel ${channelObj.channelNum} to ${xintent.widString(newWin)}`);
      await forwardMessageToChannel(channelObj, queuedMsg);
    }
  }
}

const handleXHtmlCorkWindowV0 = {
  parse: async (ev) => ({
    targetWin: ev.wid,
    senderWin: ev.data[0],
    cardWin: ev.data[1] || ev.data[0],
  }),
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XHtmlCorkWindow',
    resources: [{ window: parsed.cardWin }],
  }),
  accept: async ({ cardWin }) => {
    xchannel.corkWindowChannels(cardWin);
    xblob.corkWindowBlobEvents(cardWin);
  },
};

const handleXHtmlMigrateWindowV0 = {
  parse: async (ev) => ({
    targetWin: ev.wid,
    senderWin: ev.data[0],
    oldCardWin: ev.data[1],
    newCardWin: ev.data[2],
  }),
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XHtmlMigrateWindow',
    resources: [{ oldWindow: parsed.oldCardWin, newWindow: parsed.newCardWin }],
  }),
  accept: async ({ oldCardWin, newCardWin }) => {
    if (!oldCardWin || !newCardWin) return;
    logger.info(`Executing atomic window migration: ${xintent.widString(oldCardWin)} -> ${xintent.widString(newCardWin)}`);
    xblob.migrateWindowBlobs(oldCardWin, newCardWin);
    xchannel.migrateWindowChannels(oldCardWin, newCardWin);

    for (const queue of Object.values(intentsAwaitingServicesQueue)) {
      for (const frame of queue) {
        if (frame.senderWin === oldCardWin) {
          frame.senderWin = newCardWin;
        }
      }
    }

    await uncorkAndFlushWindowChannels(newCardWin);
    await xblob.uncorkAndFlushWindowBlobEvents(oldCardWin, newCardWin);
  },
};

async function sendXIntentIntentV0(
  X,
  routerWin,
  { targetWin, senderWin, txId, channel, controlWord, payload, payloadBlob, dataBlob },
) {
  if (!payloadBlob) {
    payloadBlob = await xblob.xblobCreate(routerWin);
    await xintent.XBlobWrite(X, routerWin, routerWin, payloadBlob, payload);
  }
  xblob.implicitXBlobTransfer(payloadBlob, routerWin, targetWin);
  if (dataBlob) {
    xblob.implicitXBlobTransfer(dataBlob, routerWin, targetWin);
  }

  const channelToSend = (channel !== undefined && channel !== 0) ? (channel >>> 0) : (txId !== undefined ? (txId >>> 0) : 0);
  const ctrlWordToSend = (controlWord !== undefined ? controlWord : 0) >>> 0;

  await xintent.XClientMessage(X, targetWin, xintent.atoms.XINTENT_INTENT_V0, [
    (senderWin || routerWin) >>> 0,
    channelToSend,
    ctrlWordToSend,
    payloadBlob >>> 0,
    (dataBlob || 0) >>> 0,
  ]);
  logger.info(
    `Dispatched ${payload?.intent || payload?.event} to ${xintent.widString(targetWin)} (channel ${channelToSend}, ctrl ${ctrlWordToSend}, payload blob ${xintent.widString(payloadBlob)})`,
  );
  return payloadBlob;
}

const xintentUnregisterWindow = async (destroyedWin) => {
  await cleanupDestroyedWindow({
    destroyedWin,
    intentRegistry: registry.intentRegistry,
    lighterRegistry: registry.lighterRegistry,
    windowRegistry: registry.windowRegistry,
    lighterAudioRegistry: registry.lighterAudioRegistry,
    intentsAwaitingServicesQueue,
    activeChannels: xchannel.activeChannels,
    unregisterWindowRegistry: registry.unregisterWindowRegistry,
    updateAggregateToml: registry.updateAggregateToml,
    sendXIntentIntentV0,
    getChannelToSend: xchannel.getChannelToSend,
    closeChannel: xchannel.closeChannel,
    tryToForwardTheFrame,
    X: daemon.X,
    routerWin: daemon.routerWin,
  });
};

module.exports = {
  handleXIntentIntentV0,
  handleXIntentEventV0,
  handleForwardingOfXChannelJsonFrame,
  handleXHtmlCorkWindowV0,
  handleXHtmlMigrateWindowV0,
  getAllMatchboxToml: registry.getAllMatchboxToml,
  parseWindowToml: registry.parseWindowToml,
  parseWindowLighterToml: registry.parseWindowLighterToml,
  xintentUnregisterWindow,
};
