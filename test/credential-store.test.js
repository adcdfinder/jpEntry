const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  createCredentialStore,
  emptyCredentialStore,
  normalizeOrigin,
} = require('../credential-store');
const {
  normalizeOtpSecret,
  isValidOtpSecret,
} = require('../otp-autofill');

function createMemoryFs() {
  const files = new Map();

  return {
    files,
    readFileSync(filePath) {
      if (!files.has(filePath)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath);
    },
    mkdirSync() {},
    writeFileSync(filePath, content) {
      files.set(filePath, String(content));
    },
  };
}

function createSafeStorage() {
  return {
    available: true,
    isEncryptionAvailable() {
      return this.available;
    },
    encryptString(value) {
      return Buffer.from('encrypted:' + value, 'utf8');
    },
    decryptString(buffer) {
      const value = buffer.toString('utf8');
      if (!value.startsWith('encrypted:')) throw new Error('bad ciphertext');
      return value.slice('encrypted:'.length);
    },
  };
}

function createTestStore(options = {}) {
  return createCredentialStore({
    fs: options.fs || createMemoryFs(),
    path,
    userDataPath: 'C:\\jp-entry-test',
    safeStorage: options.safeStorage || createSafeStorage(),
    normalizeMfaSecret: normalizeOtpSecret,
    validateMfaSecret: isValidOtpSecret,
    now: options.now || (() => '2026-05-18T00:00:00.000Z'),
  });
}

test('normalizes credential origins by scheme, host, and port', () => {
  assert.equal(
    normalizeOrigin('http://192.168.88.250:8080/core/auth/login/password/'),
    'http://192.168.88.250:8080'
  );
  assert.equal(
    normalizeOrigin('http://192.168.20.250:80/core/auth/login/password/'),
    'http://192.168.20.250'
  );
  assert.equal(normalizeOrigin('not a url'), null);
});

test('returns an empty credential store for missing or invalid files', () => {
  const fs = createMemoryFs();
  const store = createTestStore({ fs });

  assert.deepEqual(store.readCredentialStore(), emptyCredentialStore());

  fs.files.set(store.credentialsFilePath(), '{ broken json');
  assert.deepEqual(store.readCredentialStore(), emptyCredentialStore());
});

test('saves encrypted credentials and reads decrypted credentials back', () => {
  const fs = createMemoryFs();
  const store = createTestStore({ fs });

  assert.equal(store.saveCredential({
    origin: 'http://192.168.88.250:8080/login',
    username: 'admin',
    password: 'secret-password',
    mfaSecret: 'jbsw y3dp ehpk 3pxp',
  }), true);

  const rawStore = JSON.parse(fs.files.get(store.credentialsFilePath()));
  const record = rawStore.credentials['http://192.168.88.250:8080'];
  assert.equal(record.username, 'admin');
  assert.equal(record.password, Buffer.from('encrypted:secret-password').toString('base64'));
  assert.equal(record.mfaSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(record.createdAt, '2026-05-18T00:00:00.000Z');

  assert.deepEqual(store.getCredential('http://192.168.88.250:8080/any/path'), {
    origin: 'http://192.168.88.250:8080',
    username: 'admin',
    password: 'secret-password',
    mfaSecret: 'JBSWY3DPEHPK3PXP',
    updatedAt: '2026-05-18T00:00:00.000Z',
  });
});

test('rejects saves when encryption or MFA secret validation is unavailable', () => {
  const safeStorage = createSafeStorage();
  const store = createTestStore({ safeStorage });

  safeStorage.available = false;
  assert.equal(store.saveCredential({
    origin: 'http://192.168.88.250:8080/login',
    username: 'admin',
    password: 'secret-password',
    mfaSecret: 'JBSWY3DPEHPK3PXP',
  }), false);

  safeStorage.available = true;
  assert.equal(store.saveCredential({
    origin: 'http://192.168.88.250:8080/login',
    username: 'admin',
    password: 'secret-password',
    mfaSecret: 'INVALID!!!INVALID',
  }), false);
});

test('updates credentials while preserving the original creation timestamp', () => {
  const fs = createMemoryFs();
  let timestamp = '2026-05-18T00:00:00.000Z';
  const store = createTestStore({
    fs,
    now: () => timestamp,
  });

  assert.equal(store.saveCredential({
    origin: 'http://192.168.88.250:8080/login',
    username: 'admin',
    password: 'first-password',
    mfaSecret: 'JBSWY3DPEHPK3PXP',
  }), true);

  timestamp = '2026-05-18T01:00:00.000Z';
  assert.equal(store.saveCredential({
    origin: 'http://192.168.88.250:8080/login',
    username: 'admin2',
    password: 'second-password',
    mfaSecret: 'JBSWY3DPEHPK3PXP',
  }), true);

  const record = store.getCredentialRecord('http://192.168.88.250:8080/');
  assert.equal(record.username, 'admin2');
  assert.equal(record.createdAt, '2026-05-18T00:00:00.000Z');
  assert.equal(record.updatedAt, '2026-05-18T01:00:00.000Z');
  assert.equal(store.getCredential('http://192.168.88.250:8080/').password, 'second-password');
});

test('decides whether to prompt for save, MFA, update, or nothing', () => {
  const fs = createMemoryFs();
  const safeStorage = createSafeStorage();
  const store = createTestStore({ fs, safeStorage });

  const candidate = {
    origin: 'http://192.168.88.250:8080/login',
    username: 'admin',
    password: 'secret-password',
  };

  assert.equal(store.shouldPromptForCredential(candidate), 'save');

  const origin = 'http://192.168.88.250:8080';
  fs.files.set(store.credentialsFilePath(), JSON.stringify({
    version: 1,
    credentials: {
      [origin]: {
        username: 'admin',
        password: safeStorage.encryptString('secret-password').toString('base64'),
        mfaSecret: '',
      },
    },
  }));
  assert.equal(store.shouldPromptForCredential(candidate), 'mfa');

  fs.files.set(store.credentialsFilePath(), JSON.stringify({
    version: 1,
    credentials: {
      [origin]: {
        username: 'admin',
        password: safeStorage.encryptString('secret-password').toString('base64'),
        mfaSecret: 'JBSWY3DPEHPK3PXP',
      },
    },
  }));
  assert.equal(store.shouldPromptForCredential(candidate), null);
  assert.equal(
    store.shouldPromptForCredential({ ...candidate, password: 'changed' }),
    'update'
  );
});

test('clears individual credentials and all saved credentials', () => {
  const fs = createMemoryFs();
  const store = createTestStore({ fs });

  assert.equal(store.saveCredential({
    origin: 'http://192.168.88.250:8080/login',
    username: 'admin',
    password: 'secret-password',
    mfaSecret: 'JBSWY3DPEHPK3PXP',
  }), true);

  assert.equal(store.deleteCredential('http://192.168.88.250:8080/'), true);
  assert.equal(store.getCredential('http://192.168.88.250:8080/'), null);

  assert.equal(store.saveCredential({
    origin: 'http://192.168.20.250/login',
    username: 'operator',
    password: 'another-password',
    mfaSecret: 'JBSWY3DPEHPK3PXP',
  }), true);
  assert.equal(store.deleteAllCredentials(), true);
  assert.deepEqual(store.readCredentialStore(), emptyCredentialStore());
});
