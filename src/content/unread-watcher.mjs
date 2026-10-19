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
  // Where to read chats from and which element is the chat list: by default WhatsApp's names
  // of today; the content script passes a self-teaching page model (page-model.mjs).
  read = () => readUnreadCounts(document),
  findPane = () => findChatPane(document),
  // Whether a chat is muted: by default its mute marker; the content script prefers what it
  // learned from WhatsApp's behaviour (mute-learner.mjs).
  isMuted = (name, chat) => chat.muted,
  // Every counter rise, focused or not (used to learn mutes in the background).
  onRise = () => {},
  // Every read of the list, before any decision (used to notice mute markers come and go).
  onRead = () => {},
}) {
  let previous = null;
  let paneObserver = null;
  let bootObserver = null;
  let timer = null;
  let bootTimer = null;
  let lastUserAt = -Infinity;
  let stopped = false;

  function safely(fn) {
    try {
      fn();
    } catch {
      // One failing chat must not stop the others.
    }
  }

  function check() {
    timer = null;
    if (stopped) return;
    let current;
    try {
      current = read();
    } catch {
      return;
    }
    safely(() => onRead(current));
    const userBusy = now() - lastUserAt < QUIET_AFTER_USER_MS;
    if (previous && !userBusy) {
      const focused = isFocused();
      for (const [key, chat] of current) {
        // A chat already on screen whose counter rose, or one that just appeared with a new
        // message (a new message moves a chat to the top of the list).
        if (chat.count === 0 || chat.count <= (previous.get(key)?.count ?? 0)) continue;
        let muted = chat.muted;
        safely(() => (muted = Boolean(isMuted(chat.name, chat) ?? chat.muted)));
        safely(() => onRise({ name: chat.name, focused, muted }));
        // In the background, notifications already cover new messages.
        if (focused && !muted) safely(() => onIncoming(chat.name));
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
    const pane = findPane();
    const target = event.target;
    // The list itself, something inside it, or the element around it that actually scrolls.
    if (pane && target?.nodeType === 1 && (pane.contains(target) || target.contains(pane))) {
      lastUserAt = now();
    }
  }

  function onUserInput(event) {
    // Typing in the chat search (the panel holding the chat list), not in a message box.
    const pane = findPane();
    const side = pane?.closest("#side") ?? pane?.parentElement;
    if (side && side.contains(event.target)) lastUserAt = now();
  }

  function attach() {
    const pane = findPane();
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
    // Looking for the list can be costly, so try at most a few times a second while it loads.
    bootObserver = new MutationObserverCtor(() => {
      if (paneObserver || bootTimer !== null || stopped) return;
      bootTimer = setTimeoutFn(() => {
        bootTimer = null;
        if (!paneObserver && !stopped) attach();
      }, DEBOUNCE_MS);
    });
    bootObserver.observe(document.documentElement ?? document, { childList: true, subtree: true });
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeoutFn(timer);
      if (bootTimer !== null) clearTimeoutFn(bootTimer);
      bootObserver?.disconnect();
      paneObserver?.disconnect();
      document.removeEventListener("scroll", onUserScroll, true);
      document.removeEventListener("input", onUserInput, true);
    },
  };
}
