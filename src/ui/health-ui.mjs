import { HEALTH_KEY, buildDiagnostics, healthStatus } from "../core/health.mjs";
import { h } from "./dom.mjs";
import { STRINGS as S } from "./strings.mjs";
import { formatAgo } from "./view-model.mjs";

export { formatAgo };

/** The sentence and colour for the status line. */
export function healthMessage(health, now) {
  const status = healthStatus(health);
  switch (status.code) {
    case "working":
      return {
        level: status.level,
        text: `${S.healthWorking} ${formatAgo(Math.max(0, now - status.at))}.`,
      };
    case "no-sound":
      return { level: status.level, text: S.healthNoSound };
    case "play-blocked":
      return { level: status.level, text: S.healthPlayBlocked };
    case "list-unreadable":
      return { level: status.level, text: S.healthListUnreadable };
    case "play-failed":
      return { level: status.level, text: S.healthPlayFailed };
    case "titles-generic":
      return { level: status.level, text: S.healthTitlesGeneric };
    case "sender-format":
      return { level: status.level, text: S.healthSenderFormat };
    case "no-chat-info":
      return { level: status.level, text: S.healthNoChatInfo };
    case "hook-missing":
      return { level: status.level, text: S.healthHookMissing };
    case "hook-overwritten":
      return { level: status.level, text: S.healthHookOverwritten };
    default:
      return { level: status.level, text: S.healthWaiting };
  }
}

/**
 * "Is it working?": a one-line status that follows the WhatsApp tab's own record, plus (with
 * `diagnostics`) a button that copies a report with no names, messages or sounds in it.
 * Returns the element to place on the page.
 */
export function mountHealth({
  document,
  stateStore,
  chrome,
  diagnostics = false,
  now = () => Date.now(),
}) {
  const win = document.defaultView;
  const el = (tag, props, ...kids) => h(document, tag, props, ...kids);

  const line = el("p", { class: "health health-idle", id: "healthLine", role: "status" });
  const report = el("textarea", {
    id: "diagnosticsText",
    class: "diagnostics-text",
    readonly: true,
    rows: 8,
    hidden: true,
    "aria-label": S.diagnosticsTitle,
  });
  const note = el("p", { class: "hint", id: "diagnosticsNote", hidden: true });

  async function currentReport() {
    const [health, state] = await Promise.all([stateStore.loadHealth(), stateStore.load()]);
    return JSON.stringify(
      buildDiagnostics({
        version: chrome?.runtime?.getManifest?.().version,
        userAgent: win.navigator?.userAgent,
        health,
        state,
        now: now(),
      }),
      null,
      2
    );
  }

  async function onCopy() {
    const text = await currentReport();
    try {
      await win.navigator.clipboard.writeText(text);
      report.hidden = true;
      note.textContent = S.diagnosticsCopied;
    } catch {
      // Clipboard access can be refused: show the text so it can be selected and copied by hand.
      report.value = text;
      report.hidden = false;
      report.select?.();
      note.textContent = S.diagnosticsManual;
    }
    note.hidden = false;
  }

  async function render() {
    try {
      const { level, text } = healthMessage(await stateStore.loadHealth(), now());
      line.className = `health health-${level}`;
      line.textContent = text;
    } catch {
      // The status line is a nicety: leave whatever it showed.
    }
  }

  chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes[HEALTH_KEY]) render();
  });
  render();

  return el(
    "div",
    { class: "health-block" },
    line,
    diagnostics
      ? el(
          "div",
          { class: "health-tools" },
          el("p", { class: "hint" }, S.diagnosticsHint),
          el(
            "button",
            {
              class: "btn btn-secondary btn-small",
              id: "copyDiagnostics",
              type: "button",
              onClick: onCopy,
            },
            S.copyDiagnostics
          ),
          note,
          report
        )
      : null
  );
}
