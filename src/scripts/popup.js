const audioElement = document.getElementById("audioElement");
const audioFileUpload = document.getElementById("audioFileUpload");
const message = document.getElementById("message");
const stopSoundButton = document.getElementById("stopSoundButton");

stopSoundButton.addEventListener("click", () => {
  // Stop sample audio player
  audioElement.pause();
  audioElement.currentTime = 0;
  // Send runtime message to stop injected audio
  chrome.runtime.sendMessage({ title: "WANSC-Stop-Sound" });
});

audioFileUpload.addEventListener("change", handleAudioUpload);

async function handleAudioUpload() {
  try {
    const file = audioFileUpload.files[0];
    const reader = new FileReader();
    reader.onload = function (e) {
      const audioDataURL = e.target.result;
      chrome.storage.local.set({ uploadedAudio: audioDataURL },
        function () {
          message.innerText = "Successfully uploaded file. Please refresh the page to activate the custom sound.";
          loadCurrentAudio();
        }
      );
    };
    reader.readAsDataURL(file);
  }
  catch (e) {
    message.innerText = e.message;
  }
}

async function loadCurrentAudio() {
  chrome.storage.local.get(["uploadedAudio"], function (result) {
    if (result.uploadedAudio) {
      const audioSource = document.createElement("source");
      audioSource.setAttribute("src", result.uploadedAudio);
      audioElement.innerHTML = "";
      audioElement.appendChild(audioSource);
      audioElement.load();
      generateDeleteButton();
      stopSoundButton.style.display = "";
    }
  });
}

function generateDeleteButton() {
  if (document.getElementById("deleteSoundButton")) document.getElementById("deleteSoundButton").remove();
  const delButton = document.createElement("button");
  delButton.innerHTML = `<i class="bi bi-trash"></i> Remove custom sound`;
  delButton.id = "deleteSoundButton";
  delButton.classList.add("deleteSoundButton");
  delButton.addEventListener("click", doDelete);
  const buttonsContainer = document.getElementById("buttonsContainer");
  buttonsContainer.prepend(delButton);
}

function doDelete() {
  chrome.storage.local.remove("uploadedAudio");
  audioElement.innerHTML = "";
  audioElement.load();
  document.getElementById("deleteSoundButton").remove();
  stopSoundButton.style.display = "none";
  message.innerText = "Custom sound removed. Please refresh the page to complete the removal.";
}

loadCurrentAudio();