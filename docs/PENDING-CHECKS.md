# Checks still to do on real devices

Everything here is built and covered by automated tests, but has not yet been tried on the real
device or browser. Tick items off as they are checked.

## Firefox for Android (142+)

What should happen: the extension installs, sounds are replaced while the WhatsApp tab is open on
screen, the popup page fills the phone's width, and **Upload sound** opens in a new tab.

Known Android limits (not the extension): WhatsApp Web needs Firefox's **Desktop site** on a phone,
and Android pauses background tabs, so with Firefox in the background there may be no sound to
replace.

### Install a test build on the phone

1. Phone: Settings → About phone → tap **Build number** 7 times (Developer options). Then
   Settings → Developer options → turn on **USB debugging**.
2. Firefox on the phone: Settings → turn on **Remote debugging via USB**.
3. PC: install Google's **Android platform-tools** (includes `adb`), connect the phone by USB and
   accept the prompt on the phone.
4. PC, in the project folder:

   ```bash
   npm run build
   npx web-ext run --source-dir dist/firefox --target firefox-android --firefox-apk org.mozilla.firefox
   ```

   If several devices are listed, add `--android-device <id>`.

### Check

- [ ] Open `web.whatsapp.com`, menu (⋮) → **Desktop site**, link with **Link with phone number**.
- [ ] Tap once inside WhatsApp (Android blocks sound until a tap) and keep it on screen.
- [ ] A chat with its own sound messages you: that sound plays, once.
- [ ] A muted chat messages you: silence.
- [ ] Menu (⋮) → Extensions → WhatsApp Sound Changer: the page fits the screen (no sideways scroll).
- [ ] **Upload sound** on a chat opens the upload page in a new tab; the chosen file is assigned.
- [ ] Optional: switch to another app, have someone message you, note whether any sound plays
      (expected: maybe not, Android pauses the tab).

## Safari (macOS)

Needs a Mac with Xcode.

- [ ] `xcrun safari-web-extension-converter dist/safari`, open the project in Xcode, run it, enable
      the extension in Safari's settings.
- [ ] Open WhatsApp Web: the popup's status line must say **Working** after a message, not
      "Can't reach the WhatsApp page". If it says the latter, the page-world hook does not run on
      this Safari version and the minimum version in `scripts/build.mjs` must be raised.
- [ ] Repeat the per-chat sound, muted chat and focused checks below.

## Edge and Firefox on Windows (regression after each phase)

- [ ] Background: a chat with its own sound plays it; a muted chat is silent.
- [ ] Focused (another chat open): the chat's sound, else the default, else WhatsApp's ding; one
      sound only.
- [ ] Two chats with the same name show as two rows once each has messaged in the background.
- [ ] **Upload sound**: Firefox opens the small window, Edge the inline picker.
- [ ] Settings → **Copy diagnostics**: `status` is `working`, `chatList` says `builtin`.

## macOS and Linux

- [ ] Push the branch so the GitHub Actions matrix (Windows, macOS, Linux × Node 20/22) runs.
