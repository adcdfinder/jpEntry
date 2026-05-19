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
  getCredentialRecord,
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

const ICON = path.join(__dirname, 'icon.ico');

// ── State ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let urlDialogWindow = null;
let navDialogWindow = null;
let iframeDialogWindow = null;
let pasteDialogWindow = null;
let credentialDialogWindow = null;
let pasteAborted = false;
let pasteLocked = false;
let pasteSendingSynthetic = false;
let activePasteOperation = null;
let rootUrl = null;          // URL entered at startup
let pendingIframeUrl = null;
let pendingCredential = null;
const iframeQueue   = []; // queued iframe srcs waiting for user decision
const mainNavigationHistory = createNavigationHistory({ limit: 50 });
let activeProfileKey = 'default';
let activePartition = partitionForProfile(activeProfileKey);

const PASTE_DEFAULT_CHARS_PER_SECOND = 25;
const PASTE_MIN_CHARS_PER_SECOND = 5;
const PASTE_MAX_CHARS_PER_SECOND = 80;
const PASTE_FOCUS_DELAY_MS = 500;
const PASTE_PRIME_DELAY_MS = 150;
const PASTE_FINISH_DELAY_MS = 350;
const PASTE_HURRY_BATCH_SIZE = 20;
const PASTE_HURRY_BATCH_DELAY_MS = 16;

// ── Session setup ─────────────────────────────────────────────────────────────
// Called when a kiosk profile is selected. Each profile gets its own
// persistent Chromium partition so red/yellow instances can run side by side.
const kioskSessions = new Map();
function setupSession(partition = activePartition) {
  if (kioskSessions.has(partition)) {
    return kioskSessions.get(partition);
  }

  const ses = session.fromPartition(partition);

  // Allow all cookies (including HTTP, local IPs, non-standard ports)
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: details.responseHeaders });
  });

  kioskSessions.set(partition, ses);
  return ses;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

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

function loadMainUrl(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const normalizedUrl = normalizeNavigationUrl(url);
  if (!normalizedUrl) return false;

  mainWindow.loadURL(normalizedUrl).catch(() => {});
  return true;
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

function isShortcutKey(input, key, options = {}) {
  if (!input || input.type !== 'keyDown') return false;
  return Boolean(
    input.control &&
    input.alt &&
    !input.meta &&
    Boolean(input.shift) === Boolean(options.shift) &&
    String(input.key || '').toLowerCase() === key
  );
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

  return PASTE_FOCUS_DELAY_MS +
    PASTE_PRIME_DELAY_MS +
    (hurryMode
      ? Math.ceil(total / PASTE_HURRY_BATCH_SIZE) * PASTE_HURRY_BATCH_DELAY_MS
      : total * pasteCharDelayMs(charsPerSecond)) +
    PASTE_FINISH_DELAY_MS;
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

function beginPasteInputLock() {
  pasteLocked = true;
  setPasteDialogInputLocked(true);

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(true);
  }
}

function endPasteInputLock() {
  pasteLocked = false;
  setPasteDialogInputLocked(false);

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
    width: 520,
    height: 380,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
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
    }
  });
  urlDialogWindow.on('closed', () => { urlDialogWindow = null; });
}

function createMainWindow(url, targetDisplay, fullscreen = true, zoneKey = '') {
  rootUrl = url;
  mainNavigationHistory.reset(url);
  activeProfileKey = profileKeyForKiosk(url, {
    zones: KIOSK_ZONES,
    zoneKey,
    defaultKey: DEFAULT_KIOSK_ZONE,
  });
  activePartition = partitionForProfile(activeProfileKey);
  setupSession(activePartition);

  const { x, y } = targetDisplay ? targetDisplay.bounds : { x: 0, y: 0 };

  mainWindow = new BrowserWindow({
    x,
    y,
    fullscreen: fullscreen,
    kiosk: false,
    icon: ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: activePartition,
    },
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

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createNavDialog() {
  if (navDialogWindow) { navDialogWindow.focus(); return; }

  const { x, y } = dialogPosition(400, 560);
  navDialogWindow = new BrowserWindow({
    x, y,
    width: 400,
    height: 560,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  attachWindowScopedShortcuts(navDialogWindow);
  navDialogWindow.loadFile(path.join(__dirname, 'nav-dialog.html'));
  navDialogWindow.on('closed', () => { navDialogWindow = null; });
}

function createPasteDialog(initialText = '', source = 'manual') {
  if (pasteDialogWindow) { pasteDialogWindow.focus(); return; }

  const { x, y, width, height } = dialogBounds(620, 620, 520, 500);
  pasteDialogWindow = new BrowserWindow({
    x, y,
    width,
    height,
    resizable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
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

  const existingRecord = getCredentialRecord(credential.origin);
  const mfaSecret = credential.mfaSecret ||
    (existingRecord && existingRecord.mfaSecret) ||
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
    x, y,
    width: 500,
    height: 390,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
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

function createIframeDialog(iframeUrl) {
  if (iframeDialogWindow) {
    // Dialog already open — queue for later
    if (!iframeQueue.includes(iframeUrl) && iframeUrl !== pendingIframeUrl) {
      iframeQueue.push(iframeUrl);
    }
    iframeDialogWindow.focus();
    return;
  }

  pendingIframeUrl = iframeUrl;

  const { x, y } = dialogPosition(460, 280);
  iframeDialogWindow = new BrowserWindow({
    x, y,
    width: 460,
    height: 280,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  attachWindowScopedShortcuts(iframeDialogWindow);
  iframeDialogWindow.loadFile(
    path.join(__dirname, 'iframe-dialog.html')
  );
  iframeDialogWindow.webContents.on('did-finish-load', () => {
    iframeDialogWindow.webContents.send('iframe-url', iframeUrl);
  });
  iframeDialogWindow.on('closed', () => {
    iframeDialogWindow = null;
    pendingIframeUrl   = null;
    // Show next queued iframe if any
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
ipcMain.on('iframe-detected', (_event, iframeUrl) => {
  createIframeDialog(iframeUrl);
});

// User decision on iframe redirect
ipcMain.on('iframe-action', (_event, action) => {
  const url = pendingIframeUrl;
  if (iframeDialogWindow) iframeDialogWindow.close();

  if (action === 'navigate' && url && mainWindow) {
    loadMainUrl(url);
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
  Menu.setApplicationMenu(null); // remove File/Edit/View menu bar from all windows
  createUrlDialog();
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
