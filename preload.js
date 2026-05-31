'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kioskBridge', {
  onIframeDetected: (callback) => ipcRenderer.on('check-iframes', callback),
});

const MIN_REMOTE_WIDTH = 640;
const MIN_REMOTE_HEIGHT = 480;
const MAX_REMOTE_WIDTH = 7680;
const MAX_REMOTE_HEIGHT = 4320;

let kioskOrigins = [];
let otpLoginPath = '';
let kioskConfigPromise = null;
let remoteResolutionOverride = readInitialResolutionOverride();
let remoteResolutionDebug = readResolutionDebugFlag();

function formatResolution(value) {
  const match = String(value || '').trim().match(/^(\d{2,5})\s*x\s*(\d{2,5})$/i);
  if (!match) return '';

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MIN_REMOTE_WIDTH ||
    height < MIN_REMOTE_HEIGHT ||
    width > MAX_REMOTE_WIDTH ||
    height > MAX_REMOTE_HEIGHT
  ) {
    return '';
  }

  return `${width}x${height}`;
}

function readInitialResolutionOverride() {
  const prefix = '--jp-remote-resolution=';
  const arg = process.argv.find((item) => String(item || '').startsWith(prefix));
  if (!arg) return '';

  try {
    return formatResolution(decodeURIComponent(arg.slice(prefix.length)));
  } catch (_err) {
    return '';
  }
}

function readResolutionDebugFlag() {
  const prefix = '--jp-resolution-debug=';
  const arg = process.argv.find((item) => String(item || '').startsWith(prefix));
  return Boolean(arg && arg.slice(prefix.length) === '1');
}

function resolutionDebugLog(...parts) {
  if (!remoteResolutionDebug) return;
  console.log('[JP Entry][resolution]', parts.join(' '));
}

function injectPageWorldScript(source) {
  function append() {
    const target = document.documentElement || document.head || document.body;
    if (!target) return false;

    const script = document.createElement('script');
    script.textContent = source;
    target.appendChild(script);
    script.remove();
    return true;
  }

  if (!append()) {
    window.addEventListener('DOMContentLoaded', append, { once: true });
  }
}

function remoteResolutionPatchSource(resolutionText) {
  return `
    (function() {
      var nextResolution = ${JSON.stringify(formatResolution(resolutionText))};
      var debugEnabled = ${remoteResolutionDebug ? 'true' : 'false'};

      function debugLog(message) {
        if (debugEnabled && window.console && typeof window.console.log === 'function') {
          window.console.log('[JP Entry][resolution] ' + message);
        }
      }

      function setResolution(value) {
        window.__jpRemoteResolution = typeof value === 'string' ? value : '';
        debugLog('page resolution=' + (window.__jpRemoteResolution || '(auto)'));
      }

      function isConnectionTokenUrl(rawUrl) {
        try {
          var url = new URL(rawUrl, window.location.href);
          return /\\/api\\/v1\\/authentication\\/(?:admin-)?connection-token\\/?$/i.test(url.pathname);
        } catch (_err) {
          return false;
        }
      }

      function shouldPatch(rawUrl, method) {
        if (!window.__jpRemoteResolution) return false;
        if (method && String(method).toUpperCase() !== 'POST') return false;
        return isConnectionTokenUrl(rawUrl);
      }

      function patchBody(body) {
        if (!window.__jpRemoteResolution || typeof body !== 'string') return body;

        try {
          var data = JSON.parse(body);
          if (!data || typeof data !== 'object' || Array.isArray(data)) return body;

          var options = data.connect_options;
          if (!options || typeof options !== 'object' || Array.isArray(options)) {
            options = {};
          }
          options.resolution = window.__jpRemoteResolution;
          data.connect_options = options;
          return JSON.stringify(data);
        } catch (_err) {
          return body;
        }
      }

      if (!window.__jpResolutionPatchInstalled) {
        window.__jpResolutionPatchInstalled = true;
        debugLog('page patch installed');

        var nativeFetch = window.fetch;
        if (typeof nativeFetch === 'function') {
          window.fetch = function(input, init) {
            var requestUrl = typeof input === 'string' ? input : input && input.url;
            var method = init && init.method ? init.method : input && input.method;

            if (init && shouldPatch(requestUrl, method) && typeof init.body === 'string') {
              init = Object.assign({}, init, { body: patchBody(init.body) });
              debugLog('patched fetch token body resolution=' + window.__jpRemoteResolution);
            } else if (shouldPatch(requestUrl, method)) {
              debugLog('fetch token body not patched type=' + typeof (init && init.body));
            }

            return nativeFetch.call(this, input, init);
          };
        }

        var nativeOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
        var nativeSend = window.XMLHttpRequest && window.XMLHttpRequest.prototype.send;
        if (nativeOpen && nativeSend) {
          window.XMLHttpRequest.prototype.open = function(method, url) {
            this.__jpRequestMethod = method;
            this.__jpRequestUrl = url;
            return nativeOpen.apply(this, arguments);
          };

          window.XMLHttpRequest.prototype.send = function(body) {
            if (shouldPatch(this.__jpRequestUrl, this.__jpRequestMethod)) {
              body = patchBody(body);
              debugLog('patched xhr token body resolution=' + window.__jpRemoteResolution);
            }
            return nativeSend.call(this, body);
          };
        }
      }

      setResolution(nextResolution);
    })();
  `;
}

function installRemoteResolutionPatch(resolutionText) {
  remoteResolutionOverride = formatResolution(resolutionText);
  resolutionDebugLog('preload install override=' + (remoteResolutionOverride || '(auto)'));
  injectPageWorldScript(remoteResolutionPatchSource(remoteResolutionOverride));
}

installRemoteResolutionPatch(remoteResolutionOverride);

ipcRenderer.on('remote-resolution-override', (_event, resolutionText) => {
  installRemoteResolutionPatch(resolutionText);
});

// Observe DOM for iframe insertions and report their src to main.
const reportedSrcs = new Set();

function checkIframes() {
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach((iframe) => {
    const src = iframe.src || iframe.getAttribute('src');
    if (src && src.startsWith('http') && !reportedSrcs.has(src)) {
      reportedSrcs.add(src);
      ipcRenderer.send('iframe-detected', src);
    }
  });
}

function inputType(input) {
  return String(input.getAttribute('type') || 'text').toLowerCase();
}

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

function applyKioskConfig(config) {
  const zones = Array.isArray(config && config.zones) ? config.zones : [];
  kioskOrigins = zones
    .map((zone) => normalizeOrigin(zone.url))
    .filter(Boolean);
  otpLoginPath = String((config && config.otpLoginPath) || '');
}

function loadKioskConfig() {
  if (!kioskConfigPromise) {
    kioskConfigPromise = ipcRenderer.invoke('kiosk-config')
      .then((config) => {
        applyKioskConfig(config);
        return config;
      })
      .catch(() => null);
  }
  return kioskConfigPromise;
}

function isOtpLoginUrl(value) {
  try {
    const url = new URL(value);
    return Boolean(
      otpLoginPath &&
      kioskOrigins.includes(url.origin) &&
      (
        normalizeUrlPath(url.pathname) === normalizeUrlPath(otpLoginPath) ||
        hasOtpUrlHint(url)
      )
    );
  } catch (_err) {
    return false;
  }
}

function isKnownKioskUrl(value) {
  try {
    const url = new URL(value);
    return kioskOrigins.includes(url.origin);
  } catch (_err) {
    return false;
  }
}

function hasOtpUrlHint(url) {
  const haystack = decodeURIComponent([
    url.pathname,
    url.search,
    url.hash,
  ].join(' ')).toLowerCase();
  return /otp|totp|mfa|2fa|two[-_\s]?factor|verification/.test(haystack);
}

function isCredentialOrigin() {
  return /^https?:$/i.test(window.location.protocol);
}

function isUsableInput(input) {
  if (!input || input.tagName !== 'INPUT') return false;
  if (input.disabled || input.readOnly) return false;

  const type = inputType(input);
  return ![
    'hidden',
    'password',
    'button',
    'submit',
    'reset',
    'checkbox',
    'radio',
    'file',
    'image',
  ].includes(type);
}

function isUsernameHint(input) {
  const haystack = [
    input.name,
    input.id,
    input.className,
    input.placeholder,
    input.getAttribute('autocomplete'),
    input.getAttribute('aria-label'),
  ].join(' ').toLowerCase();

  return /user|login|account|email|mail|phone|mobile|name/.test(haystack);
}

function passwordInputs(scope = document) {
  return Array.from(scope.querySelectorAll('input[type="password"]'))
    .filter((input) => !input.disabled && !input.readOnly);
}

function credentialScope(passwordInput) {
  return passwordInput.form || passwordInput.closest('form') || document;
}

function findUsernameInput(passwordInput) {
  const scope = credentialScope(passwordInput);
  const inputs = Array.from(scope.querySelectorAll('input'));
  const passwordIndex = inputs.indexOf(passwordInput);
  const beforePassword = passwordIndex >= 0 ? inputs.slice(0, passwordIndex) : inputs;
  const candidates = beforePassword.filter(isUsableInput);
  const hinted = candidates.filter(isUsernameHint);

  if (hinted.length > 0) return hinted[hinted.length - 1];
  if (candidates.length > 0) return candidates[candidates.length - 1];

  return inputs.find(isUsableInput) || null;
}

function dispatchFieldEvents(input) {
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  );

  if (descriptor && descriptor.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }

  dispatchFieldEvents(input);
}

function credentialFromPasswordInput(passwordInput) {
  if (!passwordInput || inputType(passwordInput) !== 'password') return null;

  const password = passwordInput.value;
  if (!password) return null;

  const usernameInput = findUsernameInput(passwordInput);
  return {
    origin: window.location.origin,
    username: usernameInput ? usernameInput.value : '',
    password,
  };
}

let lastCredentialKey = '';
let lastCredentialAt = 0;

function sendCredentialCandidate(candidate) {
  if (!candidate || !candidate.password || !isCredentialOrigin()) return;

  const key = [
    candidate.origin,
    candidate.username,
    candidate.password,
  ].join('\n');
  const now = Date.now();
  if (key === lastCredentialKey && now - lastCredentialAt < 5000) return;

  lastCredentialKey = key;
  lastCredentialAt = now;
  ipcRenderer.send('credentials-captured', candidate);
}

function capturePasswordInput(passwordInput, delay = 0) {
  setTimeout(() => {
    sendCredentialCandidate(credentialFromPasswordInput(passwordInput));
  }, delay);
}

function firstPasswordInputFromTarget(target) {
  if (!target) return null;

  if (target.tagName === 'INPUT' && inputType(target) === 'password') {
    return target;
  }

  const form = target.form || (target.closest && target.closest('form'));
  const scope = form || document;
  return passwordInputs(scope)[0] || null;
}

function setupCredentialCapture() {
  document.addEventListener('submit', (event) => {
    const passwordInput = passwordInputs(event.target || document)[0];
    if (passwordInput) capturePasswordInput(passwordInput);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const passwordInput = firstPasswordInputFromTarget(event.target);
    if (passwordInput) capturePasswordInput(passwordInput);
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest
      ? event.target.closest('button,input,[role="button"]')
      : null;
    if (!target) return;

    const passwordInput = firstPasswordInputFromTarget(target);
    if (passwordInput) capturePasswordInput(passwordInput, 50);
  }, true);
}

let autofillTimer = null;
let autofillCredential = null;
let otpAutofillTimer = null;

function applyCredential(credential) {
  if (!credential || !credential.password) return false;

  const passwordInput = passwordInputs()[0];
  if (!passwordInput || passwordInput.value) return false;

  const usernameInput = findUsernameInput(passwordInput);
  if (usernameInput && credential.username && !usernameInput.value) {
    setInputValue(usernameInput, credential.username);
  }

  setInputValue(passwordInput, credential.password);
  return true;
}

function requestCredentialAutofill() {
  if (!isCredentialOrigin()) return;

  ipcRenderer.invoke('credentials-get')
    .then((credential) => {
      autofillCredential = credential;
      if (credential) applyCredential(credential);
    })
    .catch(() => {});
}

function scheduleCredentialAutofill(delay = 250) {
  clearTimeout(autofillTimer);
  autofillTimer = setTimeout(() => {
    if (autofillCredential && applyCredential(autofillCredential)) return;
    requestCredentialAutofill();
  }, delay);
}

function otpHintText(input) {
  return [
    input.name,
    input.id,
    input.className,
    input.placeholder,
    input.getAttribute('autocomplete'),
    input.getAttribute('aria-label'),
  ].join(' ').toLowerCase();
}

function isOtpHinted(input) {
  return /otp|totp|mfa|2fa|two[-_\s]?factor|verification|authenticator|code|验证码|动态码|认证码|安全码|令牌|口令|多因素|双因素/.test(
    otpHintText(input)
  );
}

function isSixDigitInput(input) {
  const maxLength = Number(input.getAttribute('maxlength') || input.maxLength);
  const inputMode = String(input.getAttribute('inputmode') || input.inputMode || '').toLowerCase();
  const pattern = String(input.getAttribute('pattern') || '');
  return maxLength === 6 ||
    inputMode === 'numeric' ||
    inputMode === 'decimal' ||
    /\d|\[0-9\]/.test(pattern);
}

function isUsableOtpInput(input) {
  if (!input || input.tagName !== 'INPUT') return false;
  if (input.disabled || input.readOnly) return false;
  return [
    'text',
    'tel',
    'number',
    'password',
    'search',
  ].includes(inputType(input));
}

function findOtpInput(scope = document) {
  const candidates = Array.from(scope.querySelectorAll('input')).filter(isUsableOtpInput);
  return candidates.find(isOtpHinted) ||
    candidates.find(isSixDigitInput) ||
    null;
}

function applyOtpToken(token, options = {}) {
  if (!token || !/^\d{6}$/.test(String(token))) return false;

  const input = findOtpInput();
  if (!input) return false;
  if (input.value && !options.force) return false;
  if (input.value && options.force && !/^\d{0,8}$/.test(String(input.value))) return false;

  setInputValue(input, String(token));
  input.focus({ preventScroll: true });
  return true;
}

function requestOtpAutofill(options = {}) {
  loadKioskConfig()
    .then(() => {
      const hasOtpInput = Boolean(findOtpInput());
      if (!isOtpLoginUrl(window.location.href) && !hasOtpInput) return null;
      if (!isKnownKioskUrl(window.location.href)) return null;
      return ipcRenderer.invoke('otp-get', {
        url: window.location.href,
        hasOtpInput,
      });
    })
    .then((token) => {
      if (token) applyOtpToken(token, options);
    })
    .catch(() => {});
}

function scheduleOtpAutofill(delay = 250, options = {}) {
  clearTimeout(otpAutofillTimer);
  otpAutofillTimer = setTimeout(() => {
    requestOtpAutofill(options);
  }, delay);
}

// Watch for dynamically added iframes and login forms.
const observer = new MutationObserver(() => {
  checkIframes();
  scheduleCredentialAutofill();
  scheduleOtpAutofill();
});

// Allow main process to request a fresh iframe scan (e.g. from nav dialog).
ipcRenderer.on('force-check-iframes', () => {
  reportedSrcs.clear();
  checkIframes();
});

ipcRenderer.on('otp-fill-now', () => {
  scheduleOtpAutofill(0, { force: true });
  setTimeout(() => scheduleOtpAutofill(0, { force: true }), 250);
  setTimeout(() => scheduleOtpAutofill(0, { force: true }), 750);
});

window.addEventListener('DOMContentLoaded', () => {
  checkIframes();
  loadKioskConfig().then(() => scheduleOtpAutofill(0));
  setupCredentialCapture();
  scheduleCredentialAutofill(150);
  scheduleOtpAutofill(150);
  setTimeout(() => scheduleCredentialAutofill(0), 1000);
  setTimeout(() => scheduleCredentialAutofill(0), 2500);
  setTimeout(() => scheduleOtpAutofill(0), 1000);
  setTimeout(() => scheduleOtpAutofill(0), 2500);

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'type', 'name', 'id', 'autocomplete'],
    });
  }
});
