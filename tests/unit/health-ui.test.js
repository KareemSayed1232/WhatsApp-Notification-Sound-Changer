import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { createStateStore } from "../../src/core/state-store.mjs";
import { formatAgo, healthMessage, mountHealth } from "../../src/ui/health-ui.mjs";
import { STRINGS as S } from "../../src/ui/strings.mjs";

// Provided by the jsdom test environment (see vitest.config.js).
const { document, window } = globalThis;

const MINUTE = 60_000;
const NOW = 10_000_000;
const $ = (selector) => document.querySelector(selector);

let storage;
let store;
let changeListeners;
let chrome;

function mount(health, options = {}) {
  storage = createFakeStorage(health ? { health } : {});
  store = createStateStore({ storage, soundStore: createFakeSoundStore() });
  changeListeners = [];
  chrome = {
    runtime: { getManifest: () => ({ version: "3.0" }) },
    storage: { onChanged: { addListener: (fn) => changeListeners.push(fn) } },
  };
  document.body.innerHTML = "";
  const node = mountHealth({
    document,
    stateStore: store,
    chrome,
    now: () => NOW,
    ...options,
  });
  document.body.append(node);
  return node;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("formatAgo", () => {
  it.each([
    [0, S.justNow],
    [59_000, S.justNow],
    [MINUTE, "1 minute ago"],
    [5 * MINUTE, "5 minutes ago"],
    [60 * MINUTE, "1 hour ago"],
    [3 * 60 * MINUTE, "3 hours ago"],
    [24 * 60 * MINUTE, "1 day ago"],
    [4 * 24 * 60 * MINUTE, "4 days ago"],
  ])("%i ms -> %s", (ms, text) => {
    expect(formatAgo(ms)).toBe(text);
  });
});

describe("healthMessage", () => {
  it("says it is waiting before anything has happened", () => {
    expect(healthMessage(undefined, NOW)).toEqual({ level: "idle", text: S.healthWaiting });
  });

  it("says when it last handled a message", () => {
    const text = healthMessage({ lastPairedAt: NOW - 5 * MINUTE }, NOW);
    expect(text).toEqual({ level: "ok", text: `${S.healthWorking} 5 minutes ago.` });
  });

  it("explains each problem in its own words", () => {
    expect(healthMessage({ silentRun: 3 }, NOW)).toEqual({ level: "warn", text: S.healthNoSound });
    expect(healthMessage({ hook: { state: "missing" } }, NOW)).toEqual({
      level: "bad",
      text: S.healthHookMissing,
    });
    expect(healthMessage({ hook: { state: "overwritten" } }, NOW)).toEqual({
      level: "bad",
      text: S.healthHookOverwritten,
    });
  });
});

describe("the status line", () => {
  it("shows the verdict from the stored record", async () => {
    mount({ lastPairedAt: NOW - 2 * MINUTE });
    await settle();
    expect($("#healthLine").textContent).toBe(`${S.healthWorking} 2 minutes ago.`);
    expect($("#healthLine").className).toContain("health-ok");
  });

  it("shows the waiting message when nothing is stored", async () => {
    mount(undefined);
    await settle();
    expect($("#healthLine").textContent).toBe(S.healthWaiting);
    expect($("#healthLine").className).toContain("health-idle");
  });

  it("updates when the WhatsApp tab writes new status", async () => {
    mount(undefined);
    await settle();
    await storage.set({ health: { silentRun: 4 } });
    for (const listener of changeListeners) listener({ health: { newValue: {} } }, "local");
    await settle();
    expect($("#healthLine").textContent).toBe(S.healthNoSound);
    expect($("#healthLine").className).toContain("health-warn");
  });

  it("ignores changes to other data", async () => {
    mount(undefined);
    await settle();
    const before = $("#healthLine").textContent;
    await storage.set({ health: { silentRun: 4 } });
    for (const listener of changeListeners) listener({ rules: {} }, "local");
    await settle();
    expect($("#healthLine").textContent).toBe(before);
  });

  it("shows stored text as text, never as markup", async () => {
    mount({ shapes: { tags: ["<img src=x onerror=alert(1)>"] }, hook: { state: "<b>x</b>" } });
    await settle();
    expect($("#healthLine img")).toBeNull();
    expect($("#healthLine b")).toBeNull();
  });

  it("is on the popup variant without a diagnostics button", () => {
    mount(undefined);
    expect($("#copyDiagnostics")).toBeNull();
  });
});

describe("copying diagnostics", () => {
  let writeText;

  beforeEach(() => {
    writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  });

  it("copies a report of counts and shapes, with the version and browser", async () => {
    mount({ notifications: 2, lastPairedAt: NOW - 60_000, paired: 2 }, { diagnostics: true });
    await store.addRule({ kind: "chat", match: "Radwa Secret", action: "silent" });
    $("#copyDiagnostics").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());

    const report = JSON.parse(writeText.mock.calls[0][0]);
    expect(report).toMatchObject({
      extension: "3.0",
      status: "working",
      counts: { notifications: 2, soundsHandled: 2 },
      secondsSince: { soundHandled: 60 },
      setup: { rules: 1 },
    });
    expect(typeof report.browser).toBe("string");
    expect(writeText.mock.calls[0][0]).not.toContain("Radwa");
    await vi.waitFor(() => expect($("#diagnosticsNote").textContent).toBe(S.diagnosticsCopied));
    expect($("#diagnosticsText").hidden).toBe(true);
  });

  it("shows the text to copy by hand when the clipboard is refused", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    mount(undefined, { diagnostics: true });
    $("#copyDiagnostics").click();
    await vi.waitFor(() => expect($("#diagnosticsText").hidden).toBe(false));
    expect(JSON.parse($("#diagnosticsText").value).status).toBe("waiting");
    expect($("#diagnosticsNote").textContent).toBe(S.diagnosticsManual);
  });
});
