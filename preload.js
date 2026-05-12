'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kioskBridge', {
  onIframeDetected: (callback) => ipcRenderer.on('check-iframes', callback),
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

// Watch for dynamically added iframes and login forms.
const observer = new MutationObserver(() => {
  checkIframes();
  scheduleCredentialAutofill();
});

// Allow main process to request a fresh iframe scan (e.g. from nav dialog).
ipcRenderer.on('force-check-iframes', () => {
  reportedSrcs.clear();
  checkIframes();
});

window.addEventListener('DOMContentLoaded', () => {
  checkIframes();
  setupCredentialCapture();
  scheduleCredentialAutofill(150);
  setTimeout(() => scheduleCredentialAutofill(0), 1000);
  setTimeout(() => scheduleCredentialAutofill(0), 2500);

  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'type', 'name', 'id', 'autocomplete'],
    });
  }
});
