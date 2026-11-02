# Browser and OS support

The extension is plain web-extension code: it never touches the operating system, so the OS makes
no difference. What differs is the browser, and the build handles that with one manifest per
engine. **The code is byte-identical for every browser** (a test enforces it); only the manifest
changes.

## Status, honestly

| Browser                                    | Build target  | Built | Automated checks                                  | Verified in the real browser                         |
| ------------------------------------------ | ------------- | ----- | ------------------------------------------------- | ---------------------------------------------------- |
| Chrome, Edge, Brave, Opera, Vivaldi (111+) | `dist/chromium` | yes | unit + integration tests, manifest checks         | **Edge 155 on Windows 11** (owner, Oct 2026)         |
| Firefox 140+ (desktop)                     | `dist/firefox`  | yes | same tests, plus `web-ext lint`: 0 errors/warnings | **Firefox 158 on Windows 11** (owner, Oct 2026)      |

**Firefox for Android (142+): supported, not yet verified.** The same `dist/firefox` build
installs there. Two things come from Android, not the extension:

- WhatsApp Web sends phone browsers to the app; turn on Firefox's **Desktop site** for
  web.whatsapp.com, and link it with **Link with phone number** (the QR code cannot be scanned from
  the same phone).
- Android pauses background tabs, so sounds are replaced while the WhatsApp tab is open on screen;
  with Firefox in the background, Android may deliver nothing to the page.

On Android the popup opens as a full page that fills the screen, and **Upload sound** opens the
upload page in a tab (Android has no windows API; if it cannot open a tab either, it uses the
inline file picker).

Operating systems: Windows is verified by hand. Windows and Linux are covered by the CI matrix in
`.github/workflows/ci.yml` (it hasn't run on GitHub yet, because nothing is pushed). macOS and
Safari aren't supported.

"Built" means the package is produced and passes the checks above. It does **not** mean it has been
seen working. The unverified rows are the ones to test first.

## Build

```bash
npm install
npm run build        # dist/chromium, dist/firefox
npm run lint:firefox # web-ext lint on the Firefox build
npm run package      # dist/packages/*.zip, one per browser, for the stores
```

## Load it yourself

- **Chrome / Edge / Brave / Opera / Vivaldi:** open the extensions page (`chrome://extensions`,
  `edge://extensions`, ...), turn on Developer mode, **Load unpacked**, choose `dist/chromium`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, **Load Temporary Add-on**, choose
  `dist/firefox/manifest.json`. (Temporary add-ons are removed when Firefox closes. A permanent
  install needs the signed package from addons.mozilla.org.)

## What differs between browsers

| Topic                  | Chromium                              | Firefox                                              |
| ---------------------- | ------------------------------------- | ---------------------------------------------------- |
| Background             | service worker                        | non-persistent event page (same `background.js`)     |
| Add-on id              | none needed                           | `whatsapp-sound-changer@kareemsayed1232.github.io`   |
| Minimum version        | Chrome 111 (page-world scripts)       | 140 (page-world scripts need 128; data-collection key needs 140) |
| `author` key           | none (support is via GitHub issues)   | none                                                 |
| Data collection        | n/a                                   | declares `none`                                      |

## Known limits

- The extension only reads WhatsApp's own markup to list your chats. It is not a public API and can
  change, in which case "Refresh chat list" says it could not read the list and "add a chat by name"
  still works.
- Sound replacement relies on WhatsApp playing its message sound as `static.whatsapp.net/...mp3`,
  and on WhatsApp calling `new Notification(...)` (measured October 2026).
- A browser may need one click inside the WhatsApp page before it lets any page play audio.

## Publishing

Each store takes the matching zip from `dist/packages`:

- Edge Add-ons, and a GitHub Release for Chrome, Brave, Opera and Vivaldi: `...-chromium.zip`
- addons.mozilla.org: `...-firefox.zip`. Mozilla asks for the source of anything that is bundled:
  submit this repository, with these build commands.

Step-by-step instructions, listing text and reviewer notes are in [STORES.md](STORES.md). Keep the
GPLv3 licence and the credit to the original project.

## If WhatsApp Web moves to another address

The address is defined in one place, `WHATSAPP_ORIGIN` / `WHATSAPP_MATCH` in
`src/core/protocol.mjs`, plus the three `matches` / `host_permissions` entries in
`src/manifest.json` (a manifest cannot import code). A test fails if the two disagree. Change both,
rebuild, and publish an update: browsers ask users to approve a new site permission, so an address
move always needs a new version.
