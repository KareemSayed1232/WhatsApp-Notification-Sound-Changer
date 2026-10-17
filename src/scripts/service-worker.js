function setWhatsAppTabsMuted(muted) {
  chrome.tabs.query({ url: "https://web.whatsapp.com/*" }, function (tabs) {
    for (const tab of tabs) {
      chrome.tabs.update(tab.id, { muted });
    }
  });
}

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.title === "WANSC-Load-Player") {
    if (await chrome.offscreen.hasDocument()) {
      chrome.offscreen.closeDocument();
    }

    setWhatsAppTabsMuted(true);

    await chrome.offscreen.createDocument({
      url: "audio_player/audio_player.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Required for playing back audio while tab is muted"
    });

    await chrome.runtime.sendMessage({
      title: "WANSC-Play-Sound",
      audio: message.audio
    });
  }
  if (message.title === "WANSC-Stop-Sound") {
    chrome.runtime.sendMessage({ title: "WANSC-Stop-Sound" });
  }
  if (message.title === "WANSC-Audio-Ended") {
    setWhatsAppTabsMuted(false);
  }
});