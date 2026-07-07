'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const isMainFrame = process.isMainFrame !== false;

if (isMainFrame) {
  contextBridge.exposeInMainWorld('kioskBridge', {
    onIframeDetected: (callback) => ipcRenderer.on('check-iframes', callback),
  });
}

const MIN_REMOTE_WIDTH = 640;
const MIN_REMOTE_HEIGHT = 480;
const MAX_REMOTE_WIDTH = 7680;
const MAX_REMOTE_HEIGHT = 4320;

let kioskOrigins = [];
let otpLoginPath = '';
let kioskConfigPromise = null;
let remoteResolutionOverride = readInitialResolutionOverride();
let remoteResolutionDebug = readResolutionDebugFlag();

function formatResolution(value) {
  const match = String(value || '').trim().match(/^(\d{2,5})\s*x\s*(\d{2,5})$/i);
  if (!match) return '';

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < MIN_REMOTE_WIDTH ||
    height < MIN_REMOTE_HEIGHT ||
    width > MAX_REMOTE_WIDTH ||
    height > MAX_REMOTE_HEIGHT
  ) {
    return '';
  }

  return `${width}x${height}`;
}

function readInitialResolutionOverride() {
  const prefix = '--jp-remote-resolution=';
  const arg = process.argv.find((item) => String(item || '').startsWith(prefix));
  if (!arg) return '';

  try {
    return formatResolution(decodeURIComponent(arg.slice(prefix.length)));
  } catch (_err) {
    return '';
  }
}

function readResolutionDebugFlag() {
  const prefix = '--jp-resolution-debug=';
  const arg = process.argv.find((item) => String(item || '').startsWith(prefix));
  return Boolean(arg && arg.slice(prefix.length) === '1');
}

function resolutionDebugLog(...parts) {
  if (!remoteResolutionDebug) return;
  console.log('[JP Entry][resolution]', parts.join(' '));
}

function injectPageWorldScript(source) {
  function append() {
    const target = document.documentElement || document.head || document.body;
    if (!target) return false;

    const script = document.createElement('script');
    script.textContent = source;
    target.appendChild(script);
    script.remove();
    return true;
  }

  if (!append()) {
    window.addEventListener('DOMContentLoaded', append, { once: true });
  }
}

function remoteResolutionPatchSource(resolutionText) {
  return `
    (function() {
      var nextResolution = ${JSON.stringify(formatResolution(resolutionText))};
      var debugEnabled = ${remoteResolutionDebug ? 'true' : 'false'};
      var nativeJsonParse = JSON.parse;
      var nativeJsonStringify = JSON.stringify;
      var nativeObjectAssign = Object.assign;
      var nativeStorageGetItem = window.Storage && window.Storage.prototype.getItem;
      var nativeStorageSetItem = window.Storage && window.Storage.prototype.setItem;

      function debugLog(message) {
        if (debugEnabled && window.console && typeof window.console.log === 'function') {
          window.console.log('[JP Entry][resolution] ' + message);
        }
      }

      function resolutionParts() {
        var match = String(window.__jpRemoteResolution || '').match(/^(\\d+)x(\\d+)$/);
        if (!match) return null;
        return {
          width: Number(match[1]),
          height: Number(match[2]),
          text: match[1] + 'x' + match[2]
        };
      }

      function setSearchParam(params, key, value) {
        if (params && typeof params.set === 'function') {
          params.set(key, String(value));
        }
      }

      function applyResolutionParams(params, includeLegacyNames) {
        var resolution = resolutionParts();
        if (!resolution || !params || typeof params.set !== 'function') return false;

        setSearchParam(params, 'resolution', resolution.text);
        setSearchParam(params, 'GUAC_WIDTH', resolution.width);
        setSearchParam(params, 'GUAC_HEIGHT', resolution.height);
        setSearchParam(params, 'width', resolution.width);
        setSearchParam(params, 'height', resolution.height);
        setSearchParam(params, 'GUAC_DPI', '96');

        if (includeLegacyNames) {
          setSearchParam(params, 'rdp_resolution', resolution.text);
          setSearchParam(params, 'TERMINAL_GRAPHICAL_RESOLUTION', resolution.text);
        }

        return true;
      }

      function isObject(value) {
        return value && typeof value === 'object';
      }

      function hasOwn(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key);
      }

      function looksLikeConnectOptions(value) {
        if (!isObject(value) || Array.isArray(value)) return false;
        return hasOwn(value, 'resolution') && (
          hasOwn(value, 'rdp_connection_speed') ||
          hasOwn(value, 'token_reusable') ||
          hasOwn(value, 'appletConnectMethod') ||
          hasOwn(value, 'virtualappConnectMethod') ||
          hasOwn(value, 'backspaceAsCtrlH') ||
          hasOwn(value, 'charset') ||
          hasOwn(value, 'disableautohash')
        );
      }

      function forceResolutionValue(value, seen) {
        if (!window.__jpRemoteResolution || !isObject(value)) return false;
        seen = seen || [];
        if (seen.indexOf(value) !== -1) return false;
        seen.push(value);

        var changed = false;

        if (isObject(value.graphics) && !Array.isArray(value.graphics)) {
          if (value.graphics.rdp_resolution !== window.__jpRemoteResolution) {
            value.graphics.rdp_resolution = window.__jpRemoteResolution;
            changed = true;
          }
        }

        if (
          hasOwn(value, 'TERMINAL_GRAPHICAL_RESOLUTION') &&
          value.TERMINAL_GRAPHICAL_RESOLUTION !== window.__jpRemoteResolution
        ) {
          value.TERMINAL_GRAPHICAL_RESOLUTION = window.__jpRemoteResolution;
          changed = true;
        }

        if (isObject(value.connect_options) && !Array.isArray(value.connect_options)) {
          if (value.connect_options.resolution !== window.__jpRemoteResolution) {
            value.connect_options.resolution = window.__jpRemoteResolution;
            changed = true;
          }
        }

        if (isObject(value.connectOption) && !Array.isArray(value.connectOption)) {
          if (value.connectOption.resolution !== window.__jpRemoteResolution) {
            value.connectOption.resolution = window.__jpRemoteResolution;
            changed = true;
          }
        }

        if (looksLikeConnectOptions(value) && value.resolution !== window.__jpRemoteResolution) {
          value.resolution = window.__jpRemoteResolution;
          changed = true;
        }

        Object.keys(value).forEach(function(key) {
          if (isObject(value[key])) {
            changed = forceResolutionValue(value[key], seen) || changed;
          }
        });

        return changed;
      }

      function cloneWithResolution(value) {
        if (!window.__jpRemoteResolution || !isObject(value)) return null;

        try {
          var clone = nativeJsonParse(nativeJsonStringify(value));
          return forceResolutionValue(clone, []) ? clone : null;
        } catch (_err) {
          return null;
        }
      }

      function lunaResolutionValue() {
        return window.__jpRemoteResolution || 'Auto';
      }

      function forceLunaSettingResolution(setting) {
        if (!isObject(setting) || Array.isArray(setting)) return false;

        if (!isObject(setting.graphics) || Array.isArray(setting.graphics)) {
          setting.graphics = {};
        }

        var nextResolution = lunaResolutionValue();
        if (setting.graphics.rdp_resolution === nextResolution) return false;

        setting.graphics.rdp_resolution = nextResolution;
        return true;
      }

      function forceSerializedLunaResolution(serializedSetting) {
        if (typeof serializedSetting !== 'string') {
          return serializedSetting;
        }

        try {
          var nextSetting = nativeJsonParse(serializedSetting);
          return forceLunaSettingResolution(nextSetting)
            ? nativeJsonStringify(nextSetting)
            : serializedSetting;
        } catch (_err) {
          return serializedSetting;
        }
      }

      function syncStoredLunaSettingResolution() {
        if (!nativeStorageGetItem || !nativeStorageSetItem || !window.localStorage) return;

        try {
          var currentRaw = nativeStorageGetItem.call(window.localStorage, 'LunaSetting');
          var currentSetting = currentRaw ? nativeJsonParse(currentRaw) : {};
          if (forceLunaSettingResolution(currentSetting)) {
            nativeStorageSetItem.call(
              window.localStorage,
              'LunaSetting',
              nativeJsonStringify(currentSetting)
            );
            debugLog('synced LunaSetting stored resolution=' + lunaResolutionValue());
          }
        } catch (_err) {}
      }

      function setResolution(value) {
        window.__jpRemoteResolution = typeof value === 'string' ? value : '';
        debugLog('page resolution=' + (window.__jpRemoteResolution || '(auto)'));
        syncStoredLunaSettingResolution();
      }

      function isConnectionTokenUrl(rawUrl) {
        try {
          var url = new URL(rawUrl, window.location.href);
          return /\\/api\\/v1\\/authentication\\/(?:admin-)?connection-token\\/?$/i.test(url.pathname) ||
            /\\/guacamole\\/api\\/tokens(?:\\/[^/]+)?\\/?$/i.test(url.pathname);
        } catch (_err) {
          return false;
        }
      }

      function isLegacyAssetAddUrl(rawUrl) {
        try {
          var url = new URL(rawUrl, window.location.href);
          return /\\/guacamole\\/api\\/session\\/ext\\/jumpserver\\/asset\\/add\\/?$/i.test(url.pathname);
        } catch (_err) {
          return false;
        }
      }

      function shouldPatch(rawUrl, method) {
        if (!window.__jpRemoteResolution) return false;
        if (method && String(method).toUpperCase() !== 'POST') return false;
        return isConnectionTokenUrl(rawUrl) || isLegacyAssetAddUrl(rawUrl);
      }

      function patchRequestUrl(rawUrl, method) {
        if (!window.__jpRemoteResolution) return rawUrl;
        if (method && String(method).toUpperCase() !== 'POST') return rawUrl;
        if (!isLegacyAssetAddUrl(rawUrl)) return rawUrl;

        try {
          var url = new URL(rawUrl, window.location.href);
          applyResolutionParams(url.searchParams, true);
          return url.toString();
        } catch (_err) {
          return rawUrl;
        }
      }

      function patchTokenFormBody(body, rawUrl) {
        if (typeof body !== 'string' || body.indexOf('=') === -1) {
          return null;
        }

        try {
          var params = new URLSearchParams(body);
          if (!Array.from(params.keys()).length) return null;
          if (!applyResolutionParams(params, isLegacyAssetAddUrl(rawUrl))) return null;
          return params.toString();
        } catch (_err) {
          return null;
        }
      }

      function patchBody(body, rawUrl) {
        if (!window.__jpRemoteResolution) return body;

        if (typeof body !== 'string') {
          var clonedBody = cloneWithResolution(body);
          return clonedBody || body;
        }

        try {
          var data = nativeJsonParse(body);
          if (!data || typeof data !== 'object' || Array.isArray(data)) return body;

          var options = data.connect_options;
          if (!options || typeof options !== 'object' || Array.isArray(options)) {
            options = {};
          }
          options.resolution = window.__jpRemoteResolution;
          data.connect_options = options;
          forceResolutionValue(data, []);
          return nativeJsonStringify(data);
        } catch (_err) {
          return patchTokenFormBody(body, rawUrl) || body;
        }
      }

      function patchGuacamoleConnectData(data) {
        var resolution = resolutionParts();
        if (!resolution || typeof data !== 'string') return data;

        try {
          var params = new URLSearchParams(data);
          params.set('GUAC_WIDTH', String(resolution.width));
          params.set('GUAC_HEIGHT', String(resolution.height));
          debugLog('patched Guacamole connect data resolution=' + resolution.text);
          return params.toString();
        } catch (_err) {
          return patchGuacamoleQueryParameter(
            patchGuacamoleQueryParameter(data, 'GUAC_WIDTH', resolution.width),
            'GUAC_HEIGHT',
            resolution.height
          );
        }
      }

      function patchGuacamoleQueryParameter(data, key, value) {
        var pattern = new RegExp('(^|&)' + key + '=[^&]*', 'i');
        if (pattern.test(data)) {
          return data.replace(pattern, '$1' + key + '=' + value);
        }
        return data ? data + '&' + key + '=' + value : key + '=' + value;
      }

      function isGuacamoleTunnelUrl(rawUrl) {
        if (!rawUrl) return false;
        try {
          var url = new URL(String(rawUrl), window.location.href);
          return /\\/guacamole\\/websocket-tunnel\\/?$/i.test(url.pathname);
        } catch (_err) {
          return /\\/guacamole\\/websocket-tunnel/i.test(String(rawUrl));
        }
      }

      function patchGuacamoleWebSocketUrl(rawUrl) {
        var resolution = resolutionParts();
        if (!resolution || !rawUrl) return rawUrl;

        try {
          var url = new URL(String(rawUrl), window.location.href);
          if (!isGuacamoleTunnelUrl(url.href)) return rawUrl;

          var before = url.searchParams.get('GUAC_WIDTH') + 'x' + url.searchParams.get('GUAC_HEIGHT');
          url.searchParams.set('GUAC_WIDTH', String(resolution.width));
          url.searchParams.set('GUAC_HEIGHT', String(resolution.height));
          if (before !== resolution.text) {
            debugLog('patched Guacamole WebSocket URL from=' + before + ' to=' + resolution.text);
          }
          return url.href;
        } catch (_err) {
          return rawUrl;
        }
      }

      function guacamoleProtocolElement(value) {
        var text = String(value);
        return text.length + '.' + text;
      }

      function patchGuacamoleSizeInstruction(data) {
        var resolution = resolutionParts();
        if (!resolution || typeof data !== 'string') return data;

        var match = data.match(/^4\\.size,(\\d+)\\.([^,;]*),(\\d+)\\.([^,;]*);$/);
        if (!match) return data;

        if (match[2] === String(resolution.width) && match[4] === String(resolution.height)) {
          return data;
        }

        debugLog('patched Guacamole socket size from=' + match[2] + 'x' + match[4] + ' to=' + resolution.text);
        return [
          guacamoleProtocolElement('size'),
          guacamoleProtocolElement(resolution.width),
          guacamoleProtocolElement(resolution.height)
        ].join(',') + ';';
      }

      function patchGuacamoleSocket(socket, rawUrl) {
        if (!socket || socket.__jpResolutionSocketPatched || !isGuacamoleTunnelUrl(rawUrl)) {
          return socket;
        }

        var nativeSend = socket.send;
        if (typeof nativeSend !== 'function') return socket;

        socket.__jpResolutionSocketPatched = true;
        socket.send = function(data) {
          return nativeSend.call(this, patchGuacamoleSizeInstruction(data));
        };
        debugLog('patched Guacamole WebSocket send hook');
        return socket;
      }

      function installGuacamoleWebSocketHook() {
        var NativeWebSocket = window.WebSocket;
        if (typeof NativeWebSocket !== 'function' || NativeWebSocket.__jpResolutionWrapped) return;

        function WrappedWebSocket(url, protocols) {
          var nextUrl = patchGuacamoleWebSocketUrl(url);
          var socket = arguments.length > 1
            ? new NativeWebSocket(nextUrl, protocols)
            : new NativeWebSocket(nextUrl);
          return patchGuacamoleSocket(socket, nextUrl);
        }

        WrappedWebSocket.prototype = NativeWebSocket.prototype;
        Object.keys(NativeWebSocket).forEach(function(key) {
          WrappedWebSocket[key] = NativeWebSocket[key];
        });
        ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function(key) {
          if (key in NativeWebSocket) {
            WrappedWebSocket[key] = NativeWebSocket[key];
          }
        });
        WrappedWebSocket.__jpResolutionWrapped = true;
        window.WebSocket = WrappedWebSocket;
        debugLog('installed Guacamole WebSocket resolution hook');
      }

      function patchGuacamoleClientInstance(client) {
        if (!client || client.__jpResolutionClientPatched) return client;
        client.__jpResolutionClientPatched = true;

        var nativeConnect = client.connect;
        if (typeof nativeConnect === 'function') {
          client.connect = function(data) {
            return nativeConnect.call(this, patchGuacamoleConnectData(data));
          };
        }

        var nativeSendSize = client.sendSize;
        if (typeof nativeSendSize === 'function') {
          client.sendSize = function(width, height) {
            var resolution = resolutionParts();
            if (resolution) {
              if (width !== resolution.width || height !== resolution.height) {
                debugLog(
                  'patched Guacamole sendSize from=' +
                  width + 'x' + height +
                  ' to=' + resolution.text
                );
              }
              return nativeSendSize.call(this, resolution.width, resolution.height);
            }
            return nativeSendSize.apply(this, arguments);
          };
        }

        return client;
      }

      function wrapGuacamoleClientConstructor(Client) {
        if (typeof Client !== 'function' || Client.__jpResolutionWrapped) return Client;

        function WrappedClient(tunnel) {
          return patchGuacamoleClientInstance(new Client(tunnel));
        }

        WrappedClient.prototype = Client.prototype;
        Object.keys(Client).forEach(function(key) {
          WrappedClient[key] = Client[key];
        });
        WrappedClient.__jpResolutionWrapped = true;
        return WrappedClient;
      }

      function currentGuacamoleNamespace() {
        var guac = window.Guacamole;
        if (!isObject(guac) || Array.isArray(guac)) {
          guac = {};
          window.Guacamole = guac;
        }
        return guac;
      }

      function patchCurrentGuacamoleClient(reason) {
        var guac = window.Guacamole;
        if (!isObject(guac) || Array.isArray(guac)) return false;

        var Client = guac.Client;
        var wrappedClient = wrapGuacamoleClientConstructor(Client);
        if (wrappedClient !== Client) {
          try {
            guac.Client = wrappedClient;
          } catch (_err) {
            return false;
          }
          debugLog('wrapped current Guacamole.Client reason=' + reason);
          return true;
        }

        return Boolean(Client && Client.__jpResolutionWrapped);
      }

      function installGuacamoleClientHook(reason) {
        var guac = currentGuacamoleNamespace();

        var descriptor = Object.getOwnPropertyDescriptor(guac, 'Client');
        if (descriptor && descriptor.get && descriptor.get.__jpResolutionHooked) {
          return patchCurrentGuacamoleClient(reason + ':existing-client-hook');
        }
        if (descriptor && descriptor.configurable === false) {
          return patchCurrentGuacamoleClient(reason + ':non-configurable-client');
        }

        var storedClient = guac.Client;
        function getClient() {
          return storedClient;
        }
        getClient.__jpResolutionHooked = true;

        try {
          Object.defineProperty(guac, 'Client', {
            configurable: true,
            enumerable: true,
            get: getClient,
            set: function(value) {
              storedClient = wrapGuacamoleClientConstructor(value);
              if (storedClient !== value) {
                debugLog('wrapped Guacamole.Client for resolution override reason=' + reason);
              }
            }
          });
        } catch (_err) {
          debugLog('failed to install Guacamole.Client hook reason=' + reason);
          return patchCurrentGuacamoleClient(reason + ':client-hook-failed');
        }
        debugLog('installed Guacamole.Client hook reason=' + reason);

        if (storedClient) {
          guac.Client = storedClient;
        }
        return patchCurrentGuacamoleClient(reason + ':post-install');
      }

      function installGuacamoleNamespaceHook(reason) {
        var descriptor = Object.getOwnPropertyDescriptor(window, 'Guacamole');
        if (descriptor && descriptor.get && descriptor.get.__jpResolutionHooked) {
          return installGuacamoleClientHook(reason + ':existing-namespace-hook');
        }

        if (descriptor && descriptor.configurable === false) {
          return installGuacamoleClientHook(reason + ':non-configurable-namespace');
        }

        var storedNamespace = isObject(window.Guacamole) && !Array.isArray(window.Guacamole)
          ? window.Guacamole
          : {};

        function getGuacamoleNamespace() {
          return storedNamespace;
        }
        getGuacamoleNamespace.__jpResolutionHooked = true;

        try {
          Object.defineProperty(window, 'Guacamole', {
            configurable: true,
            enumerable: true,
            get: getGuacamoleNamespace,
            set: function(value) {
              storedNamespace = isObject(value) && !Array.isArray(value) ? value : {};
              installGuacamoleClientHook(reason + ':namespace-set');
            }
          });
        } catch (_err) {
          debugLog('failed to install Guacamole namespace hook reason=' + reason);
          return installGuacamoleClientHook(reason + ':namespace-hook-failed');
        }
        debugLog('installed Guacamole namespace hook reason=' + reason);
        window.Guacamole = storedNamespace;
        return installGuacamoleClientHook(reason + ':post-namespace-install');
      }

      function startGuacamoleHookPolling() {
        if (window.__jpResolutionGuacamolePollTimer) return;

        var attempts = 0;
        window.__jpResolutionGuacamolePollTimer = window.setInterval(function() {
          attempts += 1;
          var wrapped = installGuacamoleNamespaceHook('poll');
          if (wrapped || attempts >= 300) {
            window.clearInterval(window.__jpResolutionGuacamolePollTimer);
            window.__jpResolutionGuacamolePollTimer = null;
            debugLog('stopped Guacamole hook polling attempts=' + attempts + ' wrapped=' + Boolean(wrapped));
          }
        }, 100);
      }

      if (!window.__jpResolutionPatchInstalled) {
        window.__jpResolutionPatchInstalled = true;
        debugLog('page patch installed');
        installGuacamoleWebSocketHook();
        installGuacamoleNamespaceHook('initial');
        startGuacamoleHookPolling();

        JSON.parse = function() {
          var parsed = nativeJsonParse.apply(this, arguments);
          if (forceResolutionValue(parsed, [])) {
            debugLog('patched parsed JSON resolution=' + window.__jpRemoteResolution);
          }
          return parsed;
        };

        JSON.stringify = function(value, replacer, space) {
          var clone = cloneWithResolution(value);
          if (clone) {
            debugLog('patched JSON.stringify resolution=' + window.__jpRemoteResolution);
            return nativeJsonStringify.call(this, clone, replacer, space);
          }
          return nativeJsonStringify.apply(this, arguments);
        };

        Object.assign = function() {
          var assigned = nativeObjectAssign.apply(this, arguments);
          if (forceResolutionValue(assigned, [])) {
            debugLog('patched Object.assign resolution=' + window.__jpRemoteResolution);
          }
          return assigned;
        };

        if (nativeStorageGetItem && nativeStorageSetItem) {
          window.Storage.prototype.getItem = function(key) {
            var value = nativeStorageGetItem.apply(this, arguments);
            if (key === 'LunaSetting' && typeof value === 'string') {
              try {
                var setting = nativeJsonParse(value);
                if (forceLunaSettingResolution(setting) || forceResolutionValue(setting, [])) {
                  debugLog('patched LunaSetting read resolution=' + lunaResolutionValue());
                  return nativeJsonStringify(setting);
                }
              } catch (_err) {}
            }
            return value;
          };

          window.Storage.prototype.setItem = function(key, value) {
            if (key === 'LunaSetting' && typeof value === 'string') {
              value = forceSerializedLunaResolution(value);
            }
            return nativeStorageSetItem.call(this, key, value);
          };
        }

        var nativeFetch = window.fetch;
        if (typeof nativeFetch === 'function') {
          window.fetch = function(input, init) {
            var requestUrl = typeof input === 'string' ? input : input && (input.url || input.href);
            var method = init && init.method ? init.method : input && input.method;
            var nextRequestUrl = patchRequestUrl(requestUrl, method);

            if (nextRequestUrl && nextRequestUrl !== requestUrl) {
              if (typeof input === 'string' || input && input.href) {
                input = nextRequestUrl;
              } else if (input && typeof Request === 'function' && input instanceof Request) {
                input = new Request(nextRequestUrl, input);
              }
              requestUrl = nextRequestUrl;
            }

            if (init && shouldPatch(requestUrl, method) && typeof init.body === 'string') {
              init = Object.assign({}, init, { body: patchBody(init.body, requestUrl) });
              debugLog('patched fetch token body resolution=' + window.__jpRemoteResolution);
            } else if (init && shouldPatch(requestUrl, method) && init.body) {
              init = Object.assign({}, init, { body: patchBody(init.body, requestUrl) });
              debugLog('patched fetch token object body resolution=' + window.__jpRemoteResolution);
            } else if (
              !init &&
              input &&
              typeof input.clone === 'function' &&
              shouldPatch(requestUrl, method) &&
              !isLegacyAssetAddUrl(requestUrl)
            ) {
              return input.clone().text().then(function(body) {
                var nextInit = {
                  method: input.method,
                  headers: input.headers,
                  body: patchBody(body, requestUrl),
                  credentials: input.credentials,
                  cache: input.cache,
                  redirect: input.redirect,
                  referrer: input.referrer,
                  referrerPolicy: input.referrerPolicy,
                  integrity: input.integrity,
                  keepalive: input.keepalive,
                  mode: input.mode
                };
                debugLog('patched fetch Request token body resolution=' + window.__jpRemoteResolution);
                return nativeFetch.call(this, input.url, nextInit);
              }.bind(this));
            } else if (shouldPatch(requestUrl, method)) {
              debugLog('fetch token body not patched type=' + typeof (init && init.body));
            }

            return nativeFetch.call(this, input, init);
          };
        }

        var nativeOpen = window.XMLHttpRequest && window.XMLHttpRequest.prototype.open;
        var nativeSend = window.XMLHttpRequest && window.XMLHttpRequest.prototype.send;
        if (nativeOpen && nativeSend) {
          window.XMLHttpRequest.prototype.open = function(method, url) {
            var nextUrl = patchRequestUrl(url, method);
            this.__jpRequestMethod = method;
            this.__jpRequestUrl = nextUrl;
            if (nextUrl && nextUrl !== url) {
              var args = Array.prototype.slice.call(arguments);
              args[1] = nextUrl;
              return nativeOpen.apply(this, args);
            }
            return nativeOpen.apply(this, arguments);
          };

          window.XMLHttpRequest.prototype.send = function(body) {
            if (shouldPatch(this.__jpRequestUrl, this.__jpRequestMethod)) {
              body = patchBody(body, this.__jpRequestUrl);
              debugLog('patched xhr token body resolution=' + window.__jpRemoteResolution);
            }
            return nativeSend.call(this, body);
          };
        }
      }

      setResolution(nextResolution);
    })();
  `;
}

function installRemoteResolutionPatch(resolutionText) {
  remoteResolutionOverride = formatResolution(resolutionText);
  resolutionDebugLog(
    'preload install override=' +
    (remoteResolutionOverride || '(auto)') +
    ' frame=' +
    (isMainFrame ? 'main' : 'sub')
  );
  injectPageWorldScript(remoteResolutionPatchSource(remoteResolutionOverride));
}

installRemoteResolutionPatch(remoteResolutionOverride);

ipcRenderer.on('remote-resolution-override', (_event, resolutionText) => {
  installRemoteResolutionPatch(resolutionText);
});

// Observe DOM for iframe insertions and report their src to main.
const reportedSrcs = new Set();

function checkIframes() {
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach((iframe) => {
    const src = iframe.src || iframe.getAttribute('src');
    if (src && src.startsWith('http') && !reportedSrcs.has(src)) {
      reportedSrcs.add(src);
      ipcRenderer.send('iframe-detected', { url: src });
    }
  });
}

function normalizeAbsoluteIframeUrl(value) {
  try {
    return new URL(value, window.location.href).href;
  } catch (_err) {
    return '';
  }
}

function findIframeByUrl(targetUrl) {
  const normalizedTarget = normalizeAbsoluteIframeUrl(targetUrl);
  if (!normalizedTarget) return null;

  return Array.from(document.querySelectorAll('iframe')).find((iframe) => {
    const src = iframe.src || iframe.getAttribute('src');
    return normalizeAbsoluteIframeUrl(src) === normalizedTarget;
  }) || null;
}

function setImportantStyle(style, property, value) {
  style.setProperty(property, value, 'important');
}

function expandIframeElement(iframe) {
  if (!iframe) return false;

  let ancestor = iframe.parentElement;
  while (ancestor && ancestor !== document.documentElement) {
    setImportantStyle(ancestor.style, 'overflow', 'visible');
    setImportantStyle(ancestor.style, 'transform', 'none');
    setImportantStyle(ancestor.style, 'contain', 'none');
    ancestor = ancestor.parentElement;
  }

  if (document.documentElement) {
    setImportantStyle(document.documentElement.style, 'overflow', 'hidden');
  }
  if (document.body) {
    setImportantStyle(document.body.style, 'overflow', 'hidden');
    setImportantStyle(document.body.style, 'margin', '0');
  }

  iframe.setAttribute('data-jp-expanded-iframe', 'true');
  setImportantStyle(iframe.style, 'position', 'fixed');
  setImportantStyle(iframe.style, 'inset', '0');
  setImportantStyle(iframe.style, 'top', '0');
  setImportantStyle(iframe.style, 'left', '0');
  setImportantStyle(iframe.style, 'right', '0');
  setImportantStyle(iframe.style, 'bottom', '0');
  setImportantStyle(iframe.style, 'width', '100vw');
  setImportantStyle(iframe.style, 'height', '100vh');
  setImportantStyle(iframe.style, 'min-width', '100vw');
  setImportantStyle(iframe.style, 'min-height', '100vh');
  setImportantStyle(iframe.style, 'max-width', '100vw');
  setImportantStyle(iframe.style, 'max-height', '100vh');
  setImportantStyle(iframe.style, 'z-index', '2147483647');
  setImportantStyle(iframe.style, 'display', 'block');
  setImportantStyle(iframe.style, 'visibility', 'visible');
  setImportantStyle(iframe.style, 'opacity', '1');
  setImportantStyle(iframe.style, 'pointer-events', 'auto');
  setImportantStyle(iframe.style, 'border', '0');
  setImportantStyle(iframe.style, 'margin', '0');
  setImportantStyle(iframe.style, 'padding', '0');
  setImportantStyle(iframe.style, 'background', '#000');
  setImportantStyle(iframe.style, 'box-sizing', 'border-box');

  try {
    iframe.focus();
  } catch (_err) {
    // Focusing is helpful but not required for the iframe expansion.
  }

  return true;
}

function expandIframeByUrl(url) {
  return expandIframeElement(findIframeByUrl(url));
}

function inputType(input) {
  return String(input.getAttribute('type') || 'text').toLowerCase();
}

function normalizeUrlPath(pathname) {
  return String(pathname || '').replace(/\/+$/, '') || '/';
}

function normalizeOrigin(value) {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch (_err) {
    return null;
  }
}

function applyKioskConfig(config) {
  const zones = Array.isArray(config && config.zones) ? config.zones : [];
  kioskOrigins = zones
    .map((zone) => normalizeOrigin(zone.url))
    .filter(Boolean);
  otpLoginPath = String((config && config.otpLoginPath) || '');
}

function loadKioskConfig() {
  if (!kioskConfigPromise) {
    kioskConfigPromise = ipcRenderer.invoke('kiosk-config')
      .then((config) => {
        applyKioskConfig(config);
        return config;
      })
      .catch(() => null);
  }
  return kioskConfigPromise;
}

function isOtpLoginUrl(value) {
  try {
    const url = new URL(value);
    return Boolean(
      otpLoginPath &&
      kioskOrigins.includes(url.origin) &&
      (
        normalizeUrlPath(url.pathname) === normalizeUrlPath(otpLoginPath) ||
        hasOtpUrlHint(url)
      )
    );
  } catch (_err) {
    return false;
  }
}

function isKnownKioskUrl(value) {
  try {
    const url = new URL(value);
    return kioskOrigins.includes(url.origin);
  } catch (_err) {
    return false;
  }
}

function hasOtpUrlHint(url) {
  const haystack = decodeURIComponent([
    url.pathname,
    url.search,
    url.hash,
  ].join(' ')).toLowerCase();
  return /otp|totp|mfa|2fa|two[-_\s]?factor|verification/.test(haystack);
}

function isCredentialOrigin() {
  return /^https?:$/i.test(window.location.protocol);
}

function isUsableInput(input) {
  if (!input || input.tagName !== 'INPUT') return false;
  if (input.disabled || input.readOnly) return false;

  const type = inputType(input);
  return ![
    'hidden',
    'password',
    'button',
    'submit',
    'reset',
    'checkbox',
    'radio',
    'file',
    'image',
  ].includes(type);
}

function isUsernameHint(input) {
  const haystack = [
    input.name,
    input.id,
    input.className,
    input.placeholder,
    input.getAttribute('autocomplete'),
    input.getAttribute('aria-label'),
  ].join(' ').toLowerCase();

  return /user|login|account|email|mail|phone|mobile|name/.test(haystack);
}

function passwordInputs(scope = document) {
  return Array.from(scope.querySelectorAll('input[type="password"]'))
    .filter((input) => !input.disabled && !input.readOnly);
}

function credentialScope(passwordInput) {
  return passwordInput.form || passwordInput.closest('form') || document;
}

function findUsernameInput(passwordInput) {
  const scope = credentialScope(passwordInput);
  const inputs = Array.from(scope.querySelectorAll('input'));
  const passwordIndex = inputs.indexOf(passwordInput);
  const beforePassword = passwordIndex >= 0 ? inputs.slice(0, passwordIndex) : inputs;
  const candidates = beforePassword.filter(isUsableInput);
  const hinted = candidates.filter(isUsernameHint);

  if (hinted.length > 0) return hinted[hinted.length - 1];
  if (candidates.length > 0) return candidates[candidates.length - 1];

  return inputs.find(isUsableInput) || null;
}

function dispatchFieldEvents(input) {
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function setInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  );

  if (descriptor && descriptor.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }

  dispatchFieldEvents(input);
}

function credentialFromPasswordInput(passwordInput) {
  if (!passwordInput || inputType(passwordInput) !== 'password') return null;

  const password = passwordInput.value;
  if (!password) return null;

  const usernameInput = findUsernameInput(passwordInput);
  return {
    origin: window.location.origin,
    username: usernameInput ? usernameInput.value : '',
    password,
  };
}

let lastCredentialKey = '';
let lastCredentialAt = 0;

function sendCredentialCandidate(candidate) {
  if (!candidate || !candidate.password || !isCredentialOrigin()) return;

  const key = [
    candidate.origin,
    candidate.username,
    candidate.password,
  ].join('\n');
  const now = Date.now();
  if (key === lastCredentialKey && now - lastCredentialAt < 5000) return;

  lastCredentialKey = key;
  lastCredentialAt = now;
  ipcRenderer.send('credentials-captured', candidate);
}

function capturePasswordInput(passwordInput, delay = 0) {
  setTimeout(() => {
    sendCredentialCandidate(credentialFromPasswordInput(passwordInput));
  }, delay);
}

function firstPasswordInputFromTarget(target) {
  if (!target) return null;

  if (target.tagName === 'INPUT' && inputType(target) === 'password') {
    return target;
  }

  const form = target.form || (target.closest && target.closest('form'));
  const scope = form || document;
  return passwordInputs(scope)[0] || null;
}

function setupCredentialCapture() {
  document.addEventListener('submit', (event) => {
    const passwordInput = passwordInputs(event.target || document)[0];
    if (passwordInput) capturePasswordInput(passwordInput);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const passwordInput = firstPasswordInputFromTarget(event.target);
    if (passwordInput) capturePasswordInput(passwordInput);
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest
      ? event.target.closest('button,input,[role="button"]')
      : null;
    if (!target) return;

    const passwordInput = firstPasswordInputFromTarget(target);
    if (passwordInput) capturePasswordInput(passwordInput, 50);
  }, true);
}

let autofillTimer = null;
let autofillCredential = null;
let otpAutofillTimer = null;

function applyCredential(credential) {
  if (!credential || !credential.password) return false;

  const passwordInput = passwordInputs()[0];
  if (!passwordInput || passwordInput.value) return false;

  const usernameInput = findUsernameInput(passwordInput);
  if (usernameInput && credential.username && !usernameInput.value) {
    setInputValue(usernameInput, credential.username);
  }

  setInputValue(passwordInput, credential.password);
  return true;
}

function requestCredentialAutofill() {
  if (!isCredentialOrigin()) return;

  ipcRenderer.invoke('credentials-get')
    .then((credential) => {
      autofillCredential = credential;
      if (credential) applyCredential(credential);
    })
    .catch(() => {});
}

function scheduleCredentialAutofill(delay = 250) {
  clearTimeout(autofillTimer);
  autofillTimer = setTimeout(() => {
    if (autofillCredential && applyCredential(autofillCredential)) return;
    requestCredentialAutofill();
  }, delay);
}

function otpHintText(input) {
  return [
    input.name,
    input.id,
    input.className,
    input.placeholder,
    input.getAttribute('autocomplete'),
    input.getAttribute('aria-label'),
  ].join(' ').toLowerCase();
}

function isOtpHinted(input) {
  return /otp|totp|mfa|2fa|two[-_\s]?factor|verification|authenticator|code|验证码|动态码|认证码|安全码|令牌|口令|多因素|双因素/.test(
    otpHintText(input)
  );
}

function isSixDigitInput(input) {
  const maxLength = Number(input.getAttribute('maxlength') || input.maxLength);
  const inputMode = String(input.getAttribute('inputmode') || input.inputMode || '').toLowerCase();
  const pattern = String(input.getAttribute('pattern') || '');
  return maxLength === 6 ||
    inputMode === 'numeric' ||
    inputMode === 'decimal' ||
    /\d|\[0-9\]/.test(pattern);
}

function isUsableOtpInput(input) {
  if (!input || input.tagName !== 'INPUT') return false;
  if (input.disabled || input.readOnly) return false;
  return [
    'text',
    'tel',
    'number',
    'password',
    'search',
  ].includes(inputType(input));
}

function findOtpInput(scope = document) {
  const candidates = Array.from(scope.querySelectorAll('input')).filter(isUsableOtpInput);
  return candidates.find(isOtpHinted) ||
    candidates.find(isSixDigitInput) ||
    null;
}

function applyOtpToken(token, options = {}) {
  if (!token || !/^\d{6}$/.test(String(token))) return false;

  const input = findOtpInput();
  if (!input) return false;
  if (input.value && !options.force) return false;
  if (input.value && options.force && !/^\d{0,8}$/.test(String(input.value))) return false;

  setInputValue(input, String(token));
  input.focus({ preventScroll: true });
  return true;
}

function requestOtpAutofill(options = {}) {
  loadKioskConfig()
    .then(() => {
      const hasOtpInput = Boolean(findOtpInput());
      if (!isOtpLoginUrl(window.location.href) && !hasOtpInput) return null;
      if (!isKnownKioskUrl(window.location.href)) return null;
      return ipcRenderer.invoke('otp-get', {
        url: window.location.href,
        hasOtpInput,
      });
    })
    .then((token) => {
      if (token) applyOtpToken(token, options);
    })
    .catch(() => {});
}

function scheduleOtpAutofill(delay = 250, options = {}) {
  clearTimeout(otpAutofillTimer);
  otpAutofillTimer = setTimeout(() => {
    requestOtpAutofill(options);
  }, delay);
}

// Watch for dynamically added iframes and login forms.
const observer = new MutationObserver(() => {
  checkIframes();
  scheduleCredentialAutofill();
  scheduleOtpAutofill();
});

// Allow main process to request a fresh iframe scan (e.g. from nav dialog).
if (isMainFrame) {
  ipcRenderer.on('force-check-iframes', () => {
    reportedSrcs.clear();
    checkIframes();
  });
}

if (isMainFrame) {
  ipcRenderer.on('expand-iframe', (_event, payload) => {
    const requestId = payload && payload.requestId;
    const url = typeof payload === 'string' ? payload : payload && payload.url;
    const ok = expandIframeByUrl(url);
    ipcRenderer.send('expand-iframe-result', { requestId, url, ok });
  });
}

if (isMainFrame) {
  ipcRenderer.on('otp-fill-now', () => {
    scheduleOtpAutofill(0, { force: true });
    setTimeout(() => scheduleOtpAutofill(0, { force: true }), 250);
    setTimeout(() => scheduleOtpAutofill(0, { force: true }), 750);
  });
}

if (isMainFrame) {
  window.addEventListener('DOMContentLoaded', () => {
    checkIframes();
    loadKioskConfig().then(() => scheduleOtpAutofill(0));
    setupCredentialCapture();
    scheduleCredentialAutofill(150);
    scheduleOtpAutofill(150);
    setTimeout(() => scheduleCredentialAutofill(0), 1000);
    setTimeout(() => scheduleCredentialAutofill(0), 2500);
    setTimeout(() => scheduleOtpAutofill(0), 1000);
    setTimeout(() => scheduleOtpAutofill(0), 2500);

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'type', 'name', 'id', 'autocomplete'],
      });
    }
  });
}
