// All user-facing text lives here so translating the UI later means editing one file.

export const STRINGS = {
  appName: "WhatsApp Sound Changer",
  tagline: "A different sound for every chat.",
  enabled: "Enabled",
  settings: "All settings",

  rulesTitle: "Chats and people",
  rulesHint:
    "Pick a sound for a chat, a group, or one person inside a group. Everything else uses your default sound.",
  addRule: "Add",
  recentLabel: "Recent chats",
  recentPlaceholder: "Choose from recent chats…",
  recentHelp: "Chats appear here after they message you while WhatsApp Web is open.",
  nameLabel: "Name",
  namePlaceholder: "e.g. Mom, or a group name",
  kindLabel: "Applies to",
  kindChat: "A chat or group",
  kindSender: "A person inside a group",
  soundLabel: "Sound",
  search: "Search",
  searchPlaceholder: "Search chats…",
  rulesEmpty: "No chats yet. Add one above, or pick from recent chats.",
  rulesNoMatch: "Nothing matches that search.",
  colName: "Chat",
  colSound: "Sound",
  colOn: "On",
  followsRenames: "follows renames",
  delete: "Delete",

  soundsTitle: "Sounds",
  soundsHint: "Upload the sounds you want to use. They stay on this device.",
  defaultSound: "Default sound",
  defaultSoundHint: "Used for every chat that has no sound of its own.",
  defaultHintOff:
    "No default sound: chats without their own sound will use WhatsApp's normal sound.",
  noDefault: "None (keep WhatsApp's own sound)",
  volume: "Volume",
  addSound: "Add a sound",
  soundsEmpty: "No sounds yet. Add an mp3, wav or ogg file (up to 2 MB).",
  preview: "Preview",
  setDefault: "Make default",
  defaultBadge: "Default",

  choiceDefault: "Default sound",
  choiceSilent: "Silent (no sound)",
  chooseSound: "Choose a sound…",

  popupsTitle: "Desktop notifications",
  popupsLabel: "Show WhatsApp's pop-up notifications",
  popupsHint:
    "Off by default: the pop-up is hidden and only the sound plays, even if your browser blocks notifications.",

  privacy: "Everything stays on this device. Nothing is sent anywhere.",

  popupRecent: "Recent chats",
  popupRecentEmpty: "Chats that message you will show up here.",
  popupNeedSound: "Add a sound in settings to get started.",
  popupOpenSettings: "Add sounds and more settings",
  popupChatsTitle: "Your chats",
  popupChatsEmpty: "No chats yet. Add one below.",
  popupAddTitle: "Add a chat",
  popupAddHint: "Type a name, or pick one from your recent chats.",
  popupNamePlaceholder: "Chat, group or contact name",
  saved: "Saved.",
};

const ERRORS = {
  "empty-match": "Enter a name first.",
  "match-too-long": "That name is too long.",
  "duplicate-rule": "You already have a rule for that chat.",
  "missing-sound": "Choose a sound first.",
  "unknown-sound": "That sound no longer exists.",
  "unsupported-type": "That file type isn't supported. Use mp3, wav, ogg, m4a, aac, flac or webm.",
  "empty-file": "That file is empty.",
  "file-too-large": "That sound is larger than 2 MB. Pick a shorter one.",
  "not-found": "That item no longer exists.",
};

export function errorMessage(error) {
  return ERRORS[error?.code] ?? error?.message ?? "Something went wrong.";
}
