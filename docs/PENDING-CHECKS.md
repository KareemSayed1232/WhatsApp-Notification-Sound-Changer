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
- [ ] Menu (⋮) → Extensions → Sound Changer for WhatsApp: the page fits the screen (no sideways scroll).
- [ ] **Upload sound** on a chat opens the upload page in a new tab; the chosen file is assigned.
- [ ] Optional: switch to another app, have someone message you, note whether any sound plays
      (expected: maybe not, Android pauses the tab).

## Edge and Firefox on Windows (regression after each phase)

- [x] Background: a chat with its own sound plays it **once**; a muted chat is silent; an @mention
      in a muted group plays as WhatsApp would (checked 2 Nov 2026, Edge).
- [x] Focused on another chat: WhatsApp plays nothing, so neither does the extension (WhatsApp's
      own behaviour).
- [x] WhatsApp's notifications turned off: the status line says "plays message sounds but not
      sending notifications".
- [ ] Two chats with the same name show as two rows once each has messaged in the background.
- [ ] A chat added by name shows "Waiting for first message", then "Linked ✓" after it messages.
- [ ] **Upload sound**: Firefox opens the small window, Edge the inline picker.
- [ ] Uploading a sound in Settings does **not** make it the default.
- [ ] Settings → **Troubleshooting** → **Copy diagnostics**: `status` is `working`.
- [ ] New install (no sounds, no rules): the popup shows the three **Get started** steps; they hide
      once a chat has a sound or a default sound is set.
- [ ] **Play** on a chat row plays that chat's sound (or the default); it is greyed out for Silent.
- [ ] Uploading the same file twice: "was already added", and Settings lists it once.
- [ ] Firefox: after reloading WhatsApp, click once in the tab; then a chat's sound plays.
- [ ] Settings → Troubleshooting → **Run a self-test** with WhatsApp open: every line ✓.
- [ ] **Copy page layout**: paste it somewhere and check it contains no chat names or messages.
- [ ] Background for 10+ minutes (Edge slows background tabs): messages still play their sound.
- [ ] Settings footer: "Not affiliated with WhatsApp or Meta" and **Report a problem** opens the
      GitHub issues page.

## CI

- [ ] Push and open a pull request so the GitHub Actions matrix (Windows, Linux × Node 20/22) runs.
