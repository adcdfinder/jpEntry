'use strict';

const crypto = require('crypto');

function normalizeOrigin(value) {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch (_err) {
    return null;
  }
}

function sanitizeProfileKey(value) {
  const cleaned = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'default';
}

function zoneForUrl(url, zones = []) {
  const origin = normalizeOrigin(url);
  if (!origin) return null;

  return zones.find((zone) => normalizeOrigin(zone.url) === origin) || null;
}

function profileKeyForKiosk(url, options = {}) {
  const zones = Array.isArray(options.zones) ? options.zones : [];
  const matchedZone = zoneForUrl(url, zones);
  if (matchedZone && matchedZone.key) {
    return sanitizeProfileKey(matchedZone.key);
  }

  const origin = normalizeOrigin(url);
  if (!origin) {
    return sanitizeProfileKey(options.defaultKey || 'default');
  }

  const hash = crypto.createHash('sha256').update(origin).digest('hex').slice(0, 12);
  return `custom-${hash}`;
}

function partitionForProfile(profileKey) {
  return `persist:kiosk-${sanitizeProfileKey(profileKey)}`;
}

module.exports = {
  normalizeOrigin,
  partitionForProfile,
  profileKeyForKiosk,
  sanitizeProfileKey,
  zoneForUrl,
};
