'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isShortcutKey,
} = require('../window-shortcuts');

function shortcutInput(overrides = {}) {
  return {
    type: 'keyDown',
    control: true,
    alt: true,
    meta: false,
    shift: false,
    key: 'h',
    code: 'KeyH',
    ...overrides,
  };
}

test('macOS control-option shortcuts match physical key codes', () => {
  const input = shortcutInput({
    key: 'not-h',
    code: 'KeyH',
  });

  assert.equal(isShortcutKey(input, 'h', { platform: 'darwin' }), true);
});

test('macOS command-option shortcuts match physical key codes', () => {
  const input = shortcutInput({
    control: false,
    meta: true,
    key: 'not-v',
    code: 'KeyV',
  });

  assert.equal(isShortcutKey(input, 'v', { platform: 'darwin' }), true);
});

test('non-macOS shortcuts keep the ctrl-alt contract', () => {
  assert.equal(isShortcutKey(shortcutInput({ code: 'KeyV' }), 'v', { platform: 'win32' }), true);
  assert.equal(
    isShortcutKey(shortcutInput({ control: false, meta: true, code: 'KeyV' }), 'v', { platform: 'win32' }),
    false
  );
});

test('quit shortcut still requires shift', () => {
  const input = shortcutInput({
    key: 'Q',
    code: 'KeyQ',
  });

  assert.equal(isShortcutKey(input, 'q', { platform: 'darwin', shift: true }), false);
  assert.equal(isShortcutKey({ ...input, shift: true }, 'q', { platform: 'darwin', shift: true }), true);
});
