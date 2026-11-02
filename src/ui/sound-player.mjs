/** Plays a stored sound for preview. Extension pages are not bound by WhatsApp's CSP. */
export function createSoundPlayer({ soundStore, window }) {
  let audio = null;
  let url = null;
  let playingId = null;

  function stop() {
    if (audio) audio.pause();
    if (url) window.URL.revokeObjectURL(url);
    audio = null;
    url = null;
    playingId = null;
  }

  /** Play a sound from the start, stopping any other. */
  async function play(soundId) {
    stop();
    const record = await soundStore.get(soundId);
    if (!record) return;
    url = window.URL.createObjectURL(new window.Blob([record.data], { type: record.mime }));
    audio = new window.Audio(url);
    playingId = soundId;
    audio.addEventListener("ended", stop);
    await audio.play().catch(stop);
  }

  return {
    stop,
    play,
    /** Play a sound, or stop it if it is the one already playing. */
    async toggle(soundId) {
      if (playingId === soundId) return stop();
      return play(soundId);
    },
  };
}
