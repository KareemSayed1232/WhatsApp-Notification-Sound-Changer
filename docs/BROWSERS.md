# Browser and OS support

The extension is plain web-extension code: it never touches the operating system, so the OS makes
no difference. What differs is the browser, and the build handles that with one manifest per
engine. **The code is byte-identical for every browser** (a test enforces it); only the manifest
changes.

## Status, honestly

| Browser                                    | Build target  | Built | Automated checks                                  | Verified in the real browser                         |
| ------------------------------------------ | ------------- | ----- | ------------------------------------------------- | ---------------------------------------------------- |
| Chrome, Edge, Brave, Opera, Vivaldi (111+) | `dist/chromium` | yes | unit + integration tests, manifest checks         | **Edge 155 on Windows 11** (in use by the author)    |
| Firefox 140+                               | `dist/firefox`  | yes | same tests, plus `web-ext lint`: 0 errors/warnings | **not yet** (needs a Firefox to try it)              |
| Safari 16.4+ (macOS, iOS)                  | `dist/safari`   | yes | manifest checks only                              | **not yet** (needs a Mac and Xcode)                  |

Operating systems: Windows, macOS and Linux are covered by the CI matrix in
`.github/workflows/ci.yml` (it has not run on GitHub yet, because nothing is pushed).

"Built" means the package is produced and passes the checks above. It does **not** mean it has been
seen working. The unverified rows are the ones to test first.

## Build

```bash
npm install
npm run build        # dist/chromium, dist/firefox, dist/safari
npm run lint:firefox # web-ext lint on the Firefox build
npm run package      # dist/packages/*.zip, one per browser, for the stores
```

## Load it yourself

- **Chrome / Edge / Brave / Opera / Vivaldi:** open the extensions page (`chrome://extensions`,
  `edge://extensions`, ...), turn on Developer mode, **Load unpacked**, choose `dist/chromium`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**, choose
  `dist/firefox/manifest.json`. (Temporary add-ons are removed when Firefox closes. A permanent
  install needs the signed package from addons.mozilla.org.)
- **Safari:** on a Mac with Xcode, run `xcrun safari-web-extension-converter dist/safari`, open the
  generated project in Xcode, run it, then enable the extension in Safari's settings. This cannot be
  done from Windows or Linux.

## What differs between browsers

| Topic                  | Chromium                              | Firefox                                              | Safari                                    |
| ---------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| Background             | service worker                        | non-persistent event page (same `background.js`)     | service worker                            |
| Add-on id              | none needed                           | `whatsapp-sound-changer@kareemsayed1232.github.io`   | assigned by the Xcode project             |
| Minimum version        | Chrome 111 (page-world scripts)       | 140 (page-world scripts need 128; data-collection key needs 140) | 16.4              |
| `author` key           | object form                           | removed (Firefox requires a string)                  | removed                                   |
| Data collection        | n/a                                   | declares `none`                                      | n/a                                       |

## Known limits

- The extension only reads WhatsApp's own markup to list your chats. It is not a public API and can
  change, in which case "Refresh chats" says it could not read the list and "add a chat by name"
  still works.
- Sound replacement relies on WhatsApp playing its message sound as `static.whatsapp.net/...mp3`,
  and on WhatsApp calling `new Notification(...)` (measured October 2026).
- A browser may need one click inside the WhatsApp page before it lets any page play audio.

## Publishing

Each store takes the matching zip from `dist/packages`:

- Chrome Web Store, Edge Add-ons, Opera add-ons: `...-chromium.zip`
- addons.mozilla.org: `...-firefox.zip`. Mozilla asks for the source of anything that is bundled:
  submit this repository, with these build commands.
- App Store (Safari): through the Xcode project created by the converter.

Before publishing, replace the original author's contact in `src/manifest.json`, choose your own
Firefox add-on id in `scripts/build.mjs` (`GECKO_ID`), and keep the GPLv3 licence and the upstream
copyright notice.
