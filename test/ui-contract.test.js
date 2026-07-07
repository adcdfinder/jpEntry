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

test('iframe navigation expands Lion connect URLs without reusing token', () => {
  const preload = readProjectFile('preload.js');
  const main = readProjectFile('main.js');

  assert.match(preload, /ipcRenderer\.on\('expand-iframe'/);
  assert.match(preload, /data-jp-expanded-iframe/);
  assert.match(preload, /position', 'fixed'/);
  assert.match(main, /isLionConnectPageUrl/);
  assert.match(main, /expandIframeInPlace/);
  assert.match(main, /pendingIframeExpansions/);
  assert.match(main, /noteIframeExpandFailure/);
  assert.match(main, /expand-iframe-result/);
  assert.match(main, /loadIframeRequest/);
});

test('main process keeps shortcuts window-scoped for multi-instance use', () => {
  const main = readProjectFile('main.js');

  assert.doesNotMatch(main, /globalShortcut/);
  assert.match(main, /require\('\.\/window-shortcuts'\)/);
  assert.match(main, /handleWindowScopedShortcut/);
  assert.match(main, /before-input-event/);
});

test('main process uses native macOS fullscreen and work-area windowing', () => {
  const main = readProjectFile('main.js');

  assert.doesNotMatch(main, /simpleFullscreen\s*=\s*true/);
  assert.doesNotMatch(main, /setVisibleOnAllWorkspaces\(true,\s*\{\s*visibleOnFullScreen:\s*true\s*\}/);
  assert.match(main, /if \(isMacPlatform\(\)\) \{/);
  assert.match(main, /display\.workArea/);
  assert.match(main, /fullscreen:\s*Boolean\(fullscreen\)/);
  assert.match(main, /parentedPopupOptions/);
  assert.match(main, /parent:\s*mainWindow/);
  assert.match(main, /modal:\s*options\.modal !== false/);
  assert.match(main, /parentedPopupOptions\(\{ modal: false \}\)/);
});

test('main process gives macOS operator dialogs normal window chrome', () => {
  const main = readProjectFile('main.js');
  const operatorChromeUses = main.match(/\.\.\.operatorWindowChromeOptions\(\)/g) || [];

  assert.match(main, /function operatorWindowChromeOptions\(\)/);
  assert.match(main, /frame:\s*true/);
  assert.match(main, /alwaysOnTop:\s*false/);
  assert.match(main, /fullscreenable:\s*false/);
  assert.match(main, /useContentSize:\s*true/);
  assert.match(main, /transparent:\s*!isMacPlatform\(\)/);
  assert.ok(operatorChromeUses.length >= 6);
});

test('main process keeps macOS app visible and quit-capable', () => {
  const main = readProjectFile('main.js');
  const packageJson = JSON.parse(readProjectFile('package.json'));

  assert.match(main, /function installApplicationMenu\(\)/);
  assert.match(main, /if \(isMacPlatform\(\)\) \{\s*return;\s*\}/);
  assert.match(main, /app\.on\('activate'/);
  assert.match(main, /focusPrimaryWindow/);
  assert.equal(packageJson.build && packageJson.build.productName, 'JP Entry');
  assert.equal(packageJson.build && packageJson.build.mac && packageJson.build.mac.icon, 'icon.png');
});

test('preload stays compatible with sandboxed renderer windows', () => {
  const preload = readProjectFile('preload.js');

  assert.doesNotMatch(preload, /require\(['"]\.{1,2}\//);
  assert.match(preload, /process\.isMainFrame/);
  assert.match(preload, /if \(isMainFrame\) \{/);
});

test('main window runs preload in subframes for embedded Guacamole', () => {
  const main = readProjectFile('main.js');

  assert.match(main, /nodeIntegrationInSubFrames:\s*true/);
  assert.match(main, /preload:\s*path\.join\(__dirname,\s*'preload\.js'\)/);
});

test('preload overrides Luna resolution before connection token creation', () => {
  const preload = readProjectFile('preload.js');

  assert.match(preload, /LunaSetting/);
  assert.match(preload, /rdp_resolution/);
  assert.match(preload, /connect_options/);
  assert.match(preload, /patchTokenFormBody/);
  assert.match(preload, /patchRequestUrl/);
  assert.match(preload, /guacamole.*api.*tokens/);
  assert.match(preload, /asset.*add/);
  assert.match(preload, /TERMINAL_GRAPHICAL_RESOLUTION/);
  assert.match(preload, /forceLunaSettingResolution/);
  assert.match(preload, /syncStoredLunaSettingResolution/);
  assert.match(preload, /JSON\.parse = function/);
  assert.match(preload, /JSON\.stringify = function/);
  assert.match(preload, /Object\.assign = function/);
});

test('saving remote resolution rebuilds the active Luna window', () => {
  const main = readProjectFile('main.js');

  assert.match(main, /recreateMainWindowForResolutionChange/);
  assert.match(main, /isFullscreenLikeWindow/);
  assert.match(main, /isGuacamoleClientUrl/);
  assert.match(main, /requiresFreshConnection/);
  assert.match(main, /createMainWindow\(nextUrl \|\| rootUrl,\s*targetDisplay,\s*fullscreen\)/);
  assert.match(main, /shouldReloadMainWindow/);
});

test('preload forces legacy Guacamole connect and resize dimensions', () => {
  const preload = readProjectFile('preload.js');

  assert.match(preload, /wrapGuacamoleClientConstructor/);
  assert.match(preload, /patchGuacamoleConnectData/);
  assert.match(preload, /patchGuacamoleSizeInstruction/);
  assert.match(preload, /installGuacamoleWebSocketHook/);
  assert.match(preload, /startGuacamoleHookPolling/);
  assert.match(preload, /GUAC_WIDTH/);
  assert.match(preload, /GUAC_HEIGHT/);
  assert.match(preload, /sendSize/);
});

test('packaged build includes every local runtime module used by main process', () => {
  const packageJson = JSON.parse(readProjectFile('package.json'));
  const files = packageJson.build && packageJson.build.files;
  const mac = packageJson.build && packageJson.build.mac;

  assert.ok(Array.isArray(files));
  assert.ok(files.includes('main.js'));
  assert.ok(files.includes('preload.js'));
  assert.ok(files.includes('otp-autofill.js'));
  assert.ok(files.includes('credential-store.js'));
  assert.ok(files.includes('instance-profile.js'));
  assert.ok(files.includes('navigation-history.js'));
  assert.ok(files.includes('resolution-settings.js'));
  assert.ok(files.includes('window-shortcuts.js'));
  assert.ok(files.includes('icon.png'));
  assert.equal(mac && mac.extendInfo && mac.extendInfo.LSUIElement, false);
  assert.equal(mac && mac.extendInfo && mac.extendInfo.LSBackgroundOnly, false);
});
