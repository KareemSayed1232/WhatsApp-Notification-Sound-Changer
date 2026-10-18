import { describe, it, expect, beforeEach } from "vitest";
import { readChatNames, scanChatList } from "../../src/content/chat-list.mjs";

// Provided by the jsdom test environment (see vitest.config.js).
const { document } = globalThis;

const row = (name, { preview = "last message text", testid = true } = {}) =>
  `<div role="listitem"><div ${testid ? 'data-testid="cell-frame-title"' : ""}>` +
  `<span dir="auto" title="${name}">${name}</span></div>` +
  `<span dir="auto" title="${preview}">${preview}</span></div>`;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("readChatNames", () => {
  it("returns nothing when the chat list is not on the page", () => {
    document.body.innerHTML = "<div>loading…</div>";
    expect(readChatNames(document)).toEqual([]);
  });

  it("reads each chat's name in on-screen order, not the last-message preview", () => {
    document.body.innerHTML = `<div id="pane-side">${row("Radwa")}${row("Family")}</div>`;
    expect(readChatNames(document)).toEqual(["Radwa", "Family"]);
  });

  it("still finds the name when the title is not wrapped in the usual test id", () => {
    document.body.innerHTML = `<div id="pane-side">${row("Mom", { testid: false })}</div>`;
    expect(readChatNames(document)).toEqual(["Mom"]);
  });

  it("falls back to any title span when the row markup changed", () => {
    document.body.innerHTML =
      '<div id="pane-side"><div><span dir="auto" title="Alice">Alice</span></div></div>';
    expect(readChatNames(document)).toEqual(["Alice"]);
  });

  it("cleans invisible marks, drops duplicates, empties and absurdly long names", () => {
    document.body.innerHTML =
      '<div id="pane-side">' +
      row("Radwa‎") +
      row("radwa") +
      row("   ") +
      row("x".repeat(101)) +
      row("Mom") +
      "</div>";
    expect(readChatNames(document)).toEqual(["Radwa", "Mom"]);
  });

  it("falls back to the visible text when a row has no title attribute", () => {
    document.body.innerHTML =
      '<div id="pane-side"><div role="listitem"><span dir="auto" title="">Bob</span></div></div>';
    expect(readChatNames(document)).toEqual(["Bob"]);
  });
});

/**
 * A fake virtualised list: like WhatsApp, it renders only the rows near the scroll position.
 */
function virtualList(total, { rowHeight = 50, viewHeight = 250 } = {}) {
  document.body.innerHTML = '<div id="pane-side"></div>';
  const pane = document.querySelector("#pane-side");
  let top = 0;
  const render = () => {
    const first = Math.floor(top / rowHeight);
    const count = Math.ceil(viewHeight / rowHeight) + 2;
    pane.innerHTML = Array.from({ length: count }, (_, i) => first + i)
      .filter((i) => i < total)
      .map((i) => row(`Chat ${i}`))
      .join("");
  };
  Object.defineProperty(pane, "scrollTop", {
    get: () => top,
    set: (value) => {
      top = Math.max(0, Math.min(value, total * rowHeight - viewHeight));
      render();
    },
    configurable: true,
  });
  Object.defineProperty(pane, "scrollHeight", { value: total * rowHeight, configurable: true });
  Object.defineProperty(pane, "clientHeight", { value: viewHeight, configurable: true });
  render();
  return pane;
}

const instant = () => Promise.resolve();

describe("scanChatList", () => {
  it("scrolls through a virtualised list and finds every chat, in order", async () => {
    virtualList(60);
    const result = await scanChatList({ document, wait: instant });
    expect(result.ok).toBe(true);
    expect(result.names).toHaveLength(60);
    expect(result.names[0]).toBe("Chat 0");
    expect(result.names.at(-1)).toBe("Chat 59");
  });

  it("puts the scroll position back where the user had it", async () => {
    const pane = virtualList(60);
    pane.scrollTop = 400;
    await scanChatList({ document, wait: instant });
    expect(pane.scrollTop).toBe(400);
  });

  it("handles a short list that needs no scrolling", async () => {
    virtualList(3);
    expect((await scanChatList({ document, wait: instant })).names).toEqual([
      "Chat 0",
      "Chat 1",
      "Chat 2",
    ]);
  });

  it("says so when the chat list is not on the page", async () => {
    document.body.innerHTML = "<div></div>";
    expect(await scanChatList({ document, wait: instant })).toEqual({
      ok: false,
      reason: "no-chat-list",
      names: [],
    });
  });

  it("says so when the list is there but no names could be read", async () => {
    document.body.innerHTML = '<div id="pane-side"><div>nothing useful</div></div>';
    const result = await scanChatList({ document, wait: instant });
    expect(result).toMatchObject({ ok: false, reason: "no-chats-found", names: [] });
  });

  it("gives up after maxSteps instead of looping forever", async () => {
    virtualList(10_000);
    const result = await scanChatList({ document, wait: instant, maxSteps: 3 });
    expect(result.ok).toBe(true);
    expect(result.names.length).toBeLessThan(40);
  });

  it("restores the scroll position even if reading fails", async () => {
    const pane = virtualList(60);
    pane.scrollTop = 200;
    let calls = 0;
    const flaky = () => {
      if (++calls > 2) throw new Error("page went away");
      return Promise.resolve();
    };
    await expect(scanChatList({ document, wait: flaky })).rejects.toThrow("page went away");
    expect(pane.scrollTop).toBe(200);
  });
});
