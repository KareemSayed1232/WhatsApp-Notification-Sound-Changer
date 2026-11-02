import { normalizeName } from "../core/normalize.mjs";
import { EVENT_REPLACE, MSG_CHATS, MSG_LAYOUT, MSG_SCAN } from "../core/protocol.mjs";
import { findChatPane, readChatNames, scanChatList } from "./chat-list.mjs";
import { captureLayout } from "./layout-capture.mjs";

const CHUNK = 100;
const DEBOUNCE_MS = 1500;
const BOOT_RETRY_MS = 1000;

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
  // The content script passes its self-teaching page model (page-model.mjs) for these.
  readNames = () => readChatNames(document),
  findPane = () => findChatPane(document),
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
    reportNew(readNames());
  }

  function schedule() {
    if (stopped || timer !== null) return;
    timer = setTimeoutFn(flush, DEBOUNCE_MS);
  }

  /** Start watching the chat list once WhatsApp has rendered it. */
  function attach() {
    const pane = findPane();
    if (!pane) return false;
    bootObserver?.disconnect();
    paneObserver = new MutationObserverCtor(schedule);
    paneObserver.observe(pane, { childList: true, subtree: true });
    flush();
    return true;
  }

  function onMessage(message, sender, sendResponse) {
    if (sender?.id !== chrome.runtime.id) return false;
    if (message?.type === MSG_LAYOUT) {
      let html = null;
      try {
        html = captureLayout({ document, findPane });
      } catch {
        html = null;
      }
      sendResponse(html ? { ok: true, html } : { ok: false, reason: "no-chat-list" });
      return false;
    }
    if (message?.type !== MSG_SCAN) return false;
    Promise.resolve(scan({ document, readNames, findPane })).then(
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

  // While WhatsApp loads, the page changes constantly: look for the chat list at most once a second.
  let bootTimer = null;
  bootObserver = new MutationObserverCtor(() => {
    if (stopped || paneObserver || bootTimer !== null) return;
    bootTimer = setTimeoutFn(() => {
      bootTimer = null;
      if (!stopped && !paneObserver) attach();
    }, BOOT_RETRY_MS);
  });
  if (!attach()) bootObserver.observe(document.documentElement, { childList: true, subtree: true });

  return { stop, flush };
}
