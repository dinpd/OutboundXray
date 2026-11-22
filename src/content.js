// OutboundXray content script: notices what you type so the service worker can tell
// you when that text (or a hashed copy of it) leaves the page.
//
// Privacy rules enforced here:
// - Does nothing unless OutboundXray is watching this tab: a scan you started,
//   or background watch, if you turned it on.
// - Never reads password, one-time-code or payment-card fields.
// - Values go only to OutboundXray's own service worker, in memory, and are dropped
//   when watching stops. Nothing is written to disk or sent anywhere else.
(() => {
  if (globalThis.__outboundXrayContent) return;
  globalThis.__outboundXrayContent = true;

  const MIN_LEN = 4;
  const MAX_LEN = 200;
  const DEBOUNCE_MS = 300;
  const SKIP_TYPES = new Set([
    'password', 'hidden', 'checkbox', 'radio', 'file', 'submit', 'button',
    'reset', 'image', 'range', 'color',
  ]);
  const SKIP_AUTOCOMPLETE = /\bcc-|current-password|new-password|one-time-code/i;

  let watched = false;
  const timers = new WeakMap();

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Extension was reloaded or removed; this script is orphaned.
    }
  }

  function eligible(el) {
    if (el instanceof HTMLTextAreaElement) return true;
    if (!(el instanceof HTMLInputElement)) return false;
    return !SKIP_TYPES.has(el.type) && !SKIP_AUTOCOMPLETE.test(el.autocomplete || '');
  }

  function fieldLabel(el) {
    const label =
      el.getAttribute('aria-label') ||
      el.labels?.[0]?.textContent ||
      el.placeholder ||
      el.name ||
      el.id ||
      (el.type && el.type !== 'text' ? el.type : '') ||
      'a text field';
    return label.replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function onInput(event) {
    if (!watched) return;
    const el = event.composedPath?.()[0] || event.target;
    if (!eligible(el)) return;
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => {
      const value = (el.value || '').trim();
      if (value.length >= MIN_LEN && value.length <= MAX_LEN) {
        send({ kind: 'typed', value, field: fieldLabel(el) });
      }
    }, DEBOUNCE_MS));
  }

  // "Interactions" are moments you deliberately sent something: pressing a
  // button, pressing Enter or submitting a form. Data that leaves before one is
  // flagged as "sent before you pressed any button".
  function onClick(event) {
    if (!watched) return;
    const el = event.composedPath?.()[0] || event.target;
    if (el instanceof Element && el.closest('button, [role="button"], input[type="submit"], input[type="button"], a')) {
      send({ kind: 'interaction' });
    }
  }

  function onKeydown(event) {
    if (watched && event.key === 'Enter') send({ kind: 'interaction' });
  }

  function onSubmit() {
    if (watched) send({ kind: 'interaction' });
  }

  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onInput, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('submit', onSubmit, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === 'watch') watched = !!msg.watched;
  });

  try {
    chrome.runtime.sendMessage({ kind: 'hello' })
      .then((res) => { watched = !!res?.watched; })
      .catch(() => {});
  } catch {
    // Orphaned script.
  }
})();
