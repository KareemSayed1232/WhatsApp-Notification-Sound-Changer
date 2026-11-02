import { HEALTH_KEY, buildDiagnostics, healthStatus } from "../core/health.mjs";
import { MSG_LAYOUT, MSG_SELF_TEST, WHATSAPP_MATCH } from "../core/protocol.mjs";
import { openWhatsAppTab } from "./chat-actions.mjs";
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
    case "play-failed":
      return { level: status.level, text: S.healthPlayFailed };
    case "titles-generic":
      return { level: status.level, text: S.healthTitlesGeneric };
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
  // When the browser is waiting for a click in WhatsApp, take the user straight there.
  const openButton = el(
    "button",
    {
      class: "btn btn-primary btn-small",
      id: "openWhatsApp",
      type: "button",
      hidden: true,
      onClick: () => openWhatsAppTab(chrome).then(() => win.close?.()),
    },
    S.openWhatsApp
  );
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

  const selfTestResults = el("ul", { class: "self-test", id: "selfTestResults", hidden: true });

  function tell(text) {
    note.textContent = text;
    note.hidden = false;
  }

  /** The WhatsApp tab (the active one if several), or null. */
  async function whatsappTab() {
    const tabs = await chrome.tabs.query({ url: WHATSAPP_MATCH });
    return tabs.find((t) => t.active) ?? tabs[0] ?? null;
  }

  /** Ask the WhatsApp tab to check everything the extension relies on, and list the results. */
  async function onRunSelfTest() {
    selfTestResults.hidden = true;
    let answer = null;
    try {
      const tab = await whatsappTab();
      if (!tab) return tell(S.scanNoTab);
      answer = await chrome.tabs.sendMessage(tab.id, { type: MSG_SELF_TEST });
    } catch {
      answer = null;
    }
    if (!answer?.ok || !Array.isArray(answer.checks)) return tell(S.scanNotReady);
    selfTestResults.replaceChildren(
      ...answer.checks.map((c) =>
        el(
          "li",
          { class: c.ok ? "pass" : "fail" },
          `${c.ok ? "✓" : "✗"} ${S.selfTestNames[c.id] ?? c.id}`,
          c.detail ? el("span", { class: "meta" }, ` (${c.detail})`) : null
        )
      )
    );
    selfTestResults.hidden = false;
    tell(answer.checks.every((c) => c.ok) ? S.selfTestAllPassed : S.selfTestSomeFailed);
  }

  /** The chat list's layout from the WhatsApp tab, names replaced, copied for a report. */
  async function onCopyLayout() {
    let text = null;
    try {
      const tabs = await chrome.tabs.query({ url: WHATSAPP_MATCH });
      const tab = tabs.find((t) => t.active) ?? tabs[0];
      if (!tab) {
        note.textContent = S.scanNoTab;
        note.hidden = false;
        return;
      }
      const answer = await chrome.tabs.sendMessage(tab.id, { type: MSG_LAYOUT });
      if (answer?.ok) {
        const version = chrome?.runtime?.getManifest?.().version ?? "unknown";
        text = `<!-- ${S.appName} ${version}: WhatsApp chat list layout, names and messages replaced -->
${answer.html}`;
      }
    } catch {
      text = null;
    }
    if (!text) {
      note.textContent = S.layoutFailed;
      note.hidden = false;
      return;
    }
    try {
      await win.navigator.clipboard.writeText(text);
      report.hidden = true;
      note.textContent = S.layoutCopied;
    } catch {
      report.value = text;
      report.hidden = false;
      report.select?.();
      note.textContent = S.diagnosticsManual;
    }
    note.hidden = false;
  }

  async function render() {
    try {
      const health = await stateStore.loadHealth();
      const { level, text } = healthMessage(health, now());
      line.className = `health health-${level}`;
      line.textContent = text;
      const code = healthStatus(health).code;
      openButton.hidden = code !== "play-blocked";
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
    openButton,
    diagnostics
      ? el(
          "details",
          { class: "health-tools" },
          el("summary", {}, S.troubleshooting),
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
          el("p", { class: "hint" }, S.selfTestHint),
          el(
            "button",
            {
              class: "btn btn-secondary btn-small",
              id: "runSelfTest",
              type: "button",
              onClick: onRunSelfTest,
            },
            S.runSelfTest
          ),
          selfTestResults,
          el("p", { class: "hint" }, S.layoutHint),
          el(
            "button",
            {
              class: "btn btn-secondary btn-small",
              id: "copyLayout",
              type: "button",
              onClick: onCopyLayout,
            },
            S.copyLayout
          ),
          note,
          report
        )
      : null
  );
}
