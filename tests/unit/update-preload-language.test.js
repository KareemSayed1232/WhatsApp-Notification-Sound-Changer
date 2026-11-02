import { describe, it, expect, vi } from "vitest";
import { freshDocument } from "../helpers/load-script.js";
import { readChatNames } from "../../src/content/chat-list.mjs";
import { HOOK_VERSION, installMainHook } from "../../src/content/main-hook.mjs";

// ------------------------------------------------------------------ an update replaces the old hook

// The page hook installs once per tab. After the extension is updated, the background injects the
// new hook into open WhatsApp tabs; the old hook used to stay (it marked the tab as hooked), so an
// OLD hook ran beside the NEW bridge until the tab was reloaded.
describe("a newer page hook replaces an older one left in the tab", () => {
  const MARKER = Symbol.for("wansc.main-hook");
  const win = () => ({
    Notification: class {
      static permission = "denied";
    },
    HTMLMediaElement: class {
      play() {
        return Promise.resolve();
      }
    },
    CustomEvent,
  });

  it("uninstalls a hook from an older version and installs itself", () => {
    const w = win();
    const old = { uninstall: vi.fn(() => delete w[MARKER]) }; // an old hook: no version
    Object.defineProperty(w, MARKER, { value: old, configurable: true });
    const hook = installMainHook({ window: w, document: freshDocument() });
    expect(old.uninstall).toHaveBeenCalledTimes(1);
    expect(hook).not.toBe(old);
    expect(hook.version).toBe(HOOK_VERSION);
    hook.uninstall();
  });

  it("keeps a hook of the same version (installing twice must not wrap twice)", () => {
    const w = win();
    const doc = freshDocument();
    const first = installMainHook({ window: w, document: doc });
    expect(installMainHook({ window: w, document: doc })).toBe(first);
    first.uninstall();
  });
});

// ------------------------------------------------------------------ sounds loaded in advance

// Each sound used to be fetched from the extension's background worker (which Edge puts to sleep)
// and decoded only when a message arrived: too late, so WhatsApp's ding stood in.
// ------------------------------------------------------------------ the badge in any language

// The unread badge's label is in the UI language ("8 unread messages", "8 رسائل غير مقروءة").
// Its TEXT is always just the number, which is the language-independent sign that it is a badge.
describe("the unread badge is never a name, in any language", () => {
  const row = (name, unread) =>
    `<div role="row"><div>` +
    `<span dir="auto" title="${unread} رسائل غير مقروءة" aria-label="${unread} رسائل غير مقروءة">${unread}</span>` +
    `<span dir="auto" title="${name}">${name}</span>` +
    `<span dir="auto" title="أهلاً">أهلاً</span></div></div>`;
  const page = () =>
    freshDocument(
      `<!DOCTYPE html><html><body><div id="pane-side"><div role="grid">` +
        row("أمي", 8) +
        row("Radwa", 2) +
        `</div></div></body></html>`
    );

  it("the name reader (Refresh chat list) skips it", () => {
    expect(readChatNames(page())).toEqual(["أمي", "Radwa"]);
  });
});
