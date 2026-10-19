// Is the extension still working against the current WhatsApp Web? WhatsApp changes without
// notice, so the hook and bridge keep a few counters and shapes (never names, ids or message text)
// that the UI turns into a plain status line and a copyable diagnostics report.

export const HEALTH_KEY = "health";
// This many notifications in a row without WhatsApp playing any sound is treated as a problem.
export const SILENT_RUN_ATTENTION = 3;
// This many group messages in a row without a "Sender:" part mean WhatsApp changed that format.
export const SENDER_MISS_ATTENTION = 5;

const TAG_KINDS = ["none", "group", "lid", "phone", "broadcast", "newsletter", "other"];
const SOUND_EXTENSIONS = ["mp3", "ogg", "oga", "opus", "m4a", "aac", "wav", "webm"];
// How the sound was handled: replacing WhatsApp's <audio>, its Web Audio, or played by us alone
// because WhatsApp played none.
const VIA = ["audio", "webaudio", "self"];
const HOOK_STATES = ["unknown", "ok", "missing", "overwritten"];
// How the chat list is being read (page-model.mjs): what was learned, WhatsApp's own names,
// page structure, English labels, loose title matching, or nothing.
const LAYERS = ["learned", "builtin", "structure", "label", "loose", "none", "unknown"];
// This many chat-list checks in a row that read nothing mean the list cannot be read.
export const UNREADABLE_ATTENTION = 3;
const MAX_DELAY_MS = 5000;

const layerOf = (value) => (LAYERS.includes(value) ? value : "unknown");
const emptyPage = () => ({
  readable: true,
  unreadableRun: 0,
  layers: { list: "unknown", name: "unknown", counter: "unknown" },
});

export function emptyHealth() {
  return {
    lastNotificationAt: 0,
    lastPairedAt: 0,
    lastSilentAt: 0,
    notifications: 0,
    paired: 0,
    unpaired: 0,
    selfPlayed: 0,
    silentRun: 0,
    // Sounds in a row that arrived, while the tab was in the background, with no notification
    // saying which chat they were for.
    unnamedRun: 0,
    // Since the last sound of ours that played: times the browser blocked audio (needs a click),
    // and times our sound itself failed (e.g. a file that cannot be decoded).
    blockedRun: 0,
    failedRun: 0,
    // How long WhatsApp last took to play its sound after a notification (ms).
    soundDelayMs: 0,
    page: emptyPage(),
    // Notification titles stopped naming the chat (one title for many chats).
    titlesGeneric: false,
    // Group messages in a row without a "Sender: text" part.
    senderMissRun: 0,
    hook: { state: "unknown", checkedAt: 0 },
    shapes: { tags: [], sound: null },
  };
}

const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

function describeHost(host) {
  return typeof host === "string" && /^[a-z0-9.()-]{1,60}$/i.test(host)
    ? host.toLowerCase()
    : "other";
}

/** Coerce whatever is in storage into a well-formed health record. */
export function sanitizeHealth(raw) {
  if (!raw || typeof raw !== "object") return emptyHealth();
  const sound = raw.shapes?.sound;
  return {
    lastNotificationAt: count(raw.lastNotificationAt),
    lastPairedAt: count(raw.lastPairedAt),
    lastSilentAt: count(raw.lastSilentAt),
    notifications: count(raw.notifications),
    paired: count(raw.paired),
    unpaired: count(raw.unpaired),
    selfPlayed: count(raw.selfPlayed),
    silentRun: count(raw.silentRun),
    unnamedRun: count(raw.unnamedRun),
    blockedRun: count(raw.blockedRun),
    failedRun: count(raw.failedRun),
    soundDelayMs: Math.min(MAX_DELAY_MS, count(raw.soundDelayMs)),
    page:
      raw.page && typeof raw.page === "object"
        ? {
            readable: raw.page.readable !== false,
            unreadableRun: count(raw.page.unreadableRun),
            layers: {
              list: layerOf(raw.page.layers?.list),
              name: layerOf(raw.page.layers?.name),
              counter: layerOf(raw.page.layers?.counter),
            },
          }
        : emptyPage(),
    titlesGeneric: raw.titlesGeneric === true,
    senderMissRun: count(raw.senderMissRun),
    hook: {
      state: HOOK_STATES.includes(raw.hook?.state) ? raw.hook.state : "unknown",
      checkedAt: count(raw.hook?.checkedAt),
    },
    shapes: {
      tags: Array.isArray(raw.shapes?.tags)
        ? raw.shapes.tags.filter((t) => TAG_KINDS.includes(t)).slice(0, TAG_KINDS.length)
        : [],
      sound:
        sound && typeof sound === "object"
          ? {
              via: VIA.includes(sound.via) ? sound.via : "audio",
              host: describeHost(sound.host),
              ext: SOUND_EXTENSIONS.includes(sound.ext) ? sound.ext : "other",
              detached: sound.detached === true,
            }
          : null,
    },
  };
}

/** What kind of chat id a notification's tag looks like. Never the id itself. */
export function classifyTag(tag) {
  if (typeof tag !== "string" || tag === "") return "none";
  if (tag.endsWith("@g.us")) return "group";
  if (tag.endsWith("@lid")) return "lid";
  if (tag.endsWith("@c.us") || tag.endsWith("@s.whatsapp.net")) return "phone";
  if (tag.endsWith("@broadcast")) return "broadcast";
  if (tag.endsWith("@newsletter")) return "newsletter";
  return "other";
}

/** The shape of a sound URL (host and file type only), never the URL. */
export function describeSound(url, { via = "audio", detached = false } = {}) {
  let host = "other";
  let ext = "other";
  try {
    const parsed = new globalThis.URL(url);
    host = parsed.protocol === "blob:" || parsed.protocol === "data:" ? "(local)" : parsed.hostname;
    const found = /\.([a-z0-9]+)$/i.exec(parsed.pathname)?.[1]?.toLowerCase();
    if (SOUND_EXTENSIONS.includes(found)) ext = found;
  } catch {
    // Not a URL (e.g. no src): the shape stays "other".
  }
  return { via: VIA.includes(via) ? via : "audio", host: describeHost(host), ext, detached };
}

/** Fold one signal from the hook or bridge into the health record (pure). */
export function applySignal(health, signal, now) {
  const next = sanitizeHealth(health);
  switch (signal?.type) {
    case "notification": {
      next.lastNotificationAt = now;
      next.notifications += 1;
      next.unnamedRun = 0; // WhatsApp is naming chats
      const kind = classifyTag(signal.tag);
      if (!next.shapes.tags.includes(kind)) next.shapes.tags.push(kind);
      break;
    }
    case "paired": // WhatsApp's sound followed a notification and we handled it
      next.lastPairedAt = now;
      next.silentRun = 0;
      next.unnamedRun = 0;
      next.paired += 1;
      next.shapes.sound = describeSound(signal.url, signal);
      break;
    case "unpaired": // WhatsApp's known sound with no notification
      next.lastPairedAt = now;
      next.silentRun = 0;
      next.unpaired += 1;
      // Expected while the tab is focused (WhatsApp does not notify then); in the background it
      // means WhatsApp stopped saying which chat a message is from.
      next.unnamedRun = signal.background === true ? next.unnamedRun + 1 : 0;
      next.shapes.sound = describeSound(signal.url, signal);
      break;
    case "self-played": // no sound from WhatsApp at all, so we played the chat's sound ourselves
      next.lastPairedAt = now;
      next.silentRun = 0;
      next.unnamedRun = 0;
      next.selfPlayed += 1;
      next.shapes.sound = describeSound("", { via: "self" });
      break;
    case "play-blocked": // our sound could not start (browser blocks audio until a click)
      next.blockedRun += 1;
      break;
    case "play-failed": // our sound itself failed to play
      next.failedRun += 1;
      break;
    case "played":
      next.blockedRun = 0;
      next.failedRun = 0;
      break;
    case "timing":
      next.soundDelayMs = Math.min(MAX_DELAY_MS, count(signal.delay));
      break;
    case "page": {
      const readable = signal.readable === true;
      next.page = {
        readable,
        unreadableRun: readable ? 0 : next.page.unreadableRun + 1,
        layers: {
          list: layerOf(signal.layers?.list),
          name: layerOf(signal.layers?.name),
          counter: layerOf(signal.layers?.counter),
        },
      };
      break;
    }
    case "titles":
      next.titlesGeneric = signal.generic === true;
      break;
    case "group-sender":
      next.senderMissRun = signal.ok === true ? 0 : next.senderMissRun + 1;
      break;
    case "silent": // a notification with no sound after it
      next.lastSilentAt = now;
      next.silentRun += 1;
      break;
    case "hook":
      next.hook = {
        state: HOOK_STATES.includes(signal.state) ? signal.state : "unknown",
        checkedAt: now,
      };
      break;
    default:
      break;
  }
  return next;
}

/** One plain verdict for the UI. `code` picks the wording, `level` the colour. */
export function healthStatus(health) {
  const h = sanitizeHealth(health);
  if (h.hook.state === "missing") return { code: "hook-missing", level: "bad" };
  if (h.hook.state === "overwritten") return { code: "hook-overwritten", level: "bad" };
  if (h.blockedRun > 0) return { code: "play-blocked", level: "warn" };
  if (h.failedRun > 0) return { code: "play-failed", level: "warn" };
  if (h.unnamedRun >= SILENT_RUN_ATTENTION) return { code: "no-chat-info", level: "warn" };
  if (h.titlesGeneric) return { code: "titles-generic", level: "warn" };
  if (h.senderMissRun >= SENDER_MISS_ATTENTION) return { code: "sender-format", level: "warn" };
  if (h.page.unreadableRun >= UNREADABLE_ATTENTION) {
    return { code: "list-unreadable", level: "warn" };
  }
  if (h.silentRun >= SILENT_RUN_ATTENTION) return { code: "no-sound", level: "warn" };
  if (h.lastPairedAt > 0) return { code: "working", level: "ok", at: h.lastPairedAt };
  return { code: "waiting", level: "idle" };
}

/** A shareable report: versions, counters and shapes only. No names, ids, sounds or messages. */
export function buildDiagnostics({ version, userAgent, health, state, now }) {
  const h = sanitizeHealth(health);
  const ago = (at) => (at > 0 ? Math.max(0, Math.round((now - at) / 1000)) : null);
  return {
    extension: version ?? "unknown",
    browser: typeof userAgent === "string" ? userAgent : "unknown",
    status: healthStatus(h).code,
    hook: { state: h.hook.state, checkedSecondsAgo: ago(h.hook.checkedAt) },
    counts: {
      notifications: h.notifications,
      soundsHandled: h.paired,
      soundsHandledWithoutNotification: h.unpaired,
      soundsPlayedByUsAlone: h.selfPlayed,
      notificationsWithoutSoundInARow: h.silentRun,
      backgroundSoundsWithoutChatInARow: h.unnamedRun,
      ourSoundBlockedInARow: h.blockedRun,
      ourSoundFailedInARow: h.failedRun,
      groupMessagesWithoutSenderInARow: h.senderMissRun,
    },
    timing: { whatsappSoundDelayMs: h.soundDelayMs },
    chatList: { readable: h.page.readable, ...h.page.layers },
    whatsappShapesChanged: {
      notificationTitlesAreNotChatNames: h.titlesGeneric,
    },
    secondsSince: {
      notification: ago(h.lastNotificationAt),
      soundHandled: ago(h.lastPairedAt),
      silentNotification: ago(h.lastSilentAt),
    },
    whatsappShapes: h.shapes,
    setup: {
      enabled: Boolean(state?.settings?.enabled),
      showPopups: Boolean(state?.settings?.showPopups),
      hasDefaultSound: Boolean(state?.settings?.defaultSoundId),
      rules: state?.rules?.length ?? 0,
      sounds: Object.keys(state?.sounds ?? {}).length,
    },
  };
}
