const express = require('express');
const path = require('path');
const { spawn } = require('child_process');

const app = express();

app.use(express.json());

// Enable CORS for external HTML cards fetching from localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// -----------------------------------------------------------------------------
// 1. Deliver matchbox202x.js from the same directory
// -----------------------------------------------------------------------------
app.get('/matchbox202x.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'matchbox202x.js'));
});

// -----------------------------------------------------------------------------
// 2. Intent Gateway: POST /intent/:namespace/:action
// -----------------------------------------------------------------------------
app.post('/intent/:namespace/:action', (req, res) => {
  const { namespace, action } = req.params;
  const targetApp = req.query.app || 'localhost';
  const intentName = `${namespace}.${action}`;
  const payload = req.body;

  console.log(`[INTENT] ${intentName} -> Target: ${targetApp}`);

  // Set multipart response headers for streaming updates + final payload
  res.setHeader('Content-Type', 'multipart/mixed; boundary=intent_boundary');
  res.setHeader('Libplatform-Bridge', '1.0');

  // Emit initial processing status chunk
  res.write(`--intent_boundary\r\nContent-Type: application/json\r\n\r\n`);
  res.write(JSON.stringify({ intent: `${intentName}Processing`, status: "dispatched" }) + '\r\n');

  // Dispatch via local libplatform CLI executable
  const child = spawn('libplatform', [
    '--app', targetApp,
    '--intent', intentName,
    '--data', JSON.stringify(payload)
  ]);

  child.stdout.on('data', (data) => {
    res.write(`--intent_boundary\r\nContent-Type: application/json\r\n\r\n`);
    res.write(data);
  });

  child.on('close', (code) => {
    res.write(`\r\n--intent_boundary--\r\n`);
    res.end();
  });
});

app.listen(12345, () => {
  console.log('matchbox202x intent server running on http://localhost:12345');
});