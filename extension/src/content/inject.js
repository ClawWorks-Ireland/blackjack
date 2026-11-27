/**
 * Casino Advisor — WebSocket Interceptor
 * Injected at document_start in MAIN world into Evolution Gaming game iframes.
 *
 * Overrides the WebSocket constructor to intercept game state messages.
 * Parses card events and forwards structured data to the background service worker.
 *
 * Must run in MAIN world (world: "MAIN" in manifest) to intercept the WS constructor
 * before the game client script establishes the connection.
 */

'use strict';

(function () {
  // Guard against double-injection
  if (window.__casinoAdvisorInjected) return;
  window.__casinoAdvisorInjected = true;

  const EVOLUTION_WS_PATTERN = /egcvi\.com|evo-games\.com|evolution\.com/;
  const PRAGMATIC_WS_PATTERN = /pragmaticplaylive\.net|pragmatic-play\.com/;

  const OriginalWebSocket = window.WebSocket;

  /**
   * Determine which platform a WS URL belongs to.
   * @param {string} url
   * @returns {'evolution' | 'pragmatic' | null}
   */
  function detectPlatform(url) {
    if (EVOLUTION_WS_PATTERN.test(url)) return 'evolution';
    if (PRAGMATIC_WS_PATTERN.test(url)) return 'pragmatic';
    return null;
  }

  /**
   * Send a structured event to the background service worker.
   * Uses a CustomEvent dispatched on the document to cross the content-script boundary
   * (since this runs in MAIN world, not isolated world).
   *
   * The content script bridge (inject-bridge.js) listens for this and relays via
   * chrome.runtime.sendMessage. For MV3 MAIN world, we use a postMessage to window
   * and rely on the content-script bridge.
   *
   * @param {object} payload
   */
  function sendToAdvisor(payload) {
    window.postMessage(
      { __casinoAdvisor: true, ...payload },
      '*'
    );
  }

  /**
   * Intercept messages on a WebSocket connection.
   * @param {WebSocket} ws
   * @param {string} platform
   */
  function attachInterceptor(ws, platform) {
    ws.addEventListener('message', (evt) => {
      // Skip binary frames (video/audio)
      if (typeof evt.data !== 'string') return;

      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (_) {
        return;
      }

      // Only handle properly-formed game state messages
      if (!msg || typeof msg.type !== 'string' || !msg.type.includes('.')) return;

      sendToAdvisor({
        source: 'ws-interceptor',
        platform,
        msg: {
          id: msg.id,
          type: msg.type,
          args: msg.args,
          time: msg.time,
        },
      });
    });
  }

  // Override WebSocket constructor
  window.WebSocket = function (...args) {
    const ws = new OriginalWebSocket(...args);
    const url = args[0] || '';
    const platform = detectPlatform(String(url));
    if (platform) {
      attachInterceptor(ws, platform);
    }
    return ws;
  };

  // Preserve prototype and static properties
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  Object.setPrototypeOf(window.WebSocket, OriginalWebSocket);
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
})();
