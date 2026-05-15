'use strict';

const {
  app,
  BrowserWindow,
  globalShortcut,
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

// Required for Windows notifications / taskbar grouping
app.setAppUserModelId('com.opengeolabs.jpentry');

// Redirect userData to app directory to avoid cache access-denied errors
// when the default %APPDATA% path is not writable (kiosk user accounts).
if (process.platform === 'win32') {
  app.setPath('userData', path.join(__dirname, '.electron-data'));
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

const PASTE_DEFAULT_CHARS_PER_SECOND = 25;
const PASTE_MIN_CHARS_PER_SECOND = 5;
const PASTE_MAX_CHARS_PER_SECOND = 80;
const PASTE_FOCUS_DELAY_MS = 500;
const PASTE_PRIME_DELAY_MS = 150;
const PASTE_FINISH_DELAY_MS = 350;
const PASTE_HURRY_BATCH_SIZE = 20;
const PASTE_HURRY_BATCH_DELAY_MS = 16;

// ── Session setup ─────────────────────────────────────────────────────────────
// Called once, before any window is created
function setupSession() {
  const ses = session.fromPartition('persist:kiosk');

  // Allow all cookies (including HTTP, local IPs, non-standard ports)
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: details.responseHeaders });
  });

  return ses;
}

let kioskSession = null;

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

function credentialsFilePath() {
  return path.join(app.getPath('userData'), 'credentials.json');
}

function readCredentialStore() {
  try {
    const raw = fs.readFileSync(credentialsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.credentials) {
      return parsed;
    }
  } catch (_err) {}

  return { version: 1, credentials: {} };
}

function writeCredentialStore(store) {
  const filePath = credentialsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
}

function normalizeOrigin(value) {
  try {
    const origin = new URL(value).origin;
    if (origin === 'null') return null;
    return origin;
  } catch (_err) {
    return null;
  }
}

function eventOrigin(event) {
  return normalizeOrigin(event.senderFrame && event.senderFrame.url);
}

function currentMainOrigin() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return normalizeOrigin(mainWindow.webContents.getURL());
}

function canStoreCredentials() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch (_err) {
    return false;
  }
}

function encryptPassword(password) {
  if (!canStoreCredentials()) return null;
  return safeStorage.encryptString(String(password || '')).toString('base64');
}

function decryptPassword(encryptedPassword) {
  if (!encryptedPassword || !canStoreCredentials()) return null;

  try {
    return safeStorage.decryptString(Buffer.from(encryptedPassword, 'base64'));
  } catch (_err) {
    return null;
  }
}

function getCredential(origin) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return null;

  const store = readCredentialStore();
  const record = store.credentials[normalizedOrigin];
  if (!record) return null;

  const password = decryptPassword(record.password);
  if (password == null) return null;

  return {
    origin: normalizedOrigin,
    username: record.username || '',
    password,
    updatedAt: record.updatedAt || null,
  };
}

function saveCredential(credential) {
  const origin = normalizeOrigin(credential && credential.origin);
  const password = credential && credential.password;
  if (!origin || !password) return false;

  const encryptedPassword = encryptPassword(password);
  if (!encryptedPassword) return false;

  const store = readCredentialStore();
  const existing = store.credentials[origin];
  const now = new Date().toISOString();
  store.credentials[origin] = {
    username: String((credential && credential.username) || ''),
    password: encryptedPassword,
    createdAt: existing && existing.createdAt ? existing.createdAt : now,
    updatedAt: now,
  };
  writeCredentialStore(store);
  return true;
}

function deleteCredential(origin) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) return false;

  const store = readCredentialStore();
  if (!store.credentials[normalizedOrigin]) return false;

  delete store.credentials[normalizedOrigin];
  writeCredentialStore(store);
  return true;
}

function deleteAllCredentials() {
  writeCredentialStore({ version: 1, credentials: {} });
}

function shouldPromptForCredential(candidate) {
  if (!candidate || !candidate.origin || !candidate.password) return null;
  if (!canStoreCredentials()) return null;

  const existing = getCredential(candidate.origin);
  if (!existing) return 'save';

  if (
    existing.username === String(candidate.username || '') &&
    existing.password === String(candidate.password || '')
  ) {
    return null;
  }

  return 'update';
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

  if (!globalShortcut.isRegistered('Esc')) {
    globalShortcut.register('Esc', () => {
      cancelActivePasteOperation();
    });
  }
}

function endPasteInputLock() {
  pasteLocked = false;
  setPasteDialogInputLocked(false);

  if (globalShortcut.isRegistered('Esc')) {
    globalShortcut.unregister('Esc');
  }

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

function createUrlDialog() {
  urlDialogWindow = new BrowserWindow({
    width: 520,
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
  urlDialogWindow.loadFile(path.join(__dirname, 'url-dialog.html'));
  urlDialogWindow.on('closed', () => { urlDialogWindow = null; });
}

function createMainWindow(url, targetDisplay) {
  rootUrl = url;

  const { x, y } = targetDisplay ? targetDisplay.bounds : { x: 0, y: 0 };

  mainWindow = new BrowserWindow({
    x,
    y,
    fullscreen: true,
    kiosk: true,
    icon: ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:kiosk',   // use named partition directly
    },
  });

  mainWindow.loadURL(url);

  mainWindow.webContents.on('before-input-event', (event, input) => {
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
  mainWindow.webContents.on('did-navigate', injectFocusTracker);
  mainWindow.webContents.on('did-navigate-in-page', injectFocusTracker);

  // Redirect all new-window requests (target="_blank", window.open) into the main window
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    mainWindow.loadURL(targetUrl);
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

  pendingCredential = {
    origin: credential.origin,
    username: String(credential.username || ''),
    password: String(credential.password || ''),
    mode,
  };

  const { x, y } = dialogPosition(460, 300);
  credentialDialogWindow = new BrowserWindow({
    x, y,
    width: 460,
    height: 300,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  credentialDialogWindow.loadFile(path.join(__dirname, 'credential-dialog.html'));
  credentialDialogWindow.webContents.on('did-finish-load', () => {
    if (credentialDialogWindow && !credentialDialogWindow.isDestroyed()) {
      credentialDialogWindow.webContents.send('credential-prompt', {
        mode,
        origin: pendingCredential.origin,
        username: pendingCredential.username,
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
function registerShortcuts() {
  // Show nav popup  (Ctrl+Alt+H)
  globalShortcut.register('Ctrl+Alt+H', () => {
    if (pasteLocked) return;
    if (mainWindow) createNavDialog();
  });

  // Paste clipboard text into the focused bastion/terminal field (Ctrl+Alt+V)
  globalShortcut.register('Ctrl+Alt+V', () => {
    openClipboardPasteDialog();
  });

  // Quit immediately  (Ctrl+Alt+Shift+Q)
  globalShortcut.register('Ctrl+Alt+Shift+Q', () => {
    if (pasteLocked) {
      cancelActivePasteOperation();
      return;
    }
    app.quit();
  });
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

// User submitted URL in startup dialog
ipcMain.on('url-submitted', (_event, url) => {
  // Detect which display the URL dialog is currently on, so the kiosk
  // opens on the same screen the user dragged the dialog to.
  const targetDisplay = urlDialogWindow
    ? screen.getDisplayMatching(urlDialogWindow.getBounds())
    : screen.getPrimaryDisplay();

  if (urlDialogWindow) {
    urlDialogWindow.close();
  }
  createMainWindow(url, targetDisplay);
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

  if (action === 'root' && rootUrl) {
    mainWindow.loadURL(rootUrl);
  } else if (action === 'back') {
    if (mainWindow.webContents.canGoBack()) {
      mainWindow.webContents.goBack();
    }
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
    mainWindow.loadURL(url);
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
    const saved = saveCredential(pendingCredential);
    if (!saved && credentialDialogWindow && !credentialDialogWindow.isDestroyed()) {
      credentialDialogWindow.webContents.send('credential-error', {
        message: 'Password encryption is unavailable on this system.',
      });
      return;
    }
  }

  if (credentialDialogWindow && !credentialDialogWindow.isDestroyed()) {
    credentialDialogWindow.close();
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  kioskSession = setupSession();
  Menu.setApplicationMenu(null); // remove File/Edit/View menu bar from all windows
  registerShortcuts();
  createUrlDialog();
});

app.on('before-quit', async () => {
  // Flush the kiosk session's cookie store so login state survives restarts.
  // Electron/Chromium buffers cookie writes; without this they can be lost on exit.
  if (kioskSession) {
    await kioskSession.cookies.flushStore().catch(() => {});
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
