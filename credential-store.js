'use strict';

const defaultFs = require('fs');
const defaultPath = require('path');

function emptyCredentialStore() {
  return { version: 1, credentials: {} };
}

function normalizeOrigin(value) {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch (_err) {
    return null;
  }
}

function createCredentialStore(options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const safeStorage = options.safeStorage || null;
  const normalizeMfaSecret = options.normalizeMfaSecret ||
    ((secret) => String(secret || '').replace(/\s+/g, '').toUpperCase());
  const validateMfaSecret = options.validateMfaSecret || (() => true);
  const now = typeof options.now === 'function'
    ? options.now
    : () => new Date().toISOString();

  function getUserDataPath() {
    if (typeof options.getUserDataPath === 'function') {
      return options.getUserDataPath();
    }
    if (typeof options.userDataPath === 'string') {
      return options.userDataPath;
    }
    return '.';
  }

  function credentialsFilePath() {
    return path.join(getUserDataPath(), 'credentials.json');
  }

  function readCredentialStore() {
    try {
      const raw = fs.readFileSync(credentialsFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        parsed.version === 1 &&
        parsed.credentials &&
        typeof parsed.credentials === 'object'
      ) {
        return parsed;
      }
    } catch (_err) {}

    return emptyCredentialStore();
  }

  function writeCredentialStore(store) {
    const filePath = credentialsFilePath();
    const dir = path.dirname(filePath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_err) {
      return false;
    }

    try {
      fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
      return true;
    } catch (_err) {
      return false;
    }
  }

  function canStoreCredentials() {
    try {
      return Boolean(
        safeStorage &&
        typeof safeStorage.isEncryptionAvailable === 'function' &&
        safeStorage.isEncryptionAvailable()
      );
    } catch (_err) {
      return false;
    }
  }

  function encryptPassword(password) {
    if (!canStoreCredentials()) return null;

    try {
      return safeStorage.encryptString(String(password || '')).toString('base64');
    } catch (_err) {
      return null;
    }
  }

  function decryptPassword(encryptedPassword) {
    if (!encryptedPassword || !canStoreCredentials()) return null;

    try {
      return safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'));
    } catch (_err) {
      return null;
    }
  }

  function getCredential(origin) {
    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) return null;

    const store = readCredentialStore();
    const record = store.credentials[normalizedOrigin];
    if (!record) return null;

    const password = decryptPassword(record.password);
    if (password == null) return null;

    return {
      origin: normalizedOrigin,
      username: record.username || '',
      password,
      mfaSecret: record.mfaSecret || '',
      updatedAt: record.updatedAt || null,
    };
  }

  function getCredentialRecord(origin) {
    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) return null;

    const store = readCredentialStore();
    return store.credentials[normalizedOrigin] || null;
  }

  function isValidMfaSecret(secret) {
    return Boolean(validateMfaSecret(normalizeMfaSecret(secret)));
  }

  function saveCredential(credential) {
    const origin = normalizeOrigin(credential && credential.origin);
    const password = credential && credential.password;
    if (!origin || !password) return false;

    const mfaSecret = normalizeMfaSecret((credential && credential.mfaSecret) || '');
    if (!mfaSecret || !isValidMfaSecret(mfaSecret)) return false;

    const encryptedPassword = encryptPassword(password);
    if (!encryptedPassword) return false;

    const store = readCredentialStore();
    const existing = store.credentials[origin];
    const timestamp = now();
    store.credentials[origin] = {
      username: String((credential && credential.username) || ''),
      password: encryptedPassword,
      mfaSecret,
      createdAt: existing && existing.createdAt ? existing.createdAt : timestamp,
      updatedAt: timestamp,
    };
    return writeCredentialStore(store);
  }

  function deleteCredential(origin) {
    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) return false;

    const store = readCredentialStore();
    if (!store.credentials[normalizedOrigin]) return false;

    delete store.credentials[normalizedOrigin];
    return writeCredentialStore(store);
  }

  function deleteAllCredentials() {
    return writeCredentialStore(emptyCredentialStore());
  }

  function shouldPromptForCredential(candidate) {
    if (!candidate || !candidate.origin || !candidate.password) return null;
    if (!canStoreCredentials()) return null;

    const existing = getCredential(candidate.origin);
    if (!existing) return 'save';
    if (!existing.mfaSecret) return 'mfa';

    if (
      existing.username === String(candidate.username || '') &&
      existing.password === String(candidate.password || '')
    ) {
      return null;
    }

    return 'update';
  }

  return {
    credentialsFilePath,
    readCredentialStore,
    writeCredentialStore,
    canStoreCredentials,
    encryptPassword,
    decryptPassword,
    getCredential,
    getCredentialRecord,
    isValidMfaSecret,
    saveCredential,
    deleteCredential,
    deleteAllCredentials,
    shouldPromptForCredential,
  };
}

module.exports = {
  createCredentialStore,
  emptyCredentialStore,
  normalizeOrigin,
};
