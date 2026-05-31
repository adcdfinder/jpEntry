const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyResolutionToGuacamoleUrl,
  effectiveResolution,
  formatResolution,
  isConnectionTokenUrl,
  normalizeResolutionSetting,
  resolutionOverrideFromSetting,
  withResolutionConnectOption,
} = require('../resolution-settings');

test('normalizes custom and invalid resolution settings', () => {
  assert.deepEqual(
    normalizeResolutionSetting({ mode: 'custom', width: '2560', height: '1440' }),
    { mode: 'custom', width: 2560, height: 1440 }
  );

  assert.deepEqual(
    normalizeResolutionSetting({ mode: 'custom', width: '12', height: 'abc' }),
    { mode: 'auto', width: 0, height: 0 }
  );
});

test('computes display and explicit resolution overrides', () => {
  assert.equal(
    resolutionOverrideFromSetting({ mode: 'display' }, { width: 1920, height: 1080 }),
    '1920x1080'
  );
  assert.deepEqual(
    effectiveResolution({ mode: 'preset', width: 3840, height: 2160 }),
    { width: 3840, height: 2160 }
  );
  assert.equal(formatResolution('2560x1440'), '2560x1440');
});

test('rewrites only Lion connect websocket resolution params', () => {
  const original = 'wss://jump.example/lion/ws/connect/?TOKEN_ID=abc&GUAC_WIDTH=800';
  const rewritten = applyResolutionToGuacamoleUrl(original, '2560x1440');
  const url = new URL(rewritten);

  assert.equal(url.searchParams.get('TOKEN_ID'), 'abc');
  assert.equal(url.searchParams.get('GUAC_WIDTH'), '2560');
  assert.equal(url.searchParams.get('GUAC_HEIGHT'), '1440');
  assert.equal(
    applyResolutionToGuacamoleUrl('wss://jump.example/lion/ws/monitor/?SESSION_ID=1', '2560x1440'),
    'wss://jump.example/lion/ws/monitor/?SESSION_ID=1'
  );
});

test('patches JumpServer connection token bodies with a custom resolution', () => {
  const body = JSON.stringify({
    asset: 'asset-id',
    connect_options: {
      resolution: 'auto',
      charset: 'default',
    },
  });
  const patched = JSON.parse(withResolutionConnectOption(body, '2560x1440'));

  assert.equal(patched.connect_options.resolution, '2560x1440');
  assert.equal(patched.connect_options.charset, 'default');
  assert.equal(
    isConnectionTokenUrl('/api/v1/authentication/admin-connection-token/', 'https://jump.example'),
    true
  );
});
