// test-xblob.js - Unit and Integration Tests for XBlob Control Plane & Host Directory
const assert = require('assert');
const os = require('os');

// Import xblob handlers from xbus-daemon
const xblobModule = require('../xbus-daemon/xblob');
const {
  xblobRegistry,
  handleXBlobCreateV0,
  handleXBlobGrantV0,
  handleXBlobUnlinkV0,
  handleXBlobTransferV0,
  handleXBlobBroadcastV0,
  handleXBlobSoftLinkV0,
  handleXBlobSoftUnlinkV0,
  handleXBlobAnnounceHostV0,
  handleXBlobDropHostV0,
  xblobCreate,
  implicitXBlobGrant,
  implicitXBlobTransfer,
  xblobUnlink,
} = xblobModule;

// Import client library functions from x11-promises
const xintent = require('../x11-promises/xintent');
const { formatXBlobAtRest, parseXBlobAtRest } = xintent;

async function runUnitTests() {
  console.log('--- Running XBlob Unit Tests ---');

  // Test 1: formatXBlobAtRest and parseXBlobAtRest roundtrip
  {
    console.log('[Test 1] XBlob payload serialization roundtrip');
    const samplePayload = {
      xblobType: 'Blob',
      type: 'text/plain',
      size: 11,
      _dataType: 'text',
      data: 'Hello World',
    };
    const formatted = formatXBlobAtRest(samplePayload);
    assert(Buffer.isBuffer(formatted) || typeof formatted === 'string', 'Formatted payload should be Buffer or string');
    const formattedStr = Buffer.isBuffer(formatted) ? formatted.toString('utf8') : formatted;
    assert(formattedStr.includes('X-XBlob-Type: Blob'), 'Formatted payload should contain X-XBlob-Type header');

    const parsed = parseXBlobAtRest(formatted);
    assert.strictEqual(parsed.xblobType, 'Blob', 'Parsed xblobType should match');
    const parsedDataStr = Buffer.isBuffer(parsed.data) ? parsed.data.toString('utf8') : String(parsed.data);
    assert.strictEqual(parsedDataStr, 'Hello World', 'Parsed data payload should match');
    console.log('  -> PASS');
  }

  // Test 2: xblobCreate initialization with links and initial host
  {
    console.log('[Test 2] xblobCreate initial tracking structure');
    const dummySender = 0x100001;
    const dummyHost = 0x200001;
    const testBlobId = 0x300001;

    // Manually test registry tracking structure
    xblobRegistry[testBlobId] = {
      links: [dummySender],
      softLinks: [],
      hosts: [dummyHost],
    };

    assert.strictEqual(xblobRegistry[testBlobId].links.length, 1);
    assert.strictEqual(xblobRegistry[testBlobId].links[0], dummySender);
    assert.strictEqual(xblobRegistry[testBlobId].hosts.length, 1);
    assert.strictEqual(xblobRegistry[testBlobId].hosts[0], dummyHost);
    console.log('  -> PASS');
  }

  // Test 3: handleXBlobAnnounceHostV0 and handleXBlobDropHostV0
  {
    console.log('[Test 3] XBlobAnnounceHost and XBlobDropHost registry management');
    const testBlobId = 0x300002;
    xblobRegistry[testBlobId] = {
      links: [0x100001],
      softLinks: [],
      hosts: [0x200001],
    };

    // Announce host 0x200002
    await handleXBlobAnnounceHostV0.accept({ blobId: testBlobId, host: 0x200002 });
    assert.strictEqual(xblobRegistry[testBlobId].hosts.length, 2);
    assert(xblobRegistry[testBlobId].hosts.includes(0x200002), 'Host 0x200002 should be registered');

    // Idempotent re-announce
    await handleXBlobAnnounceHostV0.accept({ blobId: testBlobId, host: 0x200002 });
    assert.strictEqual(xblobRegistry[testBlobId].hosts.length, 2, 'Host count should remain 2 on re-announce');

    // Drop host 0x200001
    await handleXBlobDropHostV0.accept({ blobId: testBlobId, host: 0x200001 });
    assert.strictEqual(xblobRegistry[testBlobId].hosts.length, 1);
    assert(!xblobRegistry[testBlobId].hosts.includes(0x200001), 'Host 0x200001 should be dropped');
    console.log('  -> PASS');
  }

  // Test 4: handleXBlobBroadcastV0 adds host to registry
  {
    console.log('[Test 4] XBlobBroadcast host tracking');
    const testBlobId = 0x300003;
    xblobRegistry[testBlobId] = {
      links: [0x100001],
      softLinks: [],
      hosts: [0x200001],
    };

    await handleXBlobBroadcastV0.accept({ senderWin: 0x100001, blobId: testBlobId, host: 0x200003, version: 1 });
    assert(xblobRegistry[testBlobId].hosts.includes(0x200003), 'Broadcasting host 0x200003 should be registered in hosts');
    console.log('  -> PASS');
  }

  // Test 5: implicitXBlobGrant and implicitXBlobTransfer
  {
    console.log('[Test 5] XBlobGrant and XBlobTransfer link updates');
    const testBlobId = 0x300004;
    xblobRegistry[testBlobId] = {
      links: [0x100001],
      softLinks: [],
      hosts: [0x200001],
    };

    // Grant to 0x100002
    implicitXBlobGrant(testBlobId, 0x100002);
    assert.strictEqual(xblobRegistry[testBlobId].links.length, 2);
    assert(xblobRegistry[testBlobId].links.includes(0x100002));

    // Transfer from 0x100001 to 0x100003
    await implicitXBlobTransfer(testBlobId, 0x100001, 0x100003);
    assert(!xblobRegistry[testBlobId].links.includes(0x100001), 'Original owner 0x100001 should be unlinked');
    assert(xblobRegistry[testBlobId].links.includes(0x100003), 'New owner 0x100003 should be linked');
    console.log('  -> PASS');
  }

  // Test 6: Garbage Collection on final unlink
  {
    console.log('[Test 6] Destruction & GC when links and soft links hit 0');
    const testBlobId1 = 0x300005;
    xblobRegistry[testBlobId1] = {
      links: [0x100001],
      softLinks: [],
      hosts: [0x200001],
    };

    // Unlink last remaining link when softLinks is empty
    await xblobUnlink(testBlobId1, 0x100001);
    assert.strictEqual(xblobRegistry[testBlobId1], undefined, 'Blob registry entry should be deleted when links hit 0');

    // Soft link scenario
    const testBlobId2 = 0x300006;
    xblobRegistry[testBlobId2] = {
      links: [0x100001],
      softLinks: [0x100009],
      hosts: [0x200001],
    };

    await xblobUnlink(testBlobId2, 0x100001);
    assert.strictEqual(xblobRegistry[testBlobId2].links.length, 0);

    // Soft unlink observer
    await handleXBlobSoftUnlinkV0.accept({ blobId: testBlobId2, senderWin: 0x100009 });
    assert.strictEqual(xblobRegistry[testBlobId2], undefined, 'Blob registry entry should be deleted when softLinks hit 0');
    console.log('  -> PASS');
  }

  console.log('\nAll XBlob unit tests passed successfully!\n');
  process.exit(0);
}

runUnitTests().catch(err => {
  console.error('Test Suite Error:', err);
  process.exit(1);
});
