const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

function readProjectFile(fileName) {
  return fs.readFileSync(path.join(rootDir, fileName), 'utf8');
}

test('HTML dialogs keep valid inline scripts and ASCII-only labels', () => {
  const htmlFiles = fs.readdirSync(rootDir).filter((fileName) => fileName.endsWith('.html'));

  for (const fileName of htmlFiles) {
    const html = readProjectFile(fileName);
    assert.equal(
      /[^\x00-\x7F]/.test(html),
      false,
      `${fileName} should avoid non-ASCII characters that can break packaged HTML`
    );

    const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g));
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script[1]), `${fileName} script should parse`);
    }
  }
});

test('navigation dialog exposes the expected operator actions', () => {
  const html = readProjectFile('nav-dialog.html');

  for (const id of [
    'rootBtn',
    'backBtn',
    'iframeBtn',
    'resolutionBtn',
    'clearAllCredentialsBtn',
    'quitBtn',
    'cancelBtn',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(html, /Go to Root Page/);
  assert.match(html, /Go to Last Page/);
  assert.match(html, /Detect Iframes/);
  assert.match(html, /Remote Resolution/);
  assert.match(html, /Clear All Passwords/);
  assert.match(html, /bindAction\('rootBtn', 'root'\)/);
  assert.match(html, /bindAction\('backBtn', 'back'\)/);
  assert.match(html, /bindAction\('iframeBtn', 'check-iframes'\)/);
  assert.match(html, /bindAction\('resolutionBtn', 'resolution'\)/);
  assert.match(html, /bindAction\('clearAllCredentialsBtn', 'clear-all-credentials'\)/);
});

test('startup URL dialog keeps Red and Yellow zone contract hooks', () => {
  const html = readProjectFile('url-dialog.html');

  assert.match(html, /id="zoneToggle"/);
  assert.match(html, /id="resolutionMode"/);
  assert.match(html, /ipcRenderer\.on\('kiosk-zones'/);
  assert.match(html, /ipcRenderer\.send\('url-submitted', \{ url, fullscreen, zone: selectedZone, resolution \}\)/);
});

test('resolution dialog keeps apply and cancel actions wired', () => {
  const html = readProjectFile('resolution-dialog.html');

  assert.match(html, /id="resolutionMode"/);
  assert.match(html, /id="resolutionWidth"/);
  assert.match(html, /id="resolutionHeight"/);
  assert.match(html, /id="saveBtn"/);
  assert.match(html, /id="cancelBtn"/);
  assert.match(html, /resolution-action', \{ action: 'save', setting \}/);
  assert.match(html, /resolution-action', \{ action: 'cancel' \}/);
});

test('iframe dialog keeps navigate and stay actions wired', () => {
  const html = readProjectFile('iframe-dialog.html');

  assert.match(html, /id="iframeUrl"/);
  assert.match(html, /id="goBtn"/);
  assert.match(html, /id="stayBtn"/);
  assert.match(html, /iframe-action', 'navigate'/);
  assert.match(html, /iframe-action', 'stay'/);
});

test('main process keeps shortcuts window-scoped for multi-instance use', () => {
  const main = readProjectFile('main.js');

  assert.doesNotMatch(main, /globalShortcut/);
  assert.match(main, /handleWindowScopedShortcut/);
  assert.match(main, /before-input-event/);
});

test('preload stays compatible with sandboxed renderer windows', () => {
  const preload = readProjectFile('preload.js');

  assert.doesNotMatch(preload, /require\(['"]\.{1,2}\//);
});

test('preload overrides Luna resolution before connection token creation', () => {
  const preload = readProjectFile('preload.js');

  assert.match(preload, /LunaSetting/);
  assert.match(preload, /rdp_resolution/);
  assert.match(preload, /connect_options/);
  assert.match(preload, /JSON\.parse = function/);
  assert.match(preload, /JSON\.stringify = function/);
  assert.match(preload, /Object\.assign = function/);
});

test('preload forces legacy Guacamole connect and resize dimensions', () => {
  const preload = readProjectFile('preload.js');

  assert.match(preload, /wrapGuacamoleClientConstructor/);
  assert.match(preload, /patchGuacamoleConnectData/);
  assert.match(preload, /GUAC_WIDTH/);
  assert.match(preload, /GUAC_HEIGHT/);
  assert.match(preload, /sendSize/);
});

test('packaged build includes every local runtime module used by main process', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const files = packageJson.build && packageJson.build.files;

  assert.ok(Array.isArray(files));
  assert.ok(files.includes('main.js'));
  assert.ok(files.includes('preload.js'));
  assert.ok(files.includes('otp-autofill.js'));
  assert.ok(files.includes('credential-store.js'));
  assert.ok(files.includes('instance-profile.js'));
  assert.ok(files.includes('navigation-history.js'));
  assert.ok(files.includes('resolution-settings.js'));
});
