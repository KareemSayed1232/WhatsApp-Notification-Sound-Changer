import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAudioEngine } from "../../src/content/audio-engine.mjs";

let contexts;
let sources;

class FakeSource {
  constructor() {
    this.connect = vi.fn();
    this.start = vi.fn();
    this.stop = vi.fn();
    this.buffer = null;
    this.onended = null;
    sources.push(this);
  }
}

class FakeContext {
  constructor() {
    this.state = FakeContext.initialState;
    this.destination = { name: "destination" };
    this.decodeCalls = [];
    this.gains = [];
    this.resume = vi.fn(() => {
      if (FakeContext.resumable) this.state = "running";
      return FakeContext.resumable ? Promise.resolve() : new Promise(() => {});
    });
    contexts.push(this);
  }
  decodeAudioData(arrayBuffer) {
    this.decodeCalls.push(arrayBuffer);
    if (FakeContext.decodeFails) return Promise.reject(new Error("bad audio"));
    return Promise.resolve({ decoded: arrayBuffer.byteLength });
  }
  createBufferSource() {
    return new FakeSource();
  }
  createGain() {
    const gain = { gain: { value: 1 }, connect: vi.fn() };
    this.gains.push(gain);
    return gain;
  }
}

const bytes = () => new Uint8Array([1, 2, 3, 4]);
const instantDelay = () => Promise.resolve();

let loadSound;
let onError;
let engine;

beforeEach(() => {
  contexts = [];
  sources = [];
  FakeContext.initialState = "running";
  FakeContext.resumable = true;
  FakeContext.decodeFails = false;
  loadSound = vi.fn(async () => ({ mime: "audio/mpeg", bytes: bytes() }));
  onError = vi.fn();
  engine = createAudioEngine({
    AudioContextCtor: FakeContext,
    loadSound,
    onError,
    delay: instantDelay,
  });
});

describe("audio engine", () => {
  it("decodes the sound and plays it at the requested volume", async () => {
    await expect(engine.play("s1", 0.4)).resolves.toBe(true);
    expect(sources[0].start).toHaveBeenCalledTimes(1);
    expect(sources[0].buffer).toEqual({ decoded: 4 });
    expect(contexts[0].gains[0].gain.value).toBe(0.4);
    expect(sources[0].connect).toHaveBeenCalledWith(contexts[0].gains[0]);
    expect(contexts[0].gains[0].connect).toHaveBeenCalledWith(contexts[0].destination);
  });

  it("clamps out-of-range volume", async () => {
    await engine.play("s1", 9);
    expect(contexts[0].gains[0].gain.value).toBe(1);
  });

  it("decodes each sound once and reuses it", async () => {
    await engine.play("s1");
    await engine.play("s1");
    expect(loadSound).toHaveBeenCalledTimes(1);
    expect(contexts[0].decodeCalls).toHaveLength(1);
    expect(sources).toHaveLength(2);
  });

  it("hands the decoder a copy so the cached bytes are never detached", async () => {
    const original = bytes();
    loadSound.mockResolvedValue({ mime: "audio/mpeg", bytes: original });
    await engine.play("s1");
    expect(contexts[0].decodeCalls[0]).not.toBe(original.buffer);
    expect([...original]).toEqual([1, 2, 3, 4]);
  });

  it("stops the previous sound when a new one starts", async () => {
    await engine.play("s1");
    await engine.play("s2");
    expect(sources[0].stop).toHaveBeenCalledTimes(1);
    expect(sources[1].stop).not.toHaveBeenCalled();
  });

  it("reports and returns false when the sound cannot be loaded", async () => {
    loadSound.mockResolvedValue(null);
    await expect(engine.play("gone")).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/gone/) })
    );
    expect(sources).toHaveLength(0);
  });

  it("does not cache a decode failure, so a later attempt can succeed", async () => {
    FakeContext.decodeFails = true;
    await expect(engine.play("s1")).resolves.toBe(false);
    FakeContext.decodeFails = false;
    await expect(engine.play("s1")).resolves.toBe(true);
  });

  it("reloads a sound after invalidate", async () => {
    await engine.play("s1");
    engine.invalidate("s1");
    await engine.play("s1");
    expect(loadSound).toHaveBeenCalledTimes(2);
  });

  it("invalidate with no argument clears everything", async () => {
    await engine.play("s1");
    await engine.play("s2");
    engine.invalidate();
    await engine.play("s1");
    await engine.play("s2");
    expect(loadSound).toHaveBeenCalledTimes(4);
  });

  it("resumes a suspended context before playing", async () => {
    FakeContext.initialState = "suspended";
    await expect(engine.play("s1")).resolves.toBe(true);
    expect(contexts[0].resume).toHaveBeenCalled();
  });

  it("gives up with a clear error when the browser keeps audio blocked", async () => {
    FakeContext.initialState = "suspended";
    FakeContext.resumable = false;
    await expect(engine.play("s1")).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/interact/) })
    );
    expect(sources).toHaveLength(0);
  });

  it("armUnlock resumes the context on the first user gesture, once", () => {
    FakeContext.initialState = "suspended";
    const target = new EventTarget();
    engine.armUnlock(target);
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("keydown"));
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resume).toHaveBeenCalledTimes(1);
  });
});
