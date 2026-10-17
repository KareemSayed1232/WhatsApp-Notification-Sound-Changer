import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createSoundStore } from "../../src/core/sound-store.mjs";

let store;

beforeEach(() => {
  store = createSoundStore(new IDBFactory());
});

describe("sound store (IndexedDB)", () => {
  it("round-trips bytes and mime type", async () => {
    const data = new Uint8Array([1, 2, 3, 4]).buffer;
    await store.put("s1", { mime: "audio/mpeg", data });
    const got = await store.get("s1");
    expect(got.mime).toBe("audio/mpeg");
    expect([...new Uint8Array(got.data)]).toEqual([1, 2, 3, 4]);
  });

  it("returns null for an unknown id", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("overwrites an existing id", async () => {
    await store.put("s1", { mime: "audio/mpeg", data: new Uint8Array([1]).buffer });
    await store.put("s1", { mime: "audio/wav", data: new Uint8Array([2]).buffer });
    expect((await store.get("s1")).mime).toBe("audio/wav");
  });

  it("deletes a sound and tolerates deleting a missing one", async () => {
    await store.put("s1", { mime: "audio/mpeg", data: new Uint8Array([1]).buffer });
    await store.delete("s1");
    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
  });

  it("lists stored ids", async () => {
    await store.put("a", { mime: "audio/mpeg", data: new Uint8Array([1]).buffer });
    await store.put("b", { mime: "audio/mpeg", data: new Uint8Array([1]).buffer });
    expect((await store.ids()).sort()).toEqual(["a", "b"]);
  });

  it("keeps data across separate store instances on the same database", async () => {
    const factory = new IDBFactory();
    await createSoundStore(factory).put("s1", {
      mime: "audio/mpeg",
      data: new Uint8Array([9]).buffer,
    });
    const again = await createSoundStore(factory).get("s1");
    expect([...new Uint8Array(again.data)]).toEqual([9]);
  });
});
