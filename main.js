'use strict';

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  session,
  Menu,
  screen,
} = require('electron');
const path = require('path');

// Required for Windows notifications / taskbar grouping
app.setAppUserModelId('com.opengeolabs.jpentry');

// Redirect userData to app directory to avoid cache access-denied errors
// when the default %APPDATA% path is not writable (kiosk user accounts).
app.setPath('userData', path.join(__dirname, '.electron-data'));

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
let pasteAborted = false;
let rootUrl = null;          // URL entered at startup
let pendingIframeUrl = null;
const iframeQueue   = []; // queued iframe srcs waiting for user decision

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
  const { x: dx, y: dy, width: dw, height: dh } = display.bounds;
  return {
    x: Math.round(dx + (dw - width) / 2),
    y: Math.round(dy + (dh - height) / 2),
  };
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

  // Inject a focus tracker so we can find the last focused input after popups steal focus
  function injectFocusTracker() {
    mainWindow.webContents.executeJavaScript(`
      if (!window.__jpFocusTracking) {
        window.__jpFocusTracking = true;
        window.__jpLastFocused = null;
        document.addEventListener('focusin', function(e) {
          if (e.target && (
            e.target.tagName === 'INPUT' ||
            e.target.tagName === 'TEXTAREA' ||
            e.target.isContentEditable
          )) {
            window.__jpLastFocused = e.target;
          }
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

  const { x, y } = dialogPosition(400, 450);
  navDialogWindow = new BrowserWindow({
    x, y,
    width: 400,
    height: 450,
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

function createPasteDialog() {
  if (pasteDialogWindow) { pasteDialogWindow.focus(); return; }

  const { x, y } = dialogPosition(500, 320);
  pasteDialogWindow = new BrowserWindow({
    x, y,
    width: 500,
    height: 320,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    icon: ICON,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  pasteDialogWindow.loadFile(path.join(__dirname, 'paste-dialog.html'));
  pasteDialogWindow.on('closed', () => {
    pasteAborted = true;
    pasteDialogWindow = null;
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
    if (mainWindow) createNavDialog();
  });

  // Quit immediately  (Ctrl+Alt+Shift+Q)
  globalShortcut.register('Ctrl+Alt+Shift+Q', () => {
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
  if (action === 'paste') {
    if (navDialogWindow) navDialogWindow.close();
    createPasteDialog();
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

// Paste dialog: inject text into the focused element using chunked sendInputEvent.
// Chunks of CHUNK_SIZE chars are sent per animation frame to avoid UI stalls on large pastes.
// \n → Return key, \t → Tab key, other chars via type:'char'.
ipcMain.on('paste-apply', (_event, text) => {
  if (!mainWindow || !text) {
    if (pasteDialogWindow) pasteDialogWindow.close();
    return;
  }

  pasteAborted = false;

  const CHUNK_SIZE = 20;
  const CHUNK_DELAY = 16; // ms between chunks (~1 frame)

  mainWindow.focus();
  mainWindow.webContents.focus();

  // Re-focus the element the user was in before the popup opened
  mainWindow.webContents.executeJavaScript(`
    (function() {
      var el = window.__jpLastFocused || document.activeElement;
      if (el && el !== document.body) el.focus();
    })();
  `).finally(() => {
    const chars = Array.from(text); // handles multi-byte chars correctly
    const total = chars.length;
    let i = 0;

    const sendNextChunk = () => {
      if (pasteAborted || !mainWindow) return;

      const end = Math.min(i + CHUNK_SIZE, chars.length);
      while (i < end) {
        const char = chars[i++];
        if (char === '\r') continue;
        if (char === '\n') {
          mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
          mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        } else if (char === '\t') {
          // Send as char event to insert literal tab, not as a Tab key (which triggers indentation/navigation)
          mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: '\t' });
        } else {
          mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: char });
        }
      }

      if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) {
        pasteDialogWindow.webContents.send('paste-progress', { current: i, total });
      }

      if (i < chars.length) {
        setTimeout(sendNextChunk, CHUNK_DELAY);
      } else {
        // Typing complete — close dialog after a brief pause so user sees 100%
        setTimeout(() => {
          if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) pasteDialogWindow.close();
        }, 350);
      }
    };

    setTimeout(sendNextChunk, 50); // brief pause after focus before typing
  });
});

ipcMain.on('paste-cancel-operation', () => {
  pasteAborted = true;
  if (pasteDialogWindow && !pasteDialogWindow.isDestroyed()) pasteDialogWindow.close();
});

ipcMain.on('paste-cancel', () => {
  if (pasteDialogWindow) pasteDialogWindow.close();
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
