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
  searchPlaceholder: "Search your chats to give one a sound…",
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

  chatsTitle: "Your chats",
  chatsHint:
    "Search for a chat and pick its sound. Chats that already have their own sound are listed here.",
  chatsEmpty: "No chats yet. Open WhatsApp Web, then press Refresh to load your chats.",
  chatsSearchPrompt: "No chat has its own sound yet. Search above to find one and pick its sound.",
  chatsNoMatch: "No chat matches that. Press Refresh if it's missing, or add it by name below.",
  chatsMore: "More matches not shown. Keep typing to narrow it down.",
  refreshChats: "Refresh chats",
  scanning: "Reading your WhatsApp chat list…",
  scanNoTab: "Open WhatsApp Web in a tab first, then try again.",
  scanNotReady: "Reload the WhatsApp tab once, then try again.",
  scanNoList:
    "Couldn't read the chat list on the page (WhatsApp may have changed). Use the last-resort box below for now.",
  scanFailed: "Couldn't read your chats. Reload the WhatsApp tab and try again.",
  addByName: "Last resort: add a chat by name",
  addByNameHint: "Only if a chat is missing from the list. The name must match WhatsApp exactly.",
  peopleTitle: "People inside groups (advanced)",
  peopleHint: "Give one person their own sound in every group they write in.",
  uploadFor: "Upload your own sound for",
  uploadButton: "Upload",
  uploading: "Uploading",
  uploadTitle: "Upload a sound",
  uploadForLabel: "For the chat:",
  uploadHint: "Pick an mp3, wav or ogg file (up to 2 MB). It becomes this chat's sound.",
  chooseFile: "Choose a sound file…",
  uploadClosing: "This window will close.",
  uploadNoChat: "That chat isn't in your list any more. Close this window and try again.",

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
