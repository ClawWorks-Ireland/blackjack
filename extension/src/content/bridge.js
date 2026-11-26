/**
 * Casino Advisor — Content Script Bridge
 * Runs in isolated world. Listens for postMessage events from the MAIN world
 * injector (inject.js) and forwards them to the background service worker.
 *
 * This bridge is required because MAIN-world scripts cannot call
 * chrome.runtime.sendMessage directly — they communicate via postMessage
 * and this isolated content script relays the message.
 */

'use strict';

window.addEventListener('message', (evt) => {
  // Only accept messages from this frame
  if (evt.source !== window) return;
  const data = evt.data;
  if (!data || !data.__casinoAdvisor) return;

  // Forward to background service worker
  chrome.runtime.sendMessage(data).catch(() => {
    // Service worker may be sleeping; ignore
  });
});
