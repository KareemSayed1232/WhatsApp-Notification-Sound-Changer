import { describe, it, expect } from "vitest";
import {
  SILENT_RUN_ATTENTION,
  applySignal,
  buildDiagnostics,
  classifyTag,
  describeSound,
  emptyHealth,
  healthStatus,
  sanitizeHealth,
} from "../../src/core/health.mjs";

const fold = (signals, start = emptyHealth(), at = 1_000) =>
  signals.reduce((health, signal) => applySignal(health, signal, at), start);

describe("classifyTag", () => {
  it.each([
    ["601@lid", "lid"],
    ["120363@g.us", "group"],
    ["201000@c.us", "phone"],
    ["201000@s.whatsapp.net", "phone"],
    ["status@broadcast", "broadcast"],
    ["1@newsletter", "newsletter"],
    ["something-new", "other"],
    ["", "none"],
    [undefined, "none"],
    [42, "none"],
  ])("%s -> %s", (tag, kind) => {
    expect(classifyTag(tag)).toBe(kind);
  });
});

describe("describeSound", () => {
  it("keeps only host, file type, route and whether the element was detached", () => {
    expect(
      describeSound("https://static.whatsapp.net/rsrc.php/yW/r/BS_BUUXbKq5.mp3?x=secret", {
        detached: true,
      })
    ).toEqual({ via: "audio", host: "static.whatsapp.net", ext: "mp3", detached: true });
  });

  it("describes local media without its address", () => {
    expect(describeSound("blob:https://web.whatsapp.com/abc-123").host).toBe("(local)");
    expect(describeSound("data:audio/mpeg;base64,AAAA").host).toBe("(local)");
  });

  it("copes with no URL and with unknown file types", () => {
    expect(describeSound("")).toEqual({
      via: "audio",
      host: "other",
      ext: "other",
      detached: false,
    });
    expect(describeSound("https://a.example/x.weird").ext).toBe("other");
  });

  it("accepts only known routes", () => {
    expect(describeSound("", { via: "webaudio" }).via).toBe("webaudio");
    expect(describeSound("", { via: "<script>" }).via).toBe("audio");
  });
});

describe("applySignal", () => {
  it("counts notifications and remembers the kinds of chat ids it has seen", () => {
    const health = fold([
      { type: "notification", tag: "1@lid" },
      { type: "notification", tag: "2@lid" },
      { type: "notification", tag: "3@g.us" },
    ]);
    expect(health.notifications).toBe(3);
    expect(health.shapes.tags).toEqual(["lid", "group"]);
    expect(health.lastNotificationAt).toBe(1_000);
  });

  it("a handled sound resets the silent run and records the sound's shape", () => {
    const health = fold([
      { type: "silent" },
      { type: "silent" },
      { type: "paired", url: "https://static.whatsapp.net/a/b.mp3", via: "audio", detached: true },
    ]);
    expect(health.silentRun).toBe(0);
    expect(health.paired).toBe(1);
    expect(health.shapes.sound).toEqual({
      via: "audio",
      host: "static.whatsapp.net",
      ext: "mp3",
      detached: true,
    });
  });

  it("a known sound with no notification counts as working too", () => {
    const health = fold([{ type: "unpaired", url: "https://static.whatsapp.net/a/b.mp3" }]);
    expect(health.unpaired).toBe(1);
    expect(health.lastPairedAt).toBe(1_000);
  });

  it("records the hook check and ignores unknown states and signals", () => {
    expect(fold([{ type: "hook", state: "overwritten" }]).hook.state).toBe("overwritten");
    expect(fold([{ type: "hook", state: "<b>" }]).hook.state).toBe("unknown");
    expect(fold([{ type: "bogus" }, null, undefined, "x"])).toEqual(emptyHealth());
  });

  it("does not modify the record it was given", () => {
    const before = emptyHealth();
    applySignal(before, { type: "notification", tag: "1@lid" }, 5);
    expect(before).toEqual(emptyHealth());
  });
});

describe("sanitizeHealth", () => {
  it("turns anything into a well-formed record", () => {
    expect(sanitizeHealth(undefined)).toEqual(emptyHealth());
    expect(sanitizeHealth("junk")).toEqual(emptyHealth());
    expect(sanitizeHealth({ notifications: -5, paired: "7", silentRun: NaN })).toEqual(
      emptyHealth()
    );
  });

  it("drops anything that is not on the allow-list, so stored text can never become UI text", () => {
    const clean = sanitizeHealth({
      shapes: {
        tags: ["lid", "<img onerror=x>", "group"],
        sound: { via: "<x>", host: "evil host!", ext: "exe", detached: "yes" },
      },
      hook: { state: "weird" },
    });
    expect(clean.shapes.tags).toEqual(["lid", "group"]);
    expect(clean.shapes.sound).toEqual({
      via: "audio",
      host: "other",
      ext: "other",
      detached: false,
    });
    expect(clean.hook.state).toBe("unknown");
  });
});

describe("healthStatus", () => {
  const handled = { type: "paired", url: "https://static.whatsapp.net/a.mp3" };

  it("waits for a first message", () => {
    expect(healthStatus(emptyHealth())).toEqual({ code: "waiting", level: "idle" });
  });

  it("is working once a sound has been handled", () => {
    expect(healthStatus(fold([handled], undefined, 9))).toEqual({
      code: "working",
      level: "ok",
      at: 9,
    });
  });

  it("warns after several notifications in a row with no sound", () => {
    const silent = Array.from({ length: SILENT_RUN_ATTENTION }, () => ({ type: "silent" }));
    expect(healthStatus(fold(silent)).code).toBe("no-sound");
    expect(healthStatus(fold(silent.slice(1))).code).toBe("waiting");
  });

  it("recovers as soon as a sound is handled again", () => {
    const silent = Array.from({ length: 5 }, () => ({ type: "silent" }));
    expect(healthStatus(fold([...silent, handled])).code).toBe("working");
  });

  it("a missing or overwritten hook outranks everything", () => {
    const worked = fold([handled]);
    expect(healthStatus(applySignal(worked, { type: "hook", state: "missing" }, 5))).toEqual({
      code: "hook-missing",
      level: "bad",
    });
    expect(healthStatus(applySignal(worked, { type: "hook", state: "overwritten" }, 5)).code).toBe(
      "hook-overwritten"
    );
    expect(healthStatus(applySignal(worked, { type: "hook", state: "ok" }, 5)).code).toBe(
      "working"
    );
  });
});

describe("buildDiagnostics", () => {
  const state = {
    settings: { enabled: true, showPopups: false, defaultSoundId: "s1" },
    rules: [{ match: "Radwa Secret Name", chatId: "601@lid" }],
    sounds: { s1: { name: "private-ringtone.mp3" } },
  };

  it("reports versions, counts and shapes", () => {
    const health = fold(
      [
        { type: "notification", tag: "1@lid" },
        { type: "paired", url: "https://static.whatsapp.net/a/b.mp3", detached: true },
      ],
      undefined,
      4_000
    );
    const report = buildDiagnostics({
      version: "3.0",
      userAgent: "UA",
      health,
      state,
      now: 10_000,
    });
    expect(report).toMatchObject({
      extension: "3.0",
      browser: "UA",
      status: "working",
      counts: { notifications: 1, soundsHandled: 1 },
      secondsSince: { notification: 6, soundHandled: 6, silentNotification: null },
      setup: { enabled: true, showPopups: false, hasDefaultSound: true, rules: 1, sounds: 1 },
    });
    expect(report.whatsappShapes.sound.host).toBe("static.whatsapp.net");
  });

  it("contains no chat names, ids, sound names or URLs", () => {
    const health = fold([
      { type: "notification", tag: "601@lid" },
      { type: "paired", url: "https://static.whatsapp.net/rsrc.php/private/path.mp3?token=abc" },
    ]);
    const text = JSON.stringify(buildDiagnostics({ health, state, now: 5_000 }));
    for (const secret of ["Radwa", "601", "private", "ringtone", "token", "rsrc.php"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("copes with missing inputs", () => {
    expect(buildDiagnostics({ now: 1 })).toMatchObject({
      extension: "unknown",
      browser: "unknown",
      status: "waiting",
      setup: { rules: 0, sounds: 0 },
    });
  });
});
