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

- [ ] Background: a chat with its own sound plays it; a muted chat is silent.
- [ ] Focused (another chat open): the chat's sound, else the default, else WhatsApp's ding; one
      sound only.
- [ ] Two chats with the same name show as two rows once each has messaged in the background.
- [ ] **Upload sound**: Firefox opens the small window, Edge the inline picker.
- [ ] Settings → **Troubleshooting** → **Copy diagnostics**: `status` is `working`, `chatList` says `builtin`.
- [ ] New install (no sounds, no rules): the popup shows the three **Get started** steps; they hide
      once a chat has a sound or a default sound is set.
- [ ] **Play** on a chat row plays that chat's sound (or the default); it is greyed out for Silent.
- [ ] Uploading the same file twice: "was already added", and Settings lists it once.
- [ ] Firefox: reload WhatsApp, don't click it, open the popup within a few seconds: "won't play
      sounds until you click once" with **Open WhatsApp**; the button jumps to the tab; after a
      click in WhatsApp the warning goes away.
- [ ] Settings → Troubleshooting → **Run a self-test** with WhatsApp open: every line ✓ (the
      sound line ✗ until you click once in WhatsApp in Firefox).
- [ ] **Copy page layout**: paste it somewhere and check it contains no chat names or messages.
- [ ] Background backup: with the WhatsApp tab in the background, a chat with its own sound plays
      it **once** (not twice). Check the diagnostics: `soundsFromChatList` stays 0 while WhatsApp
      notifies normally.
- [ ] Edge, WhatsApp in the background: several private messages in a row, each plays **one**
      sound. Diagnostics: `secondSoundsStopped` may rise; `soundsFromChatList` stays 0.
- [ ] A private chat you never muted keeps its sound in the focused tab after a few background
      messages (it is no longer learned as muted by mistake).
- [ ] Background for 10+ minutes (Edge slows background tabs): messages still play their sound.
- [ ] Settings footer: "Not affiliated with WhatsApp or Meta" and **Report a problem** opens the
      GitHub issues page.

## CI

- [ ] Push and open a pull request so the GitHub Actions matrix (Windows, Linux × Node 20/22) runs.
