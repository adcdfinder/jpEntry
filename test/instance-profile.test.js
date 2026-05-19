const test = require('node:test');
const assert = require('node:assert/strict');

const {
  partitionForProfile,
  profileKeyForKiosk,
  sanitizeProfileKey,
  zoneForUrl,
} = require('../instance-profile');
const {
  KIOSK_ZONES,
} = require('../otp-autofill');

test('maps known Red and Yellow zone URLs to stable profile keys', () => {
  assert.equal(
    profileKeyForKiosk('http://192.168.88.250:8080/core/auth/login/', { zones: KIOSK_ZONES }),
    'red'
  );
  assert.equal(
    profileKeyForKiosk('http://192.168.20.250:80/core/auth/login/', { zones: KIOSK_ZONES }),
    'yellow'
  );
  assert.equal(
    profileKeyForKiosk('http://192.168.20.250/core/auth/login/', { zones: KIOSK_ZONES }),
    'yellow'
  );
});

test('builds separate persistent partitions for each kiosk profile', () => {
  assert.equal(partitionForProfile('red'), 'persist:kiosk-red');
  assert.equal(partitionForProfile('yellow'), 'persist:kiosk-yellow');
  assert.notEqual(partitionForProfile('red'), partitionForProfile('yellow'));
});

test('uses a deterministic custom profile for non-zone URLs', () => {
  const first = profileKeyForKiosk('https://example.com/app', { zones: KIOSK_ZONES });
  const second = profileKeyForKiosk('https://example.com/other', { zones: KIOSK_ZONES });

  assert.match(first, /^custom-[a-f0-9]{12}$/);
  assert.equal(first, second);
});

test('sanitizes profile keys for partition names', () => {
  assert.equal(sanitizeProfileKey(' Red Zone '), 'red-zone');
  assert.equal(sanitizeProfileKey(''), 'default');
});

test('finds the configured kiosk zone from normalized URL origin', () => {
  assert.equal(
    zoneForUrl('http://192.168.20.250:80/ui/', KIOSK_ZONES).key,
    'yellow'
  );
  assert.equal(zoneForUrl('https://192.168.20.250/ui/', KIOSK_ZONES), null);
});
