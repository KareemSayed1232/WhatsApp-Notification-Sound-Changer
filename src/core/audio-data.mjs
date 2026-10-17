const DATA_URL = /^data:([^;,]+)((?:;[^;,]+)*);base64,([A-Za-z0-9+/]*={0,2})$/;
const CHUNK = 0x8000;

/** Decode a base64 `data:` URL. Returns { mime, bytes } or null if it is not a valid one. */
export function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const match = DATA_URL.exec(dataUrl);
  if (!match) return null;
  try {
    const binary = globalThis.atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime: match[1], bytes };
  } catch {
    return null;
  }
}

export function bytesToDataUrl(mime, bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${globalThis.btoa(binary)}`;
}
