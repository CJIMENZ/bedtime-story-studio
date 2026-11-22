"use strict";

const audio = document.querySelector("#audio");
const download = document.querySelector("#download");
const episodeList = document.querySelector("#episodes");
const label = document.querySelector("#current-label");
const title = document.querySelector("#current-title");
const status = document.querySelector("#status");

function showEpisode(episode, button, play) {
  episodeList.querySelector("[aria-current]")?.removeAttribute("aria-current");
  button.setAttribute("aria-current", "true");
  label.textContent = episode.label;
  title.textContent = episode.title;
  audio.setAttribute("aria-label", episode.title);
  status.textContent = "";
  const source = new URL(episode.src, document.baseURI).href;
  if (audio.src !== source) audio.src = source;
  download.href = source;
  download.download = episode.id + ".mp3";
  download.hidden = false;
  if (play) {
    audio.play().catch((error) => {
      if (error.name !== "AbortError" && audio.src === source) {
        status.textContent = "Playback couldn’t start. Try Play again or download the MP3.";
      }
    });
  }
}

audio.addEventListener("error", () => {
  status.textContent = "This recording couldn’t load. Try downloading the MP3.";
});

async function loadEpisodes() {
  const response = await fetch("episodes.json");
  if (!response.ok) throw new Error("Catalog request failed");
  const episodes = await response.json();
  episodes.forEach((episode, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "episode";
    button.type = "button";
    const kind = document.createElement("small");
    kind.textContent = episode.label;
    const name = document.createElement("strong");
    name.textContent = episode.title;
    const duration = document.createElement("span");
    duration.className = "duration";
    duration.textContent = Math.floor(episode.durationSeconds / 60) + ":" +
      String(episode.durationSeconds % 60).padStart(2, "0");
    button.append(kind, name, duration);
    button.addEventListener("click", () => showEpisode(episode, button, true));
    item.append(button);
    episodeList.append(item);
    if (index === 0) showEpisode(episode, button, false);
  });
}

loadEpisodes().catch(() => {
  status.textContent = "The episode list couldn’t load. Refresh this page to try again.";
});
