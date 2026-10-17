const DB_NAME = "wansc";
const STORE = "sounds";

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/**
 * Sound bytes live in IndexedDB (not chrome.storage.local, which is capped at 10 MB).
 * Records are { mime, data: ArrayBuffer } rather than Blobs: plain buffers clone reliably in
 * every browser's IndexedDB.
 */
export function createSoundStore(idbFactory = globalThis.indexedDB) {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = idbFactory.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };
        request.onerror = () => {
          dbPromise = null;
          reject(request.error);
        };
      });
    }
    return dbPromise;
  }

  async function run(mode, work) {
    const db = await open();
    const tx = db.transaction(STORE, mode);
    const result = work(tx.objectStore(STORE));
    const value = await requestToPromise(result);
    if (mode === "readwrite") await transactionDone(tx);
    return value;
  }

  return {
    put: (id, record) => run("readwrite", (store) => store.put(record, id)),
    get: async (id) => (await run("readonly", (store) => store.get(id))) ?? null,
    delete: (id) => run("readwrite", (store) => store.delete(id)),
    ids: () => run("readonly", (store) => store.getAllKeys()),
  };
}
