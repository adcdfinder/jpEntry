'use strict';

const DEFAULT_KIOSK_ZONE = 'red';
const KIOSK_ZONES = [
  {
    key: 'red',
    label: 'Red Zone',
    url: 'http://192.168.88.250:8080',
  },
  {
    key: 'yellow',
    label: 'Yellow Zone',
    url: 'http://192.168.20.250:80',
  },
];
const OTP_LOGIN_PATH = '/core/auth/login/otp/';

function normalizeUrlPath(pathname) {
  return String(pathname || '').replace(/\/+$/, '') || '/';
}

function normalizeOrigin(value) {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch (_err) {
    return null;
  }
}

function kioskZoneByKey(key) {
  return KIOSK_ZONES.find((zone) => zone.key === key) ||
    KIOSK_ZONES.find((zone) => zone.key === DEFAULT_KIOSK_ZONE) ||
    KIOSK_ZONES[0];
}

function defaultKioskUrl(zoneKey = DEFAULT_KIOSK_ZONE) {
  const zone = kioskZoneByKey(zoneKey);
  return zone ? zone.url : '';
}

function knownKioskOrigins() {
  return KIOSK_ZONES
    .map((zone) => normalizeOrigin(zone.url))
    .filter(Boolean);
}

function isKnownKioskOrigin(value) {
  const origin = normalizeOrigin(value);
  return Boolean(origin && knownKioskOrigins().includes(origin));
}

function kioskOriginForUrl(value) {
  return isKnownKioskOrigin(value) ? normalizeOrigin(value) : null;
}

function hasOtpUrlHint(url) {
  const haystack = decodeURIComponent([
    url.pathname,
    url.search,
    url.hash,
  ].join(' ')).toLowerCase();
  return /otp|totp|mfa|2fa|two[-_\s]?factor|verification/.test(haystack);
}

function isOtpLoginUrl(value) {
  try {
    const url = new URL(value);
    return isKnownKioskOrigin(url.href) &&
      (
        normalizeUrlPath(url.pathname) === normalizeUrlPath(OTP_LOGIN_PATH) ||
        hasOtpUrlHint(url)
      );
  } catch (_err) {
    return false;
  }
}

function otpOriginForUrl(value, options = {}) {
  if (!isOtpLoginUrl(value) && !options.hasOtpInput) return null;
  if (!isKnownKioskOrigin(value)) return null;
  return normalizeOrigin(value);
}

function attr(input, name) {
  if (!input) return '';
  if (typeof input.getAttribute === 'function') {
    return input.getAttribute(name) || '';
  }
  return input[name] || '';
}

function inputType(input) {
  return String(attr(input, 'type') || 'text').toLowerCase();
}

function isDisabled(input) {
  return Boolean(input && (input.disabled || input.readOnly));
}

function otpHintText(input) {
  return [
    attr(input, 'name'),
    attr(input, 'id'),
    attr(input, 'class'),
    attr(input, 'className'),
    attr(input, 'placeholder'),
    attr(input, 'autocomplete'),
    attr(input, 'aria-label'),
  ].join(' ').toLowerCase();
}

function isOtpHinted(input) {
  return /otp|totp|mfa|2fa|two[-_\s]?factor|verification|authenticator|code|验证码|动态码|认证码|安全码|令牌|口令|多因素|双因素/.test(
    otpHintText(input)
  );
}

function isSixDigitInput(input) {
  const maxLength = Number(attr(input, 'maxlength') || attr(input, 'maxLength'));
  const inputMode = String(attr(input, 'inputmode') || attr(input, 'inputMode')).toLowerCase();
  const pattern = String(attr(input, 'pattern') || '');
  return maxLength === 6 ||
    inputMode === 'numeric' ||
    inputMode === 'decimal' ||
    /\d|\[0-9\]/.test(pattern);
}

function isUsableOtpInput(input) {
  if (!input || isDisabled(input)) return false;
  const type = inputType(input);
  return [
    'text',
    'tel',
    'number',
    'password',
    'search',
  ].includes(type);
}

function findOtpInput(inputs) {
  const candidates = Array.from(inputs || []).filter(isUsableOtpInput);
  return candidates.find(isOtpHinted) ||
    candidates.find(isSixDigitInput) ||
    null;
}

function otpTokenFromSecret(authenticator, secret) {
  const normalizedSecret = normalizeOtpSecret(secret);
  if (!authenticator || !isValidOtpSecret(normalizedSecret)) return null;

  try {
    const token = authenticator.generate(normalizedSecret);
    return /^\d{6}$/.test(String(token)) ? String(token) : null;
  } catch (_err) {
    return null;
  }
}

function normalizeOtpSecret(secret) {
  return String(secret || '').replace(/\s+/g, '').toUpperCase();
}

function isValidOtpSecret(secret) {
  const normalizedSecret = normalizeOtpSecret(secret);
  return normalizedSecret.length >= 16 &&
    normalizedSecret.length <= 128 &&
    /^[A-Z2-7]+=*$/.test(normalizedSecret);
}

module.exports = {
  DEFAULT_KIOSK_ZONE,
  KIOSK_ZONES,
  OTP_LOGIN_PATH,
  defaultKioskUrl,
  isKnownKioskOrigin,
  kioskOriginForUrl,
  isOtpLoginUrl,
  otpOriginForUrl,
  findOtpInput,
  otpTokenFromSecret,
  normalizeOtpSecret,
  isValidOtpSecret,
};
