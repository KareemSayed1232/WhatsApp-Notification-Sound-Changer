import { findChatPane, readUnreadCounts } from "./chat-list.mjs";

const DEBOUNCE_MS = 150;
// After the user scrolls the chat list or searches it, rows appear that already carry unread
// counters. Those are not new messages, so changes this soon after are only remembered.
const QUIET_AFTER_USER_MS = 1000;

function defaultIsFocused(document) {
  try {
    return document.visibilityState === "visible" && document.hasFocus();
  } catch {
    return false;
  }
}

/**
 * While WhatsApp is focused, some browsers' WhatsApp (Firefox, Oct 2026) raises no notification
 * and plays no sound for a new message. The chat list still shows it: the chat's unread counter
 * goes up. This watches those counters and reports `onIncoming(chatName)` for each new message
 * that arrives while the tab is focused. In the background, notifications already cover it.
 *
 * The first look is a baseline (existing unread chats are not "new"), counters going down are
 * chats being read, and muted chats are skipped, like WhatsApp does.
 */
export function startUnreadWatcher({
  document,
  onIncoming,
  MutationObserverCtor = globalThis.MutationObserver,
  setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
  now = () => Date.now(),
  isFocused = () => defaultIsFocused(document),
}) {
  let previous = null;
  let paneObserver = null;
  let bootObserver = null;
  let timer = null;
  let lastUserAt = -Infinity;
  let stopped = false;

  function report(name) {
    try {
      onIncoming(name);
    } catch {
      // One failing chat must not stop the others.
    }
  }

  function check() {
    timer = null;
    if (stopped) return;
    const current = readUnreadCounts(document);
    const userBusy = now() - lastUserAt < QUIET_AFTER_USER_MS;
    if (previous && !userBusy && isFocused()) {
      for (const [key, chat] of current) {
        if (chat.muted || chat.count === 0) continue;
        // A chat already on screen whose counter rose, or one that just appeared with a new
        // message (a new message moves a chat to the top of the list).
        if (chat.count > (previous.get(key)?.count ?? 0)) report(chat.name);
      }
    }
    previous = current;
  }

  function schedule() {
    if (stopped || timer !== null) return;
    timer = setTimeoutFn(check, DEBOUNCE_MS);
  }

  // WhatsApp may re-render the list, so look it up each time rather than keep an old element.
  function onUserScroll(event) {
    const pane = findChatPane(document);
    if (pane && (event.target === pane || pane.contains(event.target))) lastUserAt = now();
  }

  function onUserInput(event) {
    // Typing in the chat search (the panel holding the chat list), not in a message box.
    const pane = findChatPane(document);
    const side = pane?.closest("#side") ?? pane?.parentElement;
    if (side && side.contains(event.target)) lastUserAt = now();
  }

  function attach() {
    const pane = findChatPane(document);
    if (!pane) return false;
    bootObserver?.disconnect();
    bootObserver = null;
    paneObserver = new MutationObserverCtor(schedule);
    paneObserver.observe(pane, { childList: true, subtree: true, characterData: true });
    check(); // baseline
    return true;
  }

  document.addEventListener("scroll", onUserScroll, true);
  document.addEventListener("input", onUserInput, true);

  if (!attach()) {
    bootObserver = new MutationObserverCtor(() => {
      if (!paneObserver) attach();
    });
    bootObserver.observe(document.documentElement ?? document, { childList: true, subtree: true });
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeoutFn(timer);
      bootObserver?.disconnect();
      paneObserver?.disconnect();
      document.removeEventListener("scroll", onUserScroll, true);
      document.removeEventListener("input", onUserInput, true);
    },
  };
}
