import { normalizeName } from "../core/normalize.mjs";
import { CHOICE_DEFAULT, choiceToAction } from "./view-model.mjs";

/**
 * Apply a sound choice to one chat row. Choosing "Default sound" simply removes the chat's own
 * rule, so there is never a pointless "use the default" rule hanging around.
 */
export async function applyChoice(stateStore, row, choice) {
  if (choice === CHOICE_DEFAULT) {
    if (row.ruleId) await stateStore.deleteRule(row.ruleId);
    return;
  }
  // `enabled: true` also revives a rule that an older version had switched off.
  const patch = { ...choiceToAction(choice), enabled: true };
  if (row.ruleId) {
    await stateStore.updateRule(row.ruleId, patch);
    return;
  }
  await stateStore.addRule({
    kind: row.kind,
    match: row.name,
    chatId: row.kind === "chat" ? row.chatId : null,
    ...patch,
  });
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
