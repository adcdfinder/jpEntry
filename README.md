# JP Entry — Electron Kiosk Application

A Windows kiosk browser application built with Electron. Designed to lock the screen to a single web URL in fullscreen mode, with operator controls hidden behind keyboard shortcuts.

As you can see, the application is all generated with AI. The initial requirements can be checked in jpEntry.md.

---

## Features

| Feature | Detail |
|---|---|
| **Startup URL dialog** | Popup on launch to choose Red Zone (`http://192.168.88.250:8080`) or Yellow Zone (`http://192.168.20.250:80`) |
| **Kiosk mode** | Full-screen, no browser chrome, no taskbar access after URL is confirmed |
| **Navigation popup** | `Ctrl+Alt+H` reveals operator controls |
| **Paste dialog** | `Ctrl+Alt+V` opens a confirmation dialog for paced simulated typing into the focused input/terminal |
| **Multi-instance support** | Red Zone and Yellow Zone windows can run at the same time with separate browser sessions and focus-scoped shortcuts |
| **Password saving** | Detects submitted login forms, asks before saving, encrypts saved passwords locally, and autofills the same site later |
| **MFA OTP autofill** | Autofills saved MFA tokens on Red Zone and Yellow Zone OTP login pages |
| **New-window redirect** | All `target="_blank"` links and `window.open()` calls load inside the main window |
| **iframe detection** | When a page embeds an iframe, a popup asks whether to navigate to the iframe URL in the main window |
| **Minimal app chrome** | Windows / Linux remove the application menu; macOS keeps the native app menu for Quit / Force Quit affordances |
| **GPU acceleration** | Chromium GPU rasterization flags enabled for smoother rendering on Windows |

---

## Keyboard Shortcuts

| Windows / Linux | macOS | Action |
|---|---|---|
| `Ctrl+Alt+H` | `Control+Option+H` or `Command+Option+H` | Open navigation popup |
| `Ctrl+Alt+V` | `Control+Option+V` or `Command+Option+V` | Open clipboard paste confirmation |
| `Ctrl+Alt+Shift+Q` | `Control+Option+Shift+Q` or `Command+Option+Shift+Q` | Close the application, or cancel an active paste operation |

Shortcuts are window-scoped rather than OS-global. When multiple JP Entry
instances are open, the focused/fullscreen instance receives the shortcut and
other instances are left alone. Letter shortcuts are matched by physical key
code so macOS Option-key text composition does not change the shortcut.

On macOS, JP Entry uses the native fullscreen Space when fullscreen is enabled,
so moving the pointer to the top edge reveals the standard macOS window controls.
When fullscreen is disabled, the main window uses the display work area so it
does not extend under the Dock. Operator popups are parented modal windows so
navigation, paste, credential, iframe, and resolution dialogs stay attached to
the kiosk page.
JP Entry also keeps the native macOS application menu with Quit and ships bundle
metadata plus an app icon as a normal foreground app so packaged builds appear
in Cmd-Tab, the Dock, and Force Quit.
Operator dialogs use normal macOS window chrome instead of frameless always-on-top
windows, so a stuck URL, navigation, paste, credential, iframe, or resolution
dialog can be closed or switched away from like an ordinary app window.

### Navigation Popup Options

- 🏠 **Go to Root Page** — reload the startup URL
- ⬅ **Go to Last Page** — go back one step in history
- 📋 **Paste Text** — open the paste dialog to inject text into the focused input
- **Clear All Passwords** — remove all passwords saved by JP Entry
- ⏻ **Close Application** — quit the app
- **Cancel** — dismiss the popup

### Paste Dialog

Open via `Ctrl+Alt+V`, `Command+Option+V` on macOS, or the **Paste Text** button in the navigation popup:

1. Focus an input field on the web page
2. Press the paste shortcut directly, or press the navigation shortcut and click **Paste Text**
3. Type or paste your text into the dialog
4. Click **Apply** (or press `Ctrl+Enter`) — the text is injected into the previously focused input
5. Click **Cancel** to discard

---

## Project Structure

```
jpEntry/
├── main.js              # Main process — windows, shortcuts, session, IPC
├── preload.js           # Renderer bridge — iframe detection via MutationObserver
├── credential-store.js  # Testable password storage and prompt decisions
├── instance-profile.js  # Red / Yellow profile partition selection
├── navigation-history.js # Testable Root / Last Page navigation history
├── otp-autofill.js      # Testable OTP URL matching and input detection
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

### Run tests

```bat
npm test
```

The test suite covers the non-paste runtime contracts that are easiest to break
by accident: Red / Yellow zone OTP matching, saved-password storage decisions,
Root / Last Page navigation history fallback, dialog button wiring, and the
electron-builder file list for local runtime modules.

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

> **Note:** The app requests administrator rights (`requireAdministrator`) so kiosk mode works reliably on Windows.

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
- After URL is submitted via IPC, creates the **main kiosk window** in fullscreen by default
- Uses native macOS fullscreen when requested, and a Dock-safe work-area window when fullscreen is disabled
- Parents macOS operator dialogs as modal windows so they stay attached to the kiosk page
- Keeps macOS visible in Dock / Cmd-Tab / Force Quit with foreground app bundle metadata, an app icon, and the native app menu
- Gives macOS operator dialogs standard window controls instead of frameless always-on-top chrome
- Handles window-scoped shortcuts (`Ctrl+Alt` on Windows/Linux, `Control+Option` or `Command+Option` on macOS) on the focused instance
- Handles `setWindowOpenHandler` to redirect all new-window requests into the main window
- Manages an **iframe queue** — when multiple iframes are detected simultaneously, dialogs are shown sequentially
- Red and Yellow sessions use separate persistent partitions (`persist:kiosk-red` and `persist:kiosk-yellow`)

### `preload.js` — Renderer Bridge

- Runs inside the main kiosk window's renderer process (with `contextIsolation: true`)
- Uses `MutationObserver` with `{ childList, subtree, attributes, attributeFilter: ['src'] }` to detect:
  - New `<iframe>` elements added to the DOM
  - Existing `<iframe>` elements whose `src` attribute changes
- Deduplicates reports (each unique URL reported only once per page load)
- Sends detected URLs to the main process via `ipcRenderer.send('iframe-detected', src)`

### Session Persistence

Session data is stored on disk using zone-specific Electron named partitions,
such as `persist:kiosk-red` and `persist:kiosk-yellow`. This includes:
- HTTP cookies
- `localStorage` and `sessionStorage`
- IndexedDB
- Cache

Data survives app restarts. To clear it, delete the matching partition folder
under the app's `.electron-data\Partitions\` directory.

### Password Persistence

Saved passwords are stored separately from browser session data in `.electron-data\credentials.json`.
Passwords are encrypted with Electron `safeStorage` before they are written to disk. JP Entry prompts
before saving or updating a password, and it stores one credential per site origin.

---

## Regenerating the Icon

The icon is generated by a pure Node.js script (no dependencies):

```bat
node generate-icon.js
```

**Design:** Deep-purple rounded square → white circle badge → dark arched door with lavender handle.  
**Sizes included:** 16×16, 32×32, 48×48, 256×256.
