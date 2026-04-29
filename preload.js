'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe API to the renderer for iframe detection
contextBridge.exposeInMainWorld('kioskBridge', {
  onIframeDetected: (callback) => ipcRenderer.on('check-iframes', callback),
});

// Observe DOM for iframe insertions and report their src to main
const reportedSrcs = new Set();

function checkIframes() {
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach((iframe) => {
    const src = iframe.src || iframe.getAttribute('src');
    if (src && src.startsWith('http') && !reportedSrcs.has(src)) {
      reportedSrcs.add(src);
      ipcRenderer.send('iframe-detected', src);
    }
  });
}

// Watch for dynamically added iframes
const observer = new MutationObserver(() => checkIframes());

// Allow main process to request a fresh iframe scan (e.g. from nav dialog)
ipcRenderer.on('force-check-iframes', () => {
  reportedSrcs.clear();
  checkIframes();
});

window.addEventListener('DOMContentLoaded', () => {
  checkIframes();
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  }
});
