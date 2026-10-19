# TDD evidence: the same focused-mode sound on every browser

**Why:** owner's requirement: "match the behavior everywhere", tested on Edge and Firefox for now.
Measured: with WhatsApp focused, Edge's WhatsApp plays its own sound (no notification, so no chat is
known: the extension could only play the default sound); Firefox's WhatsApp plays nothing (the
extension played the chat's sound, but nothing for chats without one).

**Rule now (all browsers), focused, message in another chat:** the chat's sound, else the default
sound, else WhatsApp's own ding. Muted and silent chats stay silent. Background is unchanged.

| Part | What changed |
| ---- | ------------ |
| `main-hook.mjs` | Plays WhatsApp's own ding on request (`EVENT_PLAY_NATIVE`), through the original `play()` so our hook does not step in; uses the sound WhatsApp last played (remembered under `wanscSoundUrl`, WhatsApp hosts only), else the known file. |
| `bridge.mjs` | While focused (and only when our audio can start), WhatsApp's own sound is **held**; the chat found from its unread counter decides what plays, at once. If no chat turns up within 1.5 s (e.g. the message is in the open chat), what was held plays. Without a held sound (Firefox), the same chat decision plays after the usual short wait. "WhatsApp's own sound" decisions now play the ding instead of nothing. |

```text
npx vitest run tests/unit/same-everywhere.test.js   # RED: 11 failed | 6 passed (17)
npx vitest run tests/unit/same-everywhere.test.js   # GREEN: 17 passed
npx vitest run                                      # 696 passed
npm run lint && npm run build && npm run lint:firefox   # clean, 0 errors / 0 warnings
```

## Known gaps

- Not yet checked on real Edge and Firefox.
- In Edge, a focused message in the chat you have OPEN: WhatsApp plays its sound but no unread
  counter rises, so what was held plays after about 1.5 s (a slight delay).
- Firefox still needs one click in the tab (or Autoplay allowed for WhatsApp) before any sound.
