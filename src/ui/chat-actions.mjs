import { normalizeName } from "../core/normalize.mjs";
import { MSG_SCAN, WHATSAPP_MATCH as WHATSAPP_TABS } from "../core/protocol.mjs";
import { STRINGS as S } from "./strings.mjs";
import { CHOICE_DEFAULT, choiceToAction } from "./view-model.mjs";

/**
 * Apply a sound choice to one chat row, on every identity the row stands for. Choosing "Default
 * sound" simply removes the chat's own rules, so there is never a pointless "use the default" rule.
 */
export async function applyChoice(stateStore, row, choice) {
  if (choice === CHOICE_DEFAULT) {
    for (const ruleId of new Set(row.targets.map((t) => t.ruleId).filter(Boolean))) {
      await stateStore.deleteRule(ruleId);
    }
    return;
  }
  // `enabled: true` also revives a rule that an older version had switched off.
  const patch = { ...choiceToAction(choice), enabled: true };
  for (const target of row.targets) {
    if (target.ruleId) {
      await stateStore.updateRule(target.ruleId, patch);
    } else {
      await stateStore.addRule({
        kind: row.kind,
        match: row.name,
        chatId: row.kind === "chat" ? target.chatId : null,
        ...patch,
      });
    }
  }
}

/**
 * Add a chat by typing its name. A name that matches a chat we have already seen is bound to that
 * chat's id, so it keeps working if the contact is renamed.
 */
export async function addChatByName(stateStore, state, name, choice) {
  const wanted = normalizeName(name);
  const seen = state.recentSenders.filter((entry) => normalizeName(entry.name) === wanted);
  const known = seen.find((entry) => entry.kind === "chat") ?? seen[0] ?? null;
  return stateStore.addRule({
    kind: known?.kind ?? "chat",
    match: name.trim(),
    chatId: known?.kind === "chat" ? (known.chatId ?? null) : null,
    ...choiceToAction(choice),
  });
}

/**
 * Ask the WhatsApp Web tab to scroll through its chat list and report every chat name.
 * `bringToFront` (settings page) briefly shows the WhatsApp tab, because a background tab does not
 * render the rows that scrolling reveals, then returns to where the user was.
 * Resolves { ok, count?, reason? }.
 */
export async function refreshChatsFromWhatsApp(chrome, { bringToFront = false } = {}) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: WHATSAPP_TABS });
  } catch {
    return { ok: false, reason: "no-access" };
  }
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  if (!tab) return { ok: false, reason: "no-tab" };

  let previous = null;
  if (bringToFront && !tab.active) {
    try {
      previous = (await chrome.tabs.getCurrent())?.id ?? null;
      await chrome.tabs.update(tab.id, { active: true });
    } catch {
      previous = null;
    }
  }
  try {
    return (
      (await chrome.tabs.sendMessage(tab.id, { type: MSG_SCAN })) ?? {
        ok: false,
        reason: "not-ready",
      }
    );
  } catch {
    return { ok: false, reason: "not-ready" };
  } finally {
    if (previous !== null) {
      try {
        await chrome.tabs.update(previous, { active: true });
      } catch {
        // The settings tab was closed meanwhile; nothing to go back to.
      }
    }
  }
}

/** A friendly sentence for the outcome of refreshChatsFromWhatsApp. */
export function describeScan(result) {
  if (result.ok)
    return { text: `Found ${result.count} chat${result.count === 1 ? "" : "s"}.`, kind: "ok" };
  const text =
    {
      "no-tab": S.scanNoTab,
      "not-ready": S.scanNotReady,
      "no-access": S.scanNotReady,
      "no-chat-list": S.scanNoList,
      "no-chats-found": S.scanNoList,
    }[result.reason] ?? S.scanFailed;
  return { text, kind: "error" };
}
