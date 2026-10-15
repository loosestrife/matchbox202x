const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const TOML = require('@iarna/toml');

const { packageRegistry, buildRegistries } = require('../package-registry');
const { getApps, routeApp } = require('../route-app');

test('Package Registry loads matchbox.toml apps', () => {
  buildRegistries();
  const apps = getApps();
  assert.ok(typeof apps === 'object', 'getApps should return an object');
  assert.ok('intent-test-card' in apps, 'intent-test-card should be registered');
  assert.equal(apps['cool-amp'].name, 'Cool Amp');
  assert.equal(apps['intent-test-card'].name, 'intent-test-card');
});

test('TOML manifest parsing produces valid app metadata', () => {
  const sampleToml = `
[app]
id = "test-app"
name = "Test App"
description = "Unit Test Application"

[[cards]]
id = "main"
path = "index.html"
`;

  const parsed = TOML.parse(sampleToml);
  assert.equal(parsed.app.id, 'test-app');
  assert.equal(parsed.app.name, 'Test App');
  assert.equal(parsed.cards[0].id, 'main');
});

test('routeApp blocks directory traversal attacks', () => {
  buildRegistries();
  const req = {
    params: {
      app: 'intent-test-card',
      path: '../../../../etc/passwd',
    },
  };
  const res = {
    sendFile: () => {
      assert.fail('Should not send file on directory traversal attempt');
    },
  };

  assert.throws(
    () => {
      routeApp(req, res);
    },
    (err) => {
      return err.httpCode === 403 && err.message.includes('Access denied');
    },
    'Should throw 403 HttpError on path traversal attempt'
  );
});
