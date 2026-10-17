/** In-memory stand-in for chrome.storage.local (promise API), with call counters for assertions. */
export function createFakeStorage(initial = {}) {
  const data = { ...initial };
  const calls = { get: 0, set: 0, remove: 0 };

  return {
    data,
    calls,
    async get(keys) {
      calls.get++;
      const wanted = keys == null ? Object.keys(data) : [].concat(keys);
      const out = {};
      for (const key of wanted) if (key in data) out[key] = structuredClone(data[key]);
      return out;
    },
    async set(items) {
      calls.set++;
      for (const [key, value] of Object.entries(items)) data[key] = structuredClone(value);
    },
    async remove(keys) {
      calls.remove++;
      for (const key of [].concat(keys)) delete data[key];
    },
  };
}

/** In-memory stand-in for the IndexedDB sound store (same interface as createSoundStore). */
export function createFakeSoundStore() {
  const blobs = new Map();
  return {
    blobs,
    failNextPut: false,
    async put(id, record) {
      if (this.failNextPut) {
        this.failNextPut = false;
        throw new Error("disk full");
      }
      blobs.set(id, record);
    },
    async get(id) {
      return blobs.get(id) ?? null;
    },
    async delete(id) {
      blobs.delete(id);
    },
    async ids() {
      return [...blobs.keys()];
    },
  };
}
