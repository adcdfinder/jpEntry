'use strict';

const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const MAX_WIDTH = 7680;
const MAX_HEIGHT = 4320;
const DEFAULT_RESOLUTION_SETTING = Object.freeze({ mode: 'auto', width: 0, height: 0 });
const RESOLUTION_STORAGE_KEY = 'jpEntry.remoteResolution';

const PRESET_RESOLUTIONS = Object.freeze([
  { label: '1024x768', width: 1024, height: 768 },
  { label: '1366x768', width: 1366, height: 768 },
  { label: '1600x900', width: 1600, height: 900 },
  { label: '1920x1080', width: 1920, height: 1080 },
  { label: '2560x1440', width: 2560, height: 1440 },
  { label: '3840x2160', width: 3840, height: 2160 },
]);

function toInteger(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : 0;
  }

  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isValidResolution(width, height) {
  return Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= MIN_WIDTH &&
    height >= MIN_HEIGHT &&
    width <= MAX_WIDTH &&
    height <= MAX_HEIGHT;
}

function normalizeResolutionValue(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const match = value.trim().toLowerCase().match(/^(\d+)x(\d+)$/);
    if (!match) return null;
    const width = toInteger(match[1]);
    const height = toInteger(match[2]);
    return isValidResolution(width, height) ? { width, height } : null;
  }

  const width = toInteger(value.width);
  const height = toInteger(value.height);
  return isValidResolution(width, height) ? { width, height } : null;
}

function normalizeResolutionSetting(setting) {
  if (!setting || typeof setting !== 'object') {
    return { ...DEFAULT_RESOLUTION_SETTING };
  }

  const mode = String(setting.mode || '').toLowerCase();
  if (mode === 'auto') {
    return { ...DEFAULT_RESOLUTION_SETTING };
  }

  if (mode === 'display') {
    return { mode: 'display', width: 0, height: 0 };
  }

  if (mode === 'preset' || mode === 'custom') {
    const resolution = normalizeResolutionValue(setting);
    if (!resolution) return { ...DEFAULT_RESOLUTION_SETTING };
    return { mode, width: resolution.width, height: resolution.height };
  }

  return { ...DEFAULT_RESOLUTION_SETTING };
}

function effectiveResolution(setting, displayBounds) {
  const normalized = normalizeResolutionSetting(setting);

  if (normalized.mode === 'auto') {
    return null;
  }

  if (normalized.mode === 'display') {
    return normalizeResolutionValue(displayBounds);
  }

  return normalizeResolutionValue(normalized);
}

function formatResolution(resolution) {
  const normalized = normalizeResolutionValue(resolution);
  return normalized ? `${normalized.width}x${normalized.height}` : '';
}

function resolutionOverrideFromSetting(setting, displayBounds) {
  return formatResolution(effectiveResolution(setting, displayBounds));
}

function isLionConnectWebSocketUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return /^wss?:$/i.test(url.protocol) &&
      (
        /\/lion\/ws\/connect\/?$/i.test(url.pathname) ||
        /\/guacamole\/websocket-tunnel\/?$/i.test(url.pathname)
      );
  } catch (_err) {
    return false;
  }
}

function applyResolutionToGuacamoleUrl(rawUrl, resolution) {
  const normalized = normalizeResolutionValue(resolution);
  if (!normalized || !isLionConnectWebSocketUrl(rawUrl)) {
    return rawUrl;
  }

  const url = new URL(rawUrl);
  url.searchParams.set('GUAC_WIDTH', String(normalized.width));
  url.searchParams.set('GUAC_HEIGHT', String(normalized.height));
  return url.toString();
}

function isConnectionTokenUrl(rawUrl, baseUrl) {
  try {
    const url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    return /\/api\/v1\/authentication\/(?:admin-)?connection-token\/?$/i.test(url.pathname);
  } catch (_err) {
    return false;
  }
}

function withResolutionConnectOption(body, resolution) {
  const resolutionText = formatResolution(resolution);
  if (!resolutionText || typeof body !== 'string') {
    return body;
  }

  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return body;
    }

    const connectOptions = data.connect_options && typeof data.connect_options === 'object'
      ? data.connect_options
      : {};
    connectOptions.resolution = resolutionText;
    data.connect_options = connectOptions;
    return JSON.stringify(data);
  } catch (_err) {
    return body;
  }
}

function resolutionLabel(setting, displayBounds) {
  const normalized = normalizeResolutionSetting(setting);
  if (normalized.mode === 'auto') return 'Auto';
  if (normalized.mode === 'display') {
    const value = resolutionOverrideFromSetting(normalized, displayBounds);
    return value ? `Display size (${value})` : 'Display size';
  }
  return formatResolution(normalized) || 'Auto';
}

module.exports = {
  DEFAULT_RESOLUTION_SETTING,
  MAX_HEIGHT,
  MAX_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  PRESET_RESOLUTIONS,
  RESOLUTION_STORAGE_KEY,
  applyResolutionToGuacamoleUrl,
  effectiveResolution,
  formatResolution,
  isConnectionTokenUrl,
  isLionConnectWebSocketUrl,
  isValidResolution,
  normalizeResolutionSetting,
  normalizeResolutionValue,
  resolutionLabel,
  resolutionOverrideFromSetting,
  withResolutionConnectOption,
};
