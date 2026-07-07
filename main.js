'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  Menu,
  screen,
  clipboard,
  safeStorage,
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { authenticator } = require('otplib');
const {
  createCredentialStore,
  normalizeOrigin,
} = require('./credential-store');
const {
  createNavigationHistory,
  normalizeNavigationUrl,
} = require('./navigation-history');
const {
  partitionForProfile,
  profileKeyForKiosk,
} = require('./instance-profile');
const {
  isShortcutKey,
} = require('./window-shortcuts');
const {
  DEFAULT_RESOLUTION_SETTING,
  MAX_HEIGHT,
  MAX_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  PRESET_RESOLUTIONS,
  applyResolutionToGuacamoleUrl,
  isConnectionTokenUrl,
  isGuacamoleClientUrl,
  isLionConnectPageUrl,
  isLionConnectWebSocketUrl,
  normalizeResolutionSetting,
  resolutionLabel,
  resolutionOverrideFromSetting,
} = require('./resolution-settings');

const {
  DEFAULT_KIOSK_ZONE,
  KIOSK_ZONES,
  OTP_LOGIN_PATH,
  normalizeOtpSecret,
  otpOriginForUrl,
  otpTokenFromSecret,
} = require('./otp-autofill');

const credentialStore = createCredentialStore({
  getUserDataPath: () => app.getPath('userData'),
  safeStorage,
  normalizeMfaSecret: normalizeOtpSecret,
  validateMfaSecret: (secret) => Boolean(otpTokenFromSecret(authenticator, secret)),
});
const {
  canStoreCredentials,
  getCredential,
  saveCredential,
  deleteAllCredentials,
  shouldPromptForCredential,
} = credentialStore;

// Required for Windows notifications / taskbar grouping
app.setAppUserModelId('com.opengeolabs.jpentry');

// Redirect userData to app directory to avoid cache access-denied errors
// when the default %APPDATA% path is not writable (kiosk user accounts).
// In packaged apps __dirname is inside app.asar (a file), so we resolve
// to the directory containing the executable instead.
if (process.platform === 'win32') {
  const dataDir = app.isPackaged
    ? path.join(path.dirname(app.getPath('exe')), '.electron-data')
    : path.join(__dirname, '.electron-data');
  app.setPath('userData', dataDir);
}

// ── GPU / rendering optimisation (Windows) ───────────────────────────────────
// Must be set before app.whenReady()
app.commandLine.appendSwitch('enable-gpu-rasterization');       // GPU-accelerated 2D canvas & CSS
app.commandLine.appendSwitch('enable-oop-rasterization');       // out-of-process rasterisation thread
app.commandLine.appendSwitch('enable-accelerated-video-decode');// hardware video decode (H.264, VP9 …)
app.commandLine.appendSwitch('ignore-gpu-blocklist');           // bypass driver-based GPU blocklist
app.commandLine.appendSwitch('enable-features',
  'VaapiVideoDecoder,VaapiVideoEncoder,CanvasOopRasterization');

const ICON_ICO = path.join(__dirname, 'icon.ico');
const ICON = ICON_ICO;

// ── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let urlDialogWindow = null;
let navDialogWindow = null;
let iframeDialogWindow = null;
let pasteDialogWindow = null;
let pasteBlockerWindow = null;
let credentialDialogWindow = null;
let resolutionDialogWindow = null;
let pasteAborted = false;
let pasteLocked = false;
let pasteSendingSynthetic = false;
let activePasteOperation = null;
let rootUrl = null;          // URL entered at startup
let pendingIframeUrl = null;
let pendingIframeRequest = null;
let iframeExpandRequestId = 0;
const pendingIframeExpansions = new Map();
let pendingCredential = null;
const iframeQueue   = []; // queued iframe srcs waiting for user decision
const mainNavigationHistory = createNavigationHistory({ limit: 50 });
let activeProfileKey = 'default';
let activePartition = partitionForProfile(activeProfileKey);
let activeResolutionSetting = { ...DEFAULT_RESOLUTION_SETTING };
let activeResolutionDisplayBounds = null;
let mainWindowUsesMacSimpleFullscreen = false;
const resolutionHookedPartitions = new Set();

const PASTE_DEFAULT_CHARS_PER_SECOND = 25;
const PASTE_MIN_CHARS_PER_SECOND = 5;
const PASTE_MAX_CHARS_PER_SECOND = 80;
const PASTE_FOCUS_DELAY_MS = 500;
const PASTE_PRIME_DELAY_MS = 150;
const PASTE_FINISH_DELAY_MS = 350;
const PASTE_HURRY_BATCH_SIZE = 20;
const PASTE_HURRY_BATCH_DELAY_MS = 16;
const RESOLUTION_DEBUG_PREFIX = '[JP Entry][resolution]';
let resolutionDebugEnabledCache = null;

function resolutionDebugFlagPath() {
  return path.join(app.getPath('userData'), 'resolution-debug.enabled');
}

function resolutionDebugLogPath() {
  return path.join(app.getPath('userData'), 'resolution-debug.log');
}

function isResolutionDebugEnabled() {
  if (process.env.JP_RESOLUTION_DEBUG === '1') return true;
  if (resolutionDebugEnabledCache != null) return resolutionDebugEnabledCache;

  try {
    resolutionDebugEnabledCache = fs.existsSync(resolutionDebugFlagPath());
  } catch (_err) {
    resolutionDebugEnabledCache = false;
  }
  return resolutionDebugEnabledCache;
}

function safeLogValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function resolutionDebugLog(...parts) {
  if (!isResolutionDebugEnabled()) return;

  const message = parts.map(safeLogValue).join(' ');
  const line = `${new Date().toISOString()} ${message}`;
  console.log(`${RESOLUTION_DEBUG_PREFIX} ${message}`);

  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.appendFileSync(resolutionDebugLogPath(), `${line}\n`, 'utf8');
  } catch (_err) {
    // Debug logging must never affect kiosk navigation.
  }
}

// ── Session setup ─────────────────────────────────────────────────────────────
// Called when a kiosk profile is selected. Each profile gets its own
// persistent Chromium partition so red/yellow instances can run side by side.
const kioskSessions = new Map();
function setupSession(partition = activePartition) {
  if (kioskSessions.has(partition)) {
    return kioskSessions.get(partition);
  }

  const ses = session.fromPartition(partition);
  attachResolutionWebRequestHandler(partition, ses);

  // Allow all cookies (including HTTP, local IPs, non-standard ports)
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: details.responseHeaders });
  });

  kioskSessions.set(partition, ses);
  return ses;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function isMacPlatform() {
  return process.platform === 'darwin';
}

function mainWindowDisplayOptions(display, fullscreen) {
  const bounds = display && display.bounds
    ? display.bounds
    : screen.getPrimaryDisplay().bounds;

  if (isMacPlatform()) {
    const area = fullscreen
      ? bounds
      : ((display && display.workArea) || bounds);
    return {
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      fullscreen: Boolean(fullscreen),
    };
  }

  const options = {
    x: bounds.x,
    y: bounds.y,
  };

  if (fullscreen) {
    options.fullscreen = true;
  }

  return options;
}

function parentedPopupOptions(options = {}) {
  if (!isMacPlatform() || !mainWindow || mainWindow.isDestroyed()) return {};

  return {
    parent: mainWindow,
    modal: options.modal !== false,
  };
}

function keepPopupWithFullscreenParent(browserWindow) {
  if (
    !isMacPlatform() ||
    !mainWindow ||
    mainWindow.isDestroyed() ||
    !browserWindow ||
    browserWindow.isDestroyed()
  ) {
    return;
  }

  if (typeof browserWindow.moveTop === 'function') {
    browserWindow.moveTop();
  }
  if (typeof browserWindow.focus === 'function') {
    browserWindow.focus();
  }
}

function operatorWindowChromeOptions() {
  if (isMacPlatform()) {
    return {
      frame: true,
      alwaysOnTop: false,
      fullscreenable: false,
      useContentSize: true,
    };
  }

  return {
    frame: false,
    alwaysOnTop: true,
  };
}

function installApplicationMenu() {
  if (isMacPlatform()) {
    return;
  }

  Menu.setApplicationMenu(null);
}

function focusPrimaryWindow() {
  const target = [
    resolutionDialogWindow,
    navDialogWindow,
    pasteDialogWindow,
    credentialDialogWindow,
    iframeDialogWindow,
    mainWindow,
    urlDialogWindow,
  ].find((browserWindow) => browserWindow && !browserWindow.isDestroyed());

  if (target) {
    if (typeof target.show === 'function') target.show();
    if (typeof target.focus === 'function') target.focus();
    return;
  }

  if (BrowserWindow.getAllWindows().length === 0) {
    createUrlDialog();
  }
}

// Returns {x, y} to center a dialog of given size on the same display as mainWindow.
function dialogPosition(width, height) {
  const ref = mainWindow || urlDialogWindow;
  const display = ref
    ? screen.getDisplayMatching(ref.getBounds())
    : screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea || display.bounds;
  return {
    x: Math.round(dx + (dw - width) / 2),
    y: Math.round(dy + (dh - height) / 2),
  };
}

function dialogBounds(preferredWidth, preferredHeight, minWidth, minHeight) {
  const ref = mainWindow || urlDialogWindow;
  const display = ref
    ? screen.getDisplayMatching(ref.getBounds())
    : screen.getPrimaryDisplay();
  const area = display.workArea || display.bounds;
  const margin = 32;
  const maxWidth = Math.max(Math.min(minWidth, area.width), area.width - margin);
  const maxHeight = Math.max(Math.min(minHeight, area.height), area.height - margin);
  const width = Math.max(
    320,
    Math.min(preferredWidth, maxWidth)
  );
  const height = Math.max(
    360,
    Math.min(preferredHeight, maxHeight)
  );

  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function displayBoundsFromDisplay(display) {
  const fallback = { width: 0, height: 0 };
  const area = display && (display.bounds || display.workArea);
  if (!area) return fallback;

  return {
    width: Math.round(Number(area.width) || 0),
    height: Math.round(Number(area.height) || 0),
  };
}

function currentResolutionDisplayBounds() {
  const ref = mainWindow || urlDialogWindow || resolutionDialogWindow;
  const display = ref && !ref.isDestroyed()
    ? screen.getDisplayMatching(ref.getBounds())
    : screen.getPrimaryDisplay();
  return displayBoundsFromDisplay(display);
}

function activeResolutionOverrideText() {
  return resolutionOverrideFromSetting(
    activeResolutionSetting,
    activeResolutionDisplayBounds || currentResolutionDisplayBounds()
  );
}

function resolutionDialogPayload(displayBounds = currentResolutionDisplayBounds()) {
  return {
    setting: activeResolutionSetting,
    displayBounds,
    label: resolutionLabel(activeResolutionSetting, displayBounds),
    presets: PRESET_RESOLUTIONS,
    limits: {
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
    },
  };
}

function sendResolutionOverrideToMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  resolutionDebugLog('send renderer override', activeResolutionOverrideText() || '(auto)');
  mainWindow.webContents.send(
    'remote-resolution-override',
    activeResolutionOverrideText()
  );
}

function setActiveResolutionSetting(setting, displayBounds = currentResolutionDisplayBounds()) {
  activeResolutionSetting = normalizeResolutionSetting(setting);
  activeResolutionDisplayBounds = displayBounds;
  resolutionDebugLog(
    'set resolution',
    { setting: activeResolutionSetting, displayBounds, override: activeResolutionOverrideText() || '(auto)' }
  );
  sendResolutionOverrideToMainWindow();
}

function isFullscreenLikeWindow(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return true;
  if (isMacPlatform() && browserWindow === mainWindow && mainWindowUsesMacSimpleFullscreen) {
    return true;
  }

  const nativeFullscreen = typeof browserWindow.isFullScreen === 'function' &&
    browserWindow.isFullScreen();
  const simpleFullscreen = typeof browserWindow.isSimpleFullScreen === 'function' &&
    browserWindow.isSimpleFullScreen();
  return Boolean(nativeFullscreen || simpleFullscreen);
}

function recreateMainWindowForResolutionChange() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const previousWindow = mainWindow;
  const currentUrl = normalizeNavigationUrl(previousWindow.webContents.getURL());
  const requiresFreshConnection = isGuacamoleClientUrl(currentUrl);
  const nextUrl = requiresFreshConnection ? rootUrl : (currentUrl || rootUrl);
  const targetDisplay = screen.getDisplayMatching(previousWindow.getBounds());
  const fullscreen = isFullscreenLikeWindow(previousWindow);

  resolutionDebugLog('recreate main window for resolution change', {
    currentUrl,
    url: nextUrl,
    requiresFreshConnection,
    fullscreen,
    override: activeResolutionOverrideText() || '(auto)',
  });

  closePasteInputBlocker();
  mainWindow = null;
  mainWindowUsesMacSimpleFullscreen = false;

  if (!previousWindow.isDestroyed()) {
    previousWindow.close();
  }

  setTimeout(() => {
    createMainWindow(nextUrl || rootUrl, targetDisplay, fullscreen);
  }, 120);
}

function readableUploadBody(details) {
  const chunks = [];
  for (const item of details.uploadData || []) {
    if (item.bytes) {
      chunks.push(Buffer.from(item.bytes));
    }
  }

  if (!chunks.length) return '';
  return Buffer.concat(chunks).toString('utf8');
}

function uploadResolutionSummary(details) {
  const body = readableUploadBody(details);
  if (!body) return { hasBody: false };

  try {
    const data = JSON.parse(body);
    const options = data && typeof data === 'object' && !Array.isArray(data)
      ? data.connect_options
      : null;
    return {
      hasBody: true,
      hasConnectOptions: Boolean(options && typeof options === 'object' && !Array.isArray(options)),
      resolution: options && options.resolution ? String(options.resolution) : '',
    };
  } catch (_err) {
    return { hasBody: true, json: false };
  }
}

function describeRequestUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = url.searchParams;
    return {
      location: `${url.protocol}//${url.host}${url.pathname}`,
      width: params.get('GUAC_WIDTH') || '',
      height: params.get('GUAC_HEIGHT') || '',
    };
  } catch (_err) {
    return { location: String(rawUrl || '') };
  }
}

function attachResolutionWebRequestHandler(partition, ses) {
  if (resolutionHookedPartitions.has(partition)) return;
  resolutionHookedPartitions.add(partition);

  resolutionDebugLog('attach webRequest', partition);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const isWebSocketRequest = /^wss?:/i.test(details.url);

    if (isConnectionTokenUrl(details.url)) {
      resolutionDebugLog(
        'token request observed',
        details.method,
        describeRequestUrl(details.url),
        uploadResolutionSummary(details)
      );
      callback({});
      return;
    }

    const nextUrl = applyResolutionToGuacamoleUrl(
      details.url,
      activeResolutionOverrideText()
    );

    if (isLionConnectWebSocketUrl(details.url) || isLionConnectWebSocketUrl(nextUrl)) {
      resolutionDebugLog(
        nextUrl && nextUrl !== details.url ? 'guacamole ws redirect' : 'guacamole ws observed',
        {
          override: activeResolutionOverrideText() || '(auto)',
          before: describeRequestUrl(details.url),
          after: describeRequestUrl(nextUrl),
        }
      );
    } else if (isWebSocketRequest && (/\/lion\/|\/guacamole\/|GUAC_WIDTH|GUAC_HEIGHT/i.test(details.url))) {
      resolutionDebugLog('ws observed non-matching', describeRequestUrl(details.url));
    }

    callback(nextUrl && nextUrl !== details.url ? { redirectURL: nextUrl } : {});
  });
}

function loadMainUrl(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const normalizedUrl = normalizeNavigationUrl(url);
  if (!normalizedUrl) return false;

  mainWindow.loadURL(normalizedUrl).catch(() => {});
  return true;
}

function normalizeIframeRequest(payload) {
  const url = typeof payload === 'string' ? payload : payload && payload.url;
  if (!normalizeNavigationUrl(url)) return null;

  return { url };
}

function noteIframeExpandFailure(request, reason) {
  resolutionDebugLog('could not expand lion iframe in place', {
    reason,
    url: request && request.url,
  });
  return false;
}

function expandIframeInPlace(request) {
  if (!mainWindow || mainWindow.isDestroyed() || !request) return false;

  const requestId = String(++iframeExpandRequestId);
  pendingIframeExpansions.set(requestId, request);
  mainWindow.webContents.send('expand-iframe', {
    requestId,
    url: request.url,
  });

  setTimeout(() => {
    const pendingRequest = pendingIframeExpansions.get(requestId);
    if (!pendingRequest) return;

    pendingIframeExpansions.delete(requestId);
    noteIframeExpandFailure(pendingRequest, 'expand-timeout');
  }, 800);

  resolutionDebugLog('expand lion iframe in place', { url: request.url });
  return true;
}

function loadIframeRequest(request) {
  if (!request) return false;

  if (isLionConnectPageUrl(request.url)) {
    return expandIframeInPlace(request);
  }

  return loadMainUrl(request.url);
}

function loadPreviousRecordedMainPage(currentUrl) {
  const previousUrl = mainNavigationHistory.previous(currentUrl);
  if (!previousUrl) return false;

  return loadMainUrl(previousUrl);
}

function goToPreviousMainPage() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const currentUrl = normalizeNavigationUrl(mainWindow.webContents.getURL());
  if (mainWindow.webContents.canGoBack()) {
    mainWindow.webContents.goBack();
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const nextUrl = normalizeNavigationUrl(mainWindow.webContents.getURL());
      if (nextUrl === currentUrl) {
        loadPreviousRecordedMainPage(currentUrl);
      }
    }, 600);
    return true;
  }

  return loadPreviousRecordedMainPage(currentUrl);
}

function handleWindowScopedShortcut(input) {
  if (isShortcutKey(input, 'h')) {
    if (!pasteLocked && mainWindow) createNavDialog();
    return true;
  }

  if (isShortcutKey(input, 'v')) {
    openClipboardPasteDialog();
    return true;
  }

  if (isShortcutKey(input, 'q', { shift: true })) {
    if (pasteLocked) {
      cancelActivePasteOperation();
    } else {
      app.quit();
    }
    return true;
  }

  return false;
}

function attachWindowScopedShortcuts(browserWindow) {
  if (!browserWindow || browserWindow.isDestroyed()) return;

  browserWindow.webContents.on('before-input-event', (event, input) => {
    if (!handleWindowScopedShortcut(input)) return;
    event.preventDefault();
  });
}

function eventOrigin(event) {
  return normalizeOrigin(event.senderFrame && event.senderFrame.url);
}

function getOtpTokenForUrl(url, options = {}) {
  const otpOrigin = otpOriginForUrl(url, options);
  if (!otpOrigin) return null;

  const credential = getCredential(otpOrigin);
  if (!credential || !credential.mfaSecret) return null;

  return otpTokenFromSecret(authenticator, credential.mfaSecret);
}

function pasteCharacters(text) {
  return Array.from(String(text || ''));
}

function normalizeCharsPerSecond(charsPerSecond) {
  const value = Number(charsPerSecond);
  if (!Number.isFinite(value)) return PASTE_DEFAULT_CHARS_PER_SECOND;

  return Math.max(
    PASTE_MIN_CHARS_PER_SECOND,
    Math.min(PASTE_MAX_CHARS_PER_SECOND, Math.round(value))
  );
}

function pasteCharDelayMs(charsPerSecond) {
  return Math.round(1000 / normalizeCharsPerSecond(charsPerSecond));
}

function pasteRequestFromPayload(payload) {
  if (typeof payload === 'string') {
    return {
      text: payload,
      charsPerSecond: PASTE_DEFAULT_CHARS_PER_SECOND,
      charDelayMs: pasteCharDelayMs(PASTE_DEFAULT_CHARS_PER_SECOND),
      hurryMode: false,
    };
  }

  const charsPerSecond = normalizeCharsPerSecond(
    payload && payload.charsPerSecond
  );

  return {
    text: String((payload && payload.text) || ''),
    charsPerSecond,
    charDelayMs: pasteCharDelayMs(charsPerSecond),
    hurryMode: Boolean(payload && payload.hurryMode),
  };
}

function estimatePasteDurationMs(
  text,
  charsPerSecond = PASTE_DEFAULT_CHARS_PER_SECOND,
  hurryMode = false
) {
  const total = pasteCharacters(text).length;
  if (!total) return 0;

  const duration = PASTE_FOCUS_DELAY_MS +
    PASTE_PRIME_DELAY_MS +
    (hurryMode
      ? Math.ceil(total / PASTE_HURRY_BATCH_SIZE) * PASTE_HURRY_BATCH_DELAY_MS
      : total * pasteCharDelayMs(charsPerSecond)) +
    PASTE_FINISH_DELAY_MS;
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function pasteDialogPayload(text, source) {
  return {
    text: String(text || ''),
    source,
    estimateMs: estimatePasteDurationMs(text),
    defaultCharsPerSecond: PASTE_DEFAULT_CHARS_PER_SECOND,
    minCharsPerSecond: PASTE_MIN_CHARS_PER_SECOND,
    maxCharsPerSecond: PASTE_MAX_CHARS_PER_SECOND,
    focusDelayMs: PASTE_FOCUS_DELAY_MS,
    primeDelayMs: PASTE_PRIME_DELAY_MS,
    finishDelayMs: PASTE_FINISH_DELAY_MS,
    hurryBatchSize: PASTE_HURRY_BATCH_SIZE,
    hurryBatchDelayMs: PASTE_HURRY_BATCH_DELAY_MS,
  };
}

function setPasteDialogInputLocked(locked) {
  if (!pasteDialogWindow || pasteDialogWindow.isDestroyed()) return;

  if (typeof pasteDialogWindow.setFocusable === 'function') {
    pasteDialogWindow.setFocusable(!locked);
  }
  pasteDialogWindow.setIgnoreMouseEvents(locked);
}

function closePasteInputBlocker() {
  if (pasteBlockerWindow && !pasteBlockerWindow.isDestroyed()) {
    pasteBlockerWindow.close();
  }
  pasteBlockerWindow = null;
}

function showPasteInputBlocker() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (pasteBlockerWindow && !pasteBlockerWindow.isDestroyed()) {
    pasteBlockerWindow.showInactive();
    return;
  }

  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const bounds = display.bounds || mainWindow.getBounds();
  pasteBlockerWindow = new BrowserWindow({
    ...parentedPopupOptions({ modal: false }),
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  keepPopupWithFullscreenParent(pasteBlockerWindow);
  pasteBlockerWindow.setAlwaysOnTop(true, 'screen-saver');

  pasteBlockerWindow.loadURL(
    'data:text/html;charset=utf-8,' +
    encodeURIComponent('<!doctype html><html><body style="width:100vw;height:100vh;margin:0;background:rgba(0,0,0,0.01);cursor:not-allowed;"></body></html>')
  );
  pasteBlockerWindow.setIgnoreMouseEvents(false);
  pasteBlockerWindow.once('closed', () => {
    pasteBlockerWindow = null;
  });
  pasteBlockerWindow.once('ready-to-show', () => {
    if (pasteBlockerWindow && !pasteBlockerWindow.isDestroyed()) {
      pasteBlockerWindow.showInactive();
    }
  });
}

function beginPasteInputLock() {
  pasteLocked = true;
  showPasteInputBlocker();
  setPasteDialogInputLocked(true);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(false);
  }
}

function endPasteInputLock() {
  pasteLocked = false;
  setPasteDialogInputLocked(false);
  closePasteInputBlocker();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(false);
  }
}

function sendSyntheticInputEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  pasteSendingSynthetic = true;
  try {
    mainWindow.webContents.sendInputEvent(event);
  } finally {
    pasteSendingSynthetic = false;
  }
}

function primePasteTarget() {
  sendSyntheticInputEvent({ type: 'keyDown', keyCode: 'Shift' });
  sendSyntheticInputEvent({ type: 'keyUp', keyCode: 'Shift' });
}

function cancelActivePasteOperation() {
  if (!activePasteOperation && !pasteLocked) return;

  pasteAborted = true;
  if (activePasteOperation) {
    activePasteOperation.aborted = true;
    activePasteOperation = null;
  }

  endPasteInputLock();

  if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
    pasteDialogWindow.webContents.send('paste-canceled');
    setTimeout(() => {
      if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
        pasteDialogWindow.close();
      }
    }, 180);
  }
}

function completeActivePasteOperation() {
  activePasteOperation = null;
  endPasteInputLock();

  if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
    pasteDialogWindow.webContents.send('paste-complete');
    setTimeout(() => {
      if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
        pasteDialogWindow.close();
      }
    }, PASTE_FINISH_DELAY_MS);
  }
}

function openClipboardPasteDialog() {
  if (!mainWindow || pasteLocked) return;

  const text = clipboard.readText();
  createPasteDialog(text, 'shortcut');
}

function requestOtpFillSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.webContents.send('otp-fill-now');
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('otp-fill-now');
    }
  }, 500);
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('otp-fill-now');
    }
  }, 1200);
}

function createUrlDialog() {
  urlDialogWindow = new BrowserWindow({
    width: 540,
    height: 520,
    resizable: false,
    ...operatorWindowChromeOptions(),
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  attachWindowScopedShortcuts(urlDialogWindow);
  urlDialogWindow.loadFile(path.join(__dirname, 'url-dialog.html'));
  urlDialogWindow.webContents.on('did-finish-load', () => {
    if (urlDialogWindow && !urlDialogWindow.isDestroyed()) {
      urlDialogWindow.webContents.send('kiosk-zones', {
        zones: KIOSK_ZONES,
        defaultZone: DEFAULT_KIOSK_ZONE,
      });
      urlDialogWindow.webContents.send(
        'resolution-options',
        resolutionDialogPayload(currentResolutionDisplayBounds())
      );
    }
  });
  urlDialogWindow.on('closed', () => { urlDialogWindow = null; });
}

function createMainWindow(url, targetDisplay, fullscreen = true, zoneKey = '') {
  rootUrl = url;
  mainNavigationHistory.reset(url);
  setActiveResolutionSetting(
    activeResolutionSetting,
    displayBoundsFromDisplay(targetDisplay || screen.getPrimaryDisplay())
  );
  activeProfileKey = profileKeyForKiosk(url, {
    zones: KIOSK_ZONES,
    zoneKey,
    defaultKey: DEFAULT_KIOSK_ZONE,
  });
  activePartition = partitionForProfile(activeProfileKey);
  setupSession(activePartition);
  mainWindowUsesMacSimpleFullscreen = isMacPlatform() && Boolean(fullscreen);

  mainWindow = new BrowserWindow({
    ...mainWindowDisplayOptions(targetDisplay, fullscreen),
    kiosk: false,
    icon: ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      nodeIntegrationInSubFrames: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: activePartition,
      additionalArguments: [
        `--jp-remote-resolution=${encodeURIComponent(activeResolutionOverrideText())}`,
        `--jp-resolution-debug=${isResolutionDebugEnabled() ? '1' : '0'}`,
      ],
    },
  });

  resolutionDebugLog('create main window', {
    url,
    profileKey: activeProfileKey,
    partition: activePartition,
    override: activeResolutionOverrideText() || '(auto)',
  });

  mainWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    if (String(message || '').includes(RESOLUTION_DEBUG_PREFIX)) {
      resolutionDebugLog('renderer', { message, line, sourceId });
    }
  });

  loadMainUrl(url);

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (handleWindowScopedShortcut(input)) {
      event.preventDefault();
      return;
    }

    if (!pasteLocked) return;

    if (input.key === 'Escape') {
      event.preventDefault();
      cancelActivePasteOperation();
      return;
    }

    if (!pasteSendingSynthetic) {
      event.preventDefault();
    }
  });

  // Inject a focus tracker so we can find the last focused input after popups steal focus
  function injectFocusTracker() {
    mainWindow.webContents.executeJavaScript(`
      if (!window.__jpFocusTracking) {
        window.__jpFocusTracking = true;
        window.__jpLastFocused = null;
        function isPasteFocusCandidate(target) {
          if (!target) return false;
          return target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'IFRAME' ||
            target.tagName === 'CANVAS' ||
            target.isContentEditable;
        }
        function rememberFocus(target) {
          if (isPasteFocusCandidate(target)) {
            window.__jpLastFocused = target;
          }
        }
        document.addEventListener('focusin', function(e) {
          rememberFocus(e.target);
        }, true);
        document.addEventListener('mousedown', function(e) {
          rememberFocus(e.target);
        }, true);
        window.addEventListener('blur', function() {
          rememberFocus(document.activeElement);
        }, true);
        document.addEventListener('pointerdown', function(e) {
          rememberFocus(e.target);
        }, true);
        document.addEventListener('touchstart', function(e) {
          rememberFocus(e.target);
        }, true);
      }
    `).catch(() => {});
  }
  mainWindow.webContents.on('did-finish-load', injectFocusTracker);
  mainWindow.webContents.on('did-finish-load', requestOtpFillSoon);
  mainWindow.webContents.on('did-finish-load', sendResolutionOverrideToMainWindow);
  mainWindow.webContents.on('did-navigate', (_event, navigatedUrl) => {
    mainNavigationHistory.record(navigatedUrl);
    injectFocusTracker();
    requestOtpFillSoon();
  });
  mainWindow.webContents.on('did-navigate-in-page', (_event, navigatedUrl, isMainFrame) => {
    if (isMainFrame !== false) {
      mainNavigationHistory.record(navigatedUrl);
    }
    injectFocusTracker();
    requestOtpFillSoon();
  });

  // Redirect all new-window requests (target="_blank", window.open) into the main window
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    loadMainUrl(targetUrl);
    return { action: 'deny' }; // block the new window
  });

  // Suppress "Leave site? Changes you made may not be saved" dialogs
  // so they don't block our kiosk popup windows.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  const createdMainWindow = mainWindow;
  mainWindow.on('closed', () => {
    closePasteInputBlocker();
    if (mainWindow === createdMainWindow) {
      mainWindowUsesMacSimpleFullscreen = false;
      mainWindow = null;
    }
  });
}

function createNavDialog() {
  if (navDialogWindow) { navDialogWindow.focus(); return; }

  const { x, y } = dialogPosition(400, 590);
  navDialogWindow = new BrowserWindow({
    ...parentedPopupOptions(),
    x, y,
    width: 400,
    height: 590,
    resizable: false,
    ...operatorWindowChromeOptions(),
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  keepPopupWithFullscreenParent(navDialogWindow);
  attachWindowScopedShortcuts(navDialogWindow);
  navDialogWindow.loadFile(path.join(__dirname, 'nav-dialog.html'));
  navDialogWindow.on('closed', () => { navDialogWindow = null; });
}

function createResolutionDialog() {
  if (resolutionDialogWindow && !resolutionDialogWindow.isDestroyed()) {
    resolutionDialogWindow.focus();
    return;
  }

  const { x, y } = dialogPosition(480, 430);
  resolutionDialogWindow = new BrowserWindow({
    ...parentedPopupOptions(),
    x, y,
    width: 480,
    height: 430,
    resizable: false,
    ...operatorWindowChromeOptions(),
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  keepPopupWithFullscreenParent(resolutionDialogWindow);
  attachWindowScopedShortcuts(resolutionDialogWindow);
  resolutionDialogWindow.loadFile(path.join(__dirname, 'resolution-dialog.html'));
  resolutionDialogWindow.webContents.on('did-finish-load', () => {
    if (resolutionDialogWindow && !resolutionDialogWindow.isDestroyed()) {
      resolutionDialogWindow.webContents.send(
        'resolution-init',
        resolutionDialogPayload(currentResolutionDisplayBounds())
      );
    }
  });
  resolutionDialogWindow.on('closed', () => {
    resolutionDialogWindow = null;
  });
}

function createPasteDialog(initialText = '', source = 'manual') {
  if (pasteDialogWindow) { pasteDialogWindow.focus(); return; }

  const { x, y, width, height } = dialogBounds(620, 620, 520, 500);
  pasteDialogWindow = new BrowserWindow({
    ...parentedPopupOptions(),
    x, y,
    width,
    height,
    resizable: false,
    transparent: !isMacPlatform(),
    ...operatorWindowChromeOptions(),
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  keepPopupWithFullscreenParent(pasteDialogWindow);
  attachWindowScopedShortcuts(pasteDialogWindow);
  pasteDialogWindow.loadFile(path.join(__dirname, 'paste-dialog.html'));
  pasteDialogWindow.webContents.on('did-finish-load', () => {
    if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
      pasteDialogWindow.webContents.send(
        'paste-init',
        pasteDialogPayload(initialText, source)
      );
    }
  });
  pasteDialogWindow.on('closed', () => {
    if (activePasteOperation) {
      pasteAborted = true;
      activePasteOperation.aborted = true;
      activePasteOperation = null;
      endPasteInputLock();
    }
    pasteDialogWindow = null;
  });
}

function createCredentialDialog(credential, mode) {
  if (credentialDialogWindow && !credentialDialogWindow.isDestroyed()) {
    credentialDialogWindow.close();
  }

  const existingCredential = getCredential(credential.origin);
  const mfaSecret = credential.mfaSecret ||
    (existingCredential && existingCredential.mfaSecret) ||
    '';
  pendingCredential = {
    origin: credential.origin,
    username: String(credential.username || ''),
    password: String(credential.password || ''),
    mfaSecret,
    mode,
  };

  const { x, y } = dialogPosition(500, 390);
  credentialDialogWindow = new BrowserWindow({
    ...parentedPopupOptions(),
    x, y,
    width: 500,
    height: 390,
    resizable: false,
    ...operatorWindowChromeOptions(),
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  keepPopupWithFullscreenParent(credentialDialogWindow);
  attachWindowScopedShortcuts(credentialDialogWindow);
  credentialDialogWindow.loadFile(path.join(__dirname, 'credential-dialog.html'));
  credentialDialogWindow.webContents.on('did-finish-load', () => {
    if (credentialDialogWindow && !credentialDialogWindow.isDestroyed()) {
      credentialDialogWindow.webContents.send('credential-prompt', {
        mode,
        origin: pendingCredential.origin,
        username: pendingCredential.username,
        mfaSecret: pendingCredential.mfaSecret,
      });
    }
  });
  credentialDialogWindow.on('closed', () => {
    credentialDialogWindow = null;
    pendingCredential = null;
  });
}

function createIframeDialog(iframePayload) {
  const iframeRequest = normalizeIframeRequest(iframePayload);
  if (!iframeRequest) return;

  if (iframeDialogWindow) {
    // Dialog already open - queue for later.
    const alreadyQueued = iframeQueue.some((queued) => queued.url === iframeRequest.url);
    if (!alreadyQueued && iframeRequest.url !== pendingIframeUrl) {
      iframeQueue.push(iframeRequest);
    }
    iframeDialogWindow.focus();
    return;
  }

  pendingIframeRequest = iframeRequest;
  pendingIframeUrl = iframeRequest.url;

  const { x, y } = dialogPosition(460, 280);
  iframeDialogWindow = new BrowserWindow({
    ...parentedPopupOptions(),
    x, y,
    width: 460,
    height: 280,
    resizable: false,
    ...operatorWindowChromeOptions(),
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  keepPopupWithFullscreenParent(iframeDialogWindow);
  attachWindowScopedShortcuts(iframeDialogWindow);
  iframeDialogWindow.loadFile(
    path.join(__dirname, 'iframe-dialog.html')
  );
  iframeDialogWindow.webContents.on('did-finish-load', () => {
    iframeDialogWindow.webContents.send('iframe-url', iframeRequest.url);
  });
  iframeDialogWindow.on('closed', () => {
    iframeDialogWindow = null;
    pendingIframeUrl = null;
    pendingIframeRequest = null;
    // Show next queued iframe if any.
    if (iframeQueue.length > 0) {
      createIframeDialog(iframeQueue.shift());
    }
  });
}
// ── Global shortcuts ─────────────────────────────────────────────────────────
// Window-scoped shortcuts are handled with before-input-event so multiple
// app instances can use the same key bindings without OS-level conflicts.

// ── IPC handlers ─────────────────────────────────────────────────────────────

// User submitted URL in startup dialog
ipcMain.on('url-submitted', (_event, payload) => {
  // Detect which display the URL dialog is currently on, so the kiosk
  // opens on the same screen the user dragged the dialog to.
  const targetDisplay = urlDialogWindow
    ? screen.getDisplayMatching(urlDialogWindow.getBounds())
    : screen.getPrimaryDisplay();

  if (urlDialogWindow) {
    urlDialogWindow.close();
  }
  const url = typeof payload === 'string' ? payload : payload.url;
  const fullscreen = typeof payload === 'string' ? true : Boolean(payload.fullscreen);
  const zoneKey = typeof payload === 'string' ? '' : payload.zone;
  const resolutionSetting = typeof payload === 'string'
    ? activeResolutionSetting
    : payload.resolution;
  setActiveResolutionSetting(
    resolutionSetting,
    displayBoundsFromDisplay(targetDisplay)
  );
  createMainWindow(url, targetDisplay, fullscreen, zoneKey);
});

// Navigation popup actions
ipcMain.on('nav-action', (_event, action) => {
  if (pasteLocked) return;

  if (action === 'paste') {
    if (navDialogWindow) navDialogWindow.close();
    createPasteDialog();
    return;
  }

  if (action === 'clear-all-credentials') {
    if (navDialogWindow) navDialogWindow.close();
    const targetWindow = mainWindow || BrowserWindow.getFocusedWindow();
    const options = {
      type: 'question',
      message: 'Clear all saved passwords?',
      detail: 'This removes every password saved by JP Entry on this machine.',
      buttons: ['Clear All', 'Cancel'],
      cancelId: 1,
      defaultId: 1,
    };
    const messageBox = targetWindow
      ? dialog.showMessageBox(targetWindow, options)
      : dialog.showMessageBox(options);
    messageBox.then((result) => {
      if (result.response === 0) {
        deleteAllCredentials();
      }
    }).catch(() => {});
    return;
  }

  if (action === 'resolution') {
    if (navDialogWindow) navDialogWindow.close();
    createResolutionDialog();
    return;
  }

  if (navDialogWindow) navDialogWindow.close();

  if (action === 'quit') {
    app.quit();
    return;
  }

  if (!mainWindow) return;

  if (action === 'check-iframes') {
    mainWindow.webContents.send('force-check-iframes');
    return;
  }

  if (action === 'root') {
    loadMainUrl(rootUrl);
  } else if (action === 'back') {
    goToPreviousMainPage();
  }
  // 'cancel' — do nothing
});

// iframe detected in page
ipcMain.on('iframe-detected', (_event, iframePayload) => {
  createIframeDialog(iframePayload);
});

// User decision on iframe redirect
ipcMain.on('iframe-action', (_event, action) => {
  const request = pendingIframeRequest;
  if (iframeDialogWindow) iframeDialogWindow.close();

  if (action === 'navigate' && request && mainWindow) {
    loadIframeRequest(request);
  }
});

ipcMain.on('expand-iframe-result', (event, result) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;

  const requestId = result && result.requestId;
  const request = pendingIframeExpansions.get(requestId);
  if (!request) return;

  pendingIframeExpansions.delete(requestId);
  if (result.ok) {
    resolutionDebugLog('expanded lion iframe in place', { url: request.url });
    return;
  }

  noteIframeExpandFailure(request, 'expand-not-found');
});

ipcMain.on('resolution-action', (_event, payload) => {
  const action = payload && payload.action;
  let shouldReloadMainWindow = false;

  if (action === 'save') {
    setActiveResolutionSetting(
      payload.setting,
      currentResolutionDisplayBounds()
    );
    shouldReloadMainWindow = Boolean(mainWindow && !mainWindow.isDestroyed());
  }

  if (resolutionDialogWindow && !resolutionDialogWindow.isDestroyed()) {
    resolutionDialogWindow.close();
  }

  if (shouldReloadMainWindow) {
    recreateMainWindowForResolutionChange();
  }
});

// Paste dialog: inject text into the focused element using paced sendInputEvent.
// One visible character is sent per interval so fragile terminals can keep up.
// \n → Return key, \t → Tab key, other chars via type:'char'.
ipcMain.on('paste-apply', (_event, payload) => {
  const request = pasteRequestFromPayload(payload);
  const { text, charsPerSecond, charDelayMs, hurryMode } = request;

  if (!mainWindow || !text) {
    if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
      pasteDialogWindow.webContents.send('paste-empty');
    }
    return;
  }

  pasteAborted = false;
  activePasteOperation = { aborted: false };
  beginPasteInputLock();

  if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
    pasteDialogWindow.webContents.send('paste-started', {
      total: pasteCharacters(text).length,
      estimateMs: estimatePasteDurationMs(text, charsPerSecond, hurryMode),
      charsPerSecond,
      hurryMode,
    });
  }

  const operation = activePasteOperation;

  mainWindow.focus();
  mainWindow.webContents.focus();

  // Re-focus the element the user was in before the popup opened
  mainWindow.webContents.executeJavaScript(`
    (function() {
      var el = window.__jpLastFocused || document.activeElement;
      if (el && el !== document.body) {
        el.focus({ preventScroll: true });
        if (el.tagName === 'IFRAME' && el.contentWindow) {
          try { el.contentWindow.focus(); } catch (_err) {}
        }
      }
    })();
  `).finally(() => {
    const chars = Array.from(text); // handles multi-byte chars correctly
    const total = chars.length;
    let i = 0;

    const sendCharacter = (char) => {
      if (char === '\n') {
        sendSyntheticInputEvent({ type: 'keyDown', keyCode: 'Return' });
        sendSyntheticInputEvent({ type: 'keyUp', keyCode: 'Return' });
      } else if (char === '\t') {
        // Send as char event to insert literal tab, not as a Tab key (which triggers indentation/navigation)
        sendSyntheticInputEvent({ type: 'char', keyCode: '\t' });
      } else if (char !== '\r') {
        sendSyntheticInputEvent({ type: 'char', keyCode: char });
      }
    };

    const sendNextCharacter = () => {
      if (pasteAborted || !mainWindow || !operation || operation.aborted) return;

      sendCharacter(chars[i++]);

      if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
        pasteDialogWindow.webContents.send('paste-progress', { current: i, total });
      }

      if (i < chars.length) {
        setTimeout(sendNextCharacter, charDelayMs);
      } else {
        // Typing complete — close dialog after a brief pause so user sees 100%
        completeActivePasteOperation();
      }
    };

    const sendNextBatch = () => {
      if (pasteAborted || !mainWindow || !operation || operation.aborted) return;

      const end = Math.min(i + PASTE_HURRY_BATCH_SIZE, chars.length);
      while (i < end) {
        sendCharacter(chars[i++]);
      }

      if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
        pasteDialogWindow.webContents.send('paste-progress', { current: i, total });
      }

      if (i < chars.length) {
        setTimeout(sendNextBatch, PASTE_HURRY_BATCH_DELAY_MS);
      } else {
        completeActivePasteOperation();
      }
    };

    setTimeout(() => {
      if (pasteAborted || !mainWindow || !operation || operation.aborted) return;
      mainWindow.focus();
      mainWindow.webContents.focus();
      primePasteTarget();

      setTimeout(() => {
        if (pasteAborted || !mainWindow || !operation || operation.aborted) return;
        mainWindow.focus();
        mainWindow.webContents.focus();
        if (hurryMode) {
          sendNextBatch();
        } else {
          sendNextCharacter();
        }
      }, PASTE_PRIME_DELAY_MS);
    }, PASTE_FOCUS_DELAY_MS);
  });
});

ipcMain.on('paste-cancel-operation', () => {
  cancelActivePasteOperation();
});

ipcMain.on('paste-cancel', () => {
  if (pasteDialogWindow) pasteDialogWindow.close();
});

ipcMain.handle('paste-estimate', (_event, payload) => {
  const request = pasteRequestFromPayload(payload);
  return estimatePasteDurationMs(
    request.text,
    request.charsPerSecond,
    request.hurryMode
  );
});

ipcMain.handle('kiosk-config', () => ({
  zones: KIOSK_ZONES,
  defaultZone: DEFAULT_KIOSK_ZONE,
  otpLoginPath: OTP_LOGIN_PATH,
}));

ipcMain.handle('credentials-get', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null;

  const origin = eventOrigin(event);
  const credential = getCredential(origin);
  if (!credential) return null;

  return {
    origin: credential.origin,
    username: credential.username,
    password: credential.password,
  };
});

ipcMain.handle('otp-get', (event, payload) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null;
  const url = typeof payload === 'string' ? payload : payload && payload.url;
  const hasOtpInput = Boolean(
    payload && typeof payload === 'object' && payload.hasOtpInput
  );
  const otpOrigin = otpOriginForUrl(url, { hasOtpInput });
  if (!otpOrigin || eventOrigin(event) !== otpOrigin) return null;
  return getOtpTokenForUrl(url, { hasOtpInput });
});

ipcMain.on('credentials-captured', (event, candidate) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;

  const origin = eventOrigin(event);
  if (!origin || !candidate || !candidate.password) return;

  const credential = {
    origin,
    username: String(candidate.username || '').slice(0, 512),
    password: String(candidate.password || '').slice(0, 4096),
  };
  const mode = shouldPromptForCredential(credential);
  if (!mode) return;

  setTimeout(() => {
    const nextMode = shouldPromptForCredential(credential);
    if (nextMode) {
      createCredentialDialog(credential, nextMode);
    }
  }, 900);
});

ipcMain.on('credential-action', (_event, action) => {
  if (!pendingCredential) {
    if (credentialDialogWindow) credentialDialogWindow.close();
    return;
  }

  if (action === 'save') {
    pendingCredential.mfaSecret = normalizeOtpSecret(
      pendingCredential.mfaSecret || ''
    );
    const saved = saveCredential(pendingCredential);
    if (!saved && credentialDialogWindow && !credentialDialogWindow.isDestroyed()) {
      credentialDialogWindow.webContents.send('credential-error', {
        message: canStoreCredentials()
          ? 'Enter a valid MFA secret before saving.'
          : 'Password encryption is unavailable on this system.',
      });
      return;
    }
    requestOtpFillSoon();
  }

  if (credentialDialogWindow && !credentialDialogWindow.isDestroyed()) {
    credentialDialogWindow.close();
  }
});

ipcMain.on('credential-mfa-secret-changed', (_event, value) => {
  if (!pendingCredential) return;
  pendingCredential.mfaSecret = normalizeOtpSecret(value);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  installApplicationMenu();
  createUrlDialog();
});

app.on('activate', () => {
  focusPrimaryWindow();
});

app.on('before-quit', async () => {
  // Flush the kiosk session's cookie store so login state survives restarts.
  // Electron/Chromium buffers cookie writes; without this they can be lost on exit.
  for (const ses of kioskSessions.values()) {
    await ses.cookies.flushStore().catch(() => {});
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
