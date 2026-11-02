// "Run a self-test" (Settings → Troubleshooting), run inside the WhatsApp tab: is every piece the
// extension relies on still in place on today's WhatsApp? Nothing can check this automatically,
// because it needs the user's logged-in WhatsApp. Results hold counts and layer names, never a
// chat name.

/** One check; a check that throws fails instead of stopping the others. */
function check(id, fn) {
  try {
    const { ok, detail } = fn();
    return { id, ok: Boolean(ok), detail: String(detail ?? "") };
  } catch (error) {
    return { id, ok: false, detail: `error: ${error?.message ?? "unknown"}` };
  }
}

/**
 * `hookState()` pings the page hook ("ok", "missing", "overwritten"); `readChats` and `layers`
 * come from the chat-list collector (Refresh chat list only); `canPlay()` from the audio engine.
 */
export function runSelfTest({ hookState, settings, readChats, layers, canPlay }) {
  let chats = null;
  let layerNames = null;
  const readList = () => {
    if (chats === null) chats = readChats();
    return chats;
  };
  const readLayers = () => {
    if (layerNames === null) layerNames = layers?.() ?? {};
    return layerNames;
  };

  return [
    check("hook", () => {
      const state = hookState();
      return { ok: state === "ok", detail: state };
    }),
    check("enabled", () => ({
      ok: settings?.enabled === true,
      detail: settings?.enabled === true ? "on" : "off",
    })),
    check("chat-list", () => {
      const size = readList().size;
      return { ok: size > 0, detail: `${size} chats (${readLayers().list ?? "unknown"})` };
    }),
    check("sound", () => {
      const ok = canPlay();
      return { ok, detail: ok ? "ready" : "not handed to WhatsApp yet: reload the WhatsApp tab" };
    }),
  ];
}
