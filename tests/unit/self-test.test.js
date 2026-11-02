import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeSoundStore, createFakeStorage } from "../helpers/fake-storage.js";
import { runSelfTest } from "../../src/content/self-test.mjs";
import { MSG_SELF_TEST } from "../../src/core/protocol.mjs";
import { createStateStore } from "../../src/core/state-store.mjs";
import { mountHealth } from "../../src/ui/health-ui.mjs";
import { STRINGS as S } from "../../src/ui/strings.mjs";

// Provided by the jsdom test environment (see vitest.config.js).
const { document } = globalThis;
// Nothing can check the real WhatsApp automatically (it needs your logged-in account), so the
// extension checks itself inside your WhatsApp tab: Settings → Troubleshooting → Run a self-test.
// Run it in Edge and Firefox before every release, and after any WhatsApp redesign.

const healthy = () => ({
  hookState: () => "ok",
  settings: { enabled: true },
  readChats: () =>
    new Map([
      ["a", { name: "Radwa", count: 2, muted: false }],
      ["b", { name: "Family", count: 0, muted: false }],
    ]),
  layers: () => ({ list: "builtin", name: "builtin", counter: "builtin" }),
  canPlay: () => true,
});

const byId = (checks) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("the self-test inside the WhatsApp tab", () => {
  it("passes everything on a healthy page", () => {
    const checks = runSelfTest(healthy());
    expect(checks.map((c) => c.id)).toEqual(["hook", "enabled", "chat-list", "sound"]);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(byId(checks)["chat-list"].detail).toBe("2 chats (builtin)");
  });

  it("fails the hook check when the page hook is missing or replaced", () => {
    expect(byId(runSelfTest({ ...healthy(), hookState: () => "missing" })).hook.ok).toBe(false);
    expect(byId(runSelfTest({ ...healthy(), hookState: () => "overwritten" })).hook.ok).toBe(false);
  });

  it("fails when the extension is switched off", () => {
    expect(byId(runSelfTest({ ...healthy(), settings: { enabled: false } })).enabled.ok).toBe(
      false
    );
  });

  it("fails the chat list check when nothing can be read", () => {
    const checks = byId(
      runSelfTest({
        ...healthy(),
        readChats: () => new Map(),
        layers: () => ({ list: "none", name: "none", counter: "none" }),
      })
    );
    expect(checks["chat-list"].ok).toBe(false);
  });

  it("fails the sound check while the browser waits for a click", () => {
    expect(byId(runSelfTest({ ...healthy(), canPlay: () => false })).sound.ok).toBe(false);
  });

  it("never lets one broken check stop the others", () => {
    const checks = runSelfTest({
      ...healthy(),
      readChats: () => {
        throw new Error("boom");
      },
    });
    expect(checks).toHaveLength(4);
    expect(byId(checks)["chat-list"].ok).toBe(false);
    expect(byId(checks).sound.ok).toBe(true);
  });

  it("reports no chat names", () => {
    expect(JSON.stringify(runSelfTest(healthy()))).not.toMatch(/Radwa|Family/);
  });
});

describe("Troubleshooting: Run a self-test", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function mount(sendMessage, tabs = [{ id: 4, active: true }]) {
    const store = createStateStore({
      storage: createFakeStorage(),
      soundStore: createFakeSoundStore(),
    });
    const chrome = {
      runtime: { getManifest: () => ({ version: "3.0.0" }) },
      tabs: { query: vi.fn(async () => tabs), sendMessage: vi.fn(sendMessage) },
      storage: { onChanged: { addListener: () => {} } },
    };
    document.body.append(mountHealth({ document, stateStore: store, chrome, diagnostics: true }));
    return chrome;
  }

  it("asks the WhatsApp tab and lists each check as passed or failed", async () => {
    const chrome = mount(async () => ({
      ok: true,
      checks: [
        { id: "hook", ok: true, detail: "ok" },
        { id: "sound", ok: false, detail: "waiting for a click" },
      ],
    }));
    document.querySelector("#runSelfTest").click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("#selfTestResults li")).toHaveLength(2)
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(4, { type: MSG_SELF_TEST });
    const items = [...document.querySelectorAll("#selfTestResults li")];
    expect(items[0].className).toContain("pass");
    expect(items[0].textContent).toContain(S.selfTestNames.hook);
    expect(items[1].className).toContain("fail");
    expect(items[1].textContent).toContain("waiting for a click");
  });

  it("says to open WhatsApp first when no tab is open", async () => {
    mount(async () => null, []);
    document.querySelector("#runSelfTest").click();
    await vi.waitFor(() =>
      expect(document.querySelector("#diagnosticsNote").textContent).toBe(S.scanNoTab)
    );
  });

  it("says to reload WhatsApp when the tab does not answer", async () => {
    mount(async () => {
      throw new Error("no receiver");
    });
    document.querySelector("#runSelfTest").click();
    await vi.waitFor(() =>
      expect(document.querySelector("#diagnosticsNote").textContent).toBe(S.scanNotReady)
    );
  });
});
