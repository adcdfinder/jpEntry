# JP Entry — Electron Kiosk Application

A Windows kiosk browser application built with Electron. Designed to lock the screen to a single web URL in fullscreen mode, with operator controls hidden behind keyboard shortcuts.

As you can see, the application is all generated with AI. The initial requirements can be checked in jpEntry.md.

---

## Features

| Feature | Detail |
|---|---|
| **Startup URL dialog** | Popup on launch to enter the target URL (default: `http://192.168.88.250:8080`) |
| **Kiosk mode** | Full-screen, no browser chrome, no taskbar access after URL is confirmed |
| **Navigation popup** | `Ctrl+Alt+H` reveals operator controls |
| **Paste dialog** | Type or paste text into a dialog; on Apply it is injected into the focused input on the page |
| **New-window redirect** | All `target="_blank"` links and `window.open()` calls load inside the main window |
| **iframe detection** | When a page embeds an iframe, a popup asks whether to navigate to the iframe URL in the main window |
| **No menu bar** | File / Edit / View menu is removed from all windows |
| **GPU acceleration** | Chromium GPU rasterization flags enabled for smoother rendering on Windows |

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+H` | Open navigation popup |

### Navigation Popup Options

- 🏠 **Go to Root Page** — reload the startup URL
- ⬅ **Go to Last Page** — go back one step in history
- 📋 **Paste Text** — open the paste dialog to inject text into the focused input
- ⏻ **Close Application** — quit the app
- **Cancel** — dismiss the popup

### Paste Dialog

Open via the **Paste Text** button in the navigation popup:

1. Focus an input field on the web page
2. Press `Ctrl+Alt+H` → click **Paste Text**
3. Type or paste your text into the dialog
4. Click **Apply** (or press `Ctrl+Enter`) — the text is injected into the previously focused input
5. Click **Cancel** to discard

---

## Project Structure

```
jpEntry/
├── main.js              # Main process — windows, shortcuts, session, IPC
├── preload.js           # Renderer bridge — iframe detection via MutationObserver
├── package.json         # Dependencies and electron-builder config
├── generate-icon.js     # Utility: regenerate icon.ico (pure Node.js, no deps)
├── icon.ico             # App icon (16 / 32 / 48 / 256 px)
├── url-dialog.html      # Startup URL input popup
├── nav-dialog.html      # Ctrl+Alt+H navigation popup
├── paste-dialog.html    # Paste text dialog (textarea → inject into focused input)
└── iframe-dialog.html   # iframe-detected confirmation popup
```

---

## Getting Started

### Requirements

- [Node.js](https://nodejs.org/) 18+
- Windows 10 / 11 (x64)

### Run in development

```bat
npm install
npm start
```

### Build for Windows

```bat
set CSC_IDENTITY_AUTO_DISCOVERY=false
npm install
npm run build
```

Output in `dist\`:

| File | Description |
|---|---|
| `JP Entry Setup 1.0.0.exe` | NSIS installer (installs to Program Files, creates shortcuts) |
| `JPEntry-portable.exe` | Portable single-file executable — recommended for kiosk machines |

> **Note:** The app requests administrator rights (`requireAdministrator`) so that global shortcuts and kiosk mode work reliably on Windows.

#### Offline build (no internet access)

If `electron-builder` cannot download its binaries automatically:

1. Download `winCodeSign-2.6.0.7z` from:  
   `https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z`
2. Extract and place the folder at:  
   `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`
3. Re-run `npm run build`

---

## Architecture

### `main.js` — Main Process

- Creates the **URL dialog** window on startup (non-kiosk, always-on-top)
- After URL is submitted via IPC, creates the **main kiosk window** (`kiosk: true`, `fullscreen: true`)
- Registers global shortcuts (`Ctrl+Alt+H`, `Ctrl+Alt+Shift+Q`)
- Handles `setWindowOpenHandler` to redirect all new-window requests into the main window
- Manages an **iframe queue** — when multiple iframes are detected simultaneously, dialogs are shown sequentially
- Session uses `partition: 'persist:kiosk'` — data stored in `%APPDATA%\jp-entry\Partitions\persist_kiosk\`

### `preload.js` — Renderer Bridge

- Runs inside the main kiosk window's renderer process (with `contextIsolation: true`)
- Uses `MutationObserver` with `{ childList, subtree, attributes, attributeFilter: ['src'] }` to detect:
  - New `<iframe>` elements added to the DOM
  - Existing `<iframe>` elements whose `src` attribute changes
- Deduplicates reports (each unique URL reported only once per page load)
- Sends detected URLs to the main process via `ipcRenderer.send('iframe-detected', src)`

### Session Persistence

Session data is stored on disk using Electron's named partition `persist:kiosk`. This includes:
- HTTP cookies
- `localStorage` and `sessionStorage`
- IndexedDB
- Cache

Data survives app restarts. To clear it, delete the partition folder in `%APPDATA%\jp-entry\`.

---

## Regenerating the Icon

The icon is generated by a pure Node.js script (no dependencies):

```bat
node generate-icon.js
```

**Design:** Deep-purple rounded square → white circle badge → dark arched door with lavender handle.  
**Sizes included:** 16×16, 32×32, 48×48, 256×256.
