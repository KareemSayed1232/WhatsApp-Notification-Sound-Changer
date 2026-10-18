import { normalizeName } from "../core/normalize.mjs";
import { EVENT_REPLACE, MSG_CHATS, MSG_SCAN } from "../core/protocol.mjs";
import { findChatPane, readChatNames, scanChatList } from "./chat-list.mjs";

const CHUNK = 100;
const DEBOUNCE_MS = 1500;

/**
 * Content-script side of "list all my chats": quietly reports chat names as WhatsApp renders them,
 * and answers an explicit "scan the whole list" request from the popup or settings page.
 * Only names are read and sent, never message text.
 */
export function startChatWatcher({
  chrome,
  document,
  MutationObserverCtor = document.defaultView.MutationObserver,
  setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
  scan = (options) => scanChatList(options),
}) {
  const sent = new Set();
  let timer = null;
  let stopped = false;
  let bootObserver = null;
  let paneObserver = null;

  const isOrphaned = () => {
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  };

  function send(names) {
    for (let i = 0; i < names.length; i += CHUNK) {
      try {
        const result = chrome.runtime.sendMessage({
          type: MSG_CHATS,
          names: names.slice(i, i + CHUNK),
        });
        if (result && typeof result.catch === "function") result.catch(() => {});
      } catch {
        // The extension may have been reloaded under us; the next page load starts fresh.
      }
    }
  }

  /** Report only names we have not reported before, so a busy page does not spam the background. */
  function reportNew(names) {
    const fresh = names.filter((name) => !sent.has(normalizeName(name)));
    if (fresh.length === 0) return;
    for (const name of fresh) sent.add(normalizeName(name));
    send(fresh);
  }

  function flush() {
    timer = null;
    if (stopped) return;
    if (isOrphaned()) return stop();
    reportNew(readChatNames(document));
  }

  function schedule() {
    if (stopped || timer !== null) return;
    timer = setTimeoutFn(flush, DEBOUNCE_MS);
  }

  /** Start watching the chat list once WhatsApp has rendered it. */
  function attach() {
    const pane = findChatPane(document);
    if (!pane) return false;
    bootObserver?.disconnect();
    paneObserver = new MutationObserverCtor(schedule);
    paneObserver.observe(pane, { childList: true, subtree: true });
    flush();
    return true;
  }

  function onMessage(message, sender, sendResponse) {
    if (message?.type !== MSG_SCAN || sender?.id !== chrome.runtime.id) return false;
    Promise.resolve(scan({ document })).then(
      (result) => {
        for (const name of result.names) sent.add(normalizeName(name));
        if (result.names.length > 0) send(result.names);
        sendResponse({ ok: result.ok, reason: result.reason, count: result.names.length });
      },
      () => sendResponse({ ok: false, reason: "error", count: 0 })
    );
    return true; // answer asynchronously
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeoutFn(timer);
    bootObserver?.disconnect();
    paneObserver?.disconnect();
    document.removeEventListener(EVENT_REPLACE, stop);
    try {
      chrome.runtime.onMessage.removeListener?.(onMessage);
    } catch {
      // Extension context already gone.
    }
  }

  document.addEventListener(EVENT_REPLACE, stop);
  chrome.runtime.onMessage.addListener(onMessage);

  bootObserver = new MutationObserverCtor(() => attach());
  if (!attach()) bootObserver.observe(document.documentElement, { childList: true, subtree: true });

  return { stop, flush };
}
