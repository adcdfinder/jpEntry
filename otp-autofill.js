'use strict';

const OTP_LOGIN_URL = 'http://192.168.88.250:8080/core/auth/login/otp/';

function normalizeUrlPath(pathname) {
  return String(pathname || '').replace(/\/+$/, '') || '/';
}

function isOtpLoginUrl(value) {
  try {
    const url = new URL(value);
    const target = new URL(OTP_LOGIN_URL);
    return url.protocol === target.protocol &&
      url.host === target.host &&
      normalizeUrlPath(url.pathname) === normalizeUrlPath(target.pathname);
  } catch (_err) {
    return false;
  }
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
  return /otp|totp|mfa|2fa|two[-_\s]?factor|verification|authenticator|code/.test(
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
  OTP_LOGIN_URL,
  isOtpLoginUrl,
  findOtpInput,
  otpTokenFromSecret,
  normalizeOtpSecret,
  isValidOtpSecret,
};
