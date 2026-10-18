import { normalizeName } from "./normalize.mjs";

export const SCHEMA_VERSION = 2;
export const MAX_SOUND_BYTES = 2 * 1024 * 1024;
export const MAX_MATCH_LENGTH = 200;
export const MAX_RECENT_SENDERS = 50;
export const MAX_KNOWN_CHATS = 500;

export const RULE_KINDS = ["chat", "sender"];
export const RULE_ACTIONS = ["sound", "silent", "default"];

const SOUND_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/webm",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/flac",
  "audio/x-flac",
]);

export class ValidationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
  }
}

export function defaultSettings() {
  // showPopups: false = swallow WhatsApp's desktop notification, keep only the sound.
  return { enabled: true, volume: 1, defaultSoundId: null, showPopups: false };
}

export function clampVolume(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

export function validateRule(rule) {
  if (!RULE_KINDS.includes(rule?.kind)) throw new ValidationError("invalid-kind");
  if (!RULE_ACTIONS.includes(rule.action)) throw new ValidationError("invalid-action");
  if (typeof rule.match !== "string" || normalizeName(rule.match) === "") {
    throw new ValidationError("empty-match");
  }
  if (rule.match.trim().length > MAX_MATCH_LENGTH) throw new ValidationError("match-too-long");
  if (rule.action === "sound" && !rule.soundId) throw new ValidationError("missing-sound");
  if (rule.chatId != null && (typeof rule.chatId !== "string" || rule.chatId.length > 200)) {
    throw new ValidationError("invalid-chat-id");
  }
}

/** `file` only needs `type` and `size`, so it works for File objects and plain test doubles. */
export function validateSoundFile(file) {
  if (!SOUND_MIME_TYPES.has(file?.type)) throw new ValidationError("unsupported-type");
  if (!(file.size > 0)) throw new ValidationError("empty-file");
  if (file.size > MAX_SOUND_BYTES) throw new ValidationError("file-too-large");
}
