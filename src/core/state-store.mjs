import { parseDataUrl } from "./audio-data.mjs";
import { HEALTH_KEY, sanitizeHealth } from "./health.mjs";
import { cleanDisplayName, normalizeName } from "./normalize.mjs";
import {
  MAX_KNOWN_CHATS,
  MAX_RECENT_SENDERS,
  RULE_KINDS,
  SCHEMA_VERSION,
  ValidationError,
  clampVolume,
  defaultSettings,
  validateRule,
  validateSoundFile,
} from "./schema.mjs";

const KEYS = ["schemaVersion", "settings", "sounds", "rules", "recentSenders", "knownChats"];
const LEGACY_KEY = "uploadedAudio";
const LEGACY_SOUND_ID = "legacy-default";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Coerce whatever is in storage into a well-formed state, repairing corrupt values. */
function sanitize(raw) {
  const stored = isObject(raw.settings) ? raw.settings : {};
  const settings = {
    enabled: stored.enabled !== false,
    volume: clampVolume(stored.volume),
    defaultSoundId:
      typeof stored.defaultSoundId === "string"
        ? stored.defaultSoundId
        : defaultSettings().defaultSoundId,
    showPopups: stored.showPopups === true,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    settings,
    sounds: isObject(raw.sounds) ? raw.sounds : {},
    rules: Array.isArray(raw.rules) ? raw.rules.filter(isObject) : [],
    recentSenders: Array.isArray(raw.recentSenders)
      ? raw.recentSenders.filter((s) => isObject(s) && typeof s.name === "string")
      : [],
    // Names read from WhatsApp's own chat list (no ids), so every chat can be offered, not only
    // the ones that have messaged you.
    knownChats: Array.isArray(raw.knownChats)
      ? raw.knownChats.filter((c) => isObject(c) && typeof c.name === "string")
      : [],
  };
}

// Identity of a chat rule / recent sender: the chat id when known, otherwise kind + normalized name.
const identity = (kind, chatId, name) =>
  chatId ? `chat\u0000id:${chatId}` : `${kind}\u0000${normalizeName(name)}`;
const ruleKey = (rule) => identity(rule.kind, rule.chatId, rule.match);
const senderKey = (entry) => identity(entry.kind, entry.chatId, entry.name);

/** Read and sanitize the persisted state. No migration, no writes: safe from content scripts. */
export async function readState(storage) {
  return sanitize(await storage.get(KEYS));
}

/**
 * Persistent state: small JSON in `storage` (chrome.storage.local), sound bytes in `soundStore`.
 * All mutations run one at a time so concurrent callers cannot overwrite each other.
 */
export function createStateStore({
  storage,
  soundStore,
  generateId = () => globalThis.crypto.randomUUID(),
  now = () => Date.now(),
}) {
  let readyPromise = null;
  let queue = Promise.resolve();

  const read = () => readState(storage);

  async function migrate() {
    const raw = await storage.get([...KEYS, LEGACY_KEY]);
    const state = sanitize(raw);
    const legacy = raw[LEGACY_KEY];

    if (typeof legacy === "string") {
      // Importing is idempotent (same id, overwritten bytes), so it also recovers from a crash
      // between saving the sound and removing the old key, and handles a later re-upload.
      const parsed = parseDataUrl(legacy);
      if (parsed) {
        // Save the bytes first: if this throws, the original data is still in storage.
        await soundStore.put(LEGACY_SOUND_ID, { mime: parsed.mime, data: parsed.bytes.buffer });
        state.sounds[LEGACY_SOUND_ID] = {
          id: LEGACY_SOUND_ID,
          name: "Custom sound",
          mime: parsed.mime,
          size: parsed.bytes.length,
          createdAt: now(),
        };
        if (!state.settings.defaultSoundId) state.settings.defaultSoundId = LEGACY_SOUND_ID;
        await storage.set(state);
        await storage.remove(LEGACY_KEY);
        return;
      }
      // Unreadable legacy value: leave it alone rather than destroy it.
    }

    // Only write when something needs repairing: every extension page and the background worker
    // runs this on start-up, and rewriting identical data would race with other writers.
    const unchanged = KEYS.every((key) => JSON.stringify(raw[key]) === JSON.stringify(state[key]));
    if (!unchanged) await storage.set(state);
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = migrate().catch((error) => {
        readyPromise = null;
        throw error;
      });
    }
    return readyPromise;
  }

  function mutate(task) {
    const result = queue.then(async () => {
      await ready();
      return task(await read());
    });
    queue = result.catch(() => {});
    return result;
  }

  function requireSound(state, soundId) {
    if (!state.sounds[soundId]) throw new ValidationError("unknown-sound");
  }

  function requireUnique(state, rule) {
    const key = ruleKey(rule);
    if (state.rules.some((other) => other.id !== rule.id && ruleKey(other) === key)) {
      throw new ValidationError("duplicate-rule");
    }
  }

  function buildRule(base, input) {
    const rule = {
      id: base.id,
      kind: input.kind ?? base.kind,
      match: typeof input.match === "string" ? input.match.trim() : base.match,
      chatId: input.chatId !== undefined ? input.chatId : (base.chatId ?? null),
      action: input.action ?? base.action,
      soundId: input.soundId !== undefined ? input.soundId : (base.soundId ?? null),
      enabled: input.enabled !== undefined ? input.enabled !== false : base.enabled !== false,
    };
    if (rule.action !== "sound") rule.soundId = null;
    // Only chat rules have an id to match on; senders in groups are identified by name alone.
    if (rule.kind !== "chat" || rule.chatId === "") rule.chatId = null;
    return rule;
  }

  return {
    async load() {
      await ready();
      return read();
    },

    /** The status record the WhatsApp tab keeps (counters and shapes only). Read-only here. */
    async loadHealth() {
      return sanitizeHealth((await storage.get([HEALTH_KEY]))?.[HEALTH_KEY]);
    },

    addRule: (input) =>
      mutate(async (state) => {
        const rule = buildRule({ id: generateId() }, input);
        validateRule(rule);
        if (rule.action === "sound") requireSound(state, rule.soundId);
        requireUnique(state, rule);
        await storage.set({ rules: [...state.rules, rule] });
        return rule;
      }),

    updateRule: (id, patch) =>
      mutate(async (state) => {
        const existing = state.rules.find((r) => r.id === id);
        if (!existing) throw new ValidationError("not-found");
        const rule = buildRule(existing, patch);
        validateRule(rule);
        if (rule.action === "sound") requireSound(state, rule.soundId);
        requireUnique(state, rule);
        await storage.set({ rules: state.rules.map((r) => (r.id === id ? rule : r)) });
        return rule;
      }),

    deleteRule: (id) =>
      mutate(async (state) => {
        if (!state.rules.some((r) => r.id === id)) throw new ValidationError("not-found");
        await storage.set({ rules: state.rules.filter((r) => r.id !== id) });
      }),

    addSound: (file) =>
      mutate(async (state) => {
        validateSoundFile(file);
        const data = await file.arrayBuffer();
        validateSoundFile({ type: file.type, size: data.byteLength });
        const id = generateId();
        await soundStore.put(id, { mime: file.type, data });
        const meta = {
          id,
          name: file.name || "Sound",
          mime: file.type,
          size: data.byteLength,
          createdAt: now(),
        };
        await storage.set({ sounds: { ...state.sounds, [id]: meta } });
        return meta;
      }),

    deleteSound: (id) =>
      mutate(async (state) => {
        if (!state.sounds[id]) throw new ValidationError("not-found");
        const sounds = { ...state.sounds };
        delete sounds[id];
        const affectedRuleIds = [];
        const rules = state.rules.map((rule) => {
          if (rule.action === "sound" && rule.soundId === id) {
            affectedRuleIds.push(rule.id);
            return { ...rule, action: "default", soundId: null };
          }
          return rule;
        });
        const settings =
          state.settings.defaultSoundId === id
            ? { ...state.settings, defaultSoundId: null }
            : state.settings;
        await storage.set({ sounds, rules, settings });
        await soundStore.delete(id);
        return { affectedRuleIds };
      }),

    setSettings: (patch) =>
      mutate(async (state) => {
        const merged = { ...state.settings };
        if (patch.enabled !== undefined) merged.enabled = patch.enabled !== false;
        if (patch.volume !== undefined) merged.volume = clampVolume(patch.volume);
        if (patch.showPopups !== undefined) merged.showPopups = patch.showPopups === true;
        if (patch.defaultSoundId !== undefined) {
          if (patch.defaultSoundId !== null) requireSound(state, patch.defaultSoundId);
          merged.defaultSoundId = patch.defaultSoundId;
        }
        await storage.set({ settings: merged });
        return merged;
      }),

    /** Remembers only name, kind and chat id -- never message text. */
    recordSender: ({ name, kind, chatId }) =>
      mutate(async (state) => {
        const trimmed = typeof name === "string" ? name.trim() : "";
        if (!trimmed || !RULE_KINDS.includes(kind)) return;
        const entry = { name: trimmed, kind, lastSeen: now() };
        if (kind === "chat" && typeof chatId === "string" && chatId) entry.chatId = chatId;
        const others = state.recentSenders.filter((s) => senderKey(s) !== senderKey(entry));
        await storage.set({ recentSenders: [entry, ...others].slice(0, MAX_RECENT_SENDERS) });
      }),

    /**
     * Remember chat names read from WhatsApp's chat list. Newly reported names go first (WhatsApp
     * lists most recent chats first); names already known keep their place after them.
     */
    recordChats: (names) =>
      mutate(async (state) => {
        const seen = new Set();
        const fresh = [];
        for (const raw of Array.isArray(names) ? names : []) {
          const name = cleanDisplayName(raw);
          const key = normalizeName(name);
          if (!name || name.length > 100 || seen.has(key)) continue;
          seen.add(key);
          fresh.push({ name });
        }
        if (fresh.length === 0) return;
        const rest = state.knownChats.filter((chat) => !seen.has(normalizeName(chat.name)));
        const knownChats = [...fresh, ...rest].slice(0, MAX_KNOWN_CHATS);
        if (JSON.stringify(knownChats) !== JSON.stringify(state.knownChats)) {
          await storage.set({ knownChats });
        }
      }),
  };
}
