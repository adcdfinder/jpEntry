'use strict';

const KEY_CODE_BY_SHORTCUT_KEY = Object.freeze({
  h: 'KeyH',
  q: 'KeyQ',
  v: 'KeyV',
});

function expectedKeyCode(key) {
  return KEY_CODE_BY_SHORTCUT_KEY[String(key || '').toLowerCase()] || '';
}

function hasShortcutModifiers(input, platform = process.platform) {
  if (!input || !input.alt) return false;

  if (platform === 'darwin') {
    const controlOption = Boolean(input.control) && !input.meta;
    const commandOption = Boolean(input.meta) && !input.control;
    return controlOption || commandOption;
  }

  return Boolean(input.control && !input.meta);
}

function matchesShortcutKey(input, key) {
  const code = expectedKeyCode(key);
  if (code && input.code) return input.code === code;

  return String(input.key || '').toLowerCase() === String(key || '').toLowerCase();
}

function isShortcutKey(input, key, options = {}) {
  if (!input || input.type !== 'keyDown') return false;

  return Boolean(
    hasShortcutModifiers(input, options.platform) &&
    Boolean(input.shift) === Boolean(options.shift) &&
    matchesShortcutKey(input, key)
  );
}

module.exports = {
  hasShortcutModifiers,
  isShortcutKey,
  matchesShortcutKey,
};
