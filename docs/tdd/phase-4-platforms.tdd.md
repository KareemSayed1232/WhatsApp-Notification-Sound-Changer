# TDD evidence: fragility plan, Phase 4 (platforms)

**Source plan:** the fragility audit in the session, items P1, P2, A1 (plan items 12-14).
**Checkpoint commits:** not made for RED/GREEN (the owner commits on request).

## What was done

| Item | Outcome |
| ---- | ------- |
| Popup "Upload sound" without a windows API (Firefox for Android) | Falls back to opening the upload page in a **tab**, and to the **inline file picker** if it cannot open anything; never throws. |
| Firefox for Android target | **Kept and supported** (owner wants it working). Removing it had also made `web-ext lint` warn (the data-collection key needs Android 142). The popup fills a phone's width (touch-only screens; desktop untouched) and Upload uses a tab there. Documented with the Android caveats (Desktop site, background tabs). Not yet verified on a phone. |
| Safari | Marked **unverified** in `docs/BROWSERS.md` (minimum 16.4 not checked against page-world scripts; needs a Mac). |
| WhatsApp moving address | Update path documented in `docs/BROWSERS.md` (one constant + the manifest, kept in step by a test; a move needs a new version). |
| Verified browsers | `docs/BROWSERS.md` now lists Edge 155 and Firefox 158 on Windows 11 as verified by the owner. |

```text
npx vitest run tests/unit/build.test.js tests/unit/popup-ui.test.js   # RED: 3 failed | 62 passed
npx vitest run tests/unit/build.test.js tests/unit/popup-ui.test.js   # GREEN: 65 passed
npm run lint:firefox                                                  # 1 warning after dropping Android -> entry restored
npx vitest run                                                        # 757 passed
npm run lint && npm run build && npm run lint:firefox                 # clean, 0 errors / 0 warnings
```

## Known gaps

- Safari still needs a Mac to verify.
- The tab / inline fallbacks and the phone layout are tested in simulation only; Firefox for Android
  needs a real phone (see docs/BROWSERS.md).
