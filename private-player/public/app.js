const $ = id => document.getElementById(id);
const gate = $("gate"), library = $("library");
const audio = $("audio"), chapterList = $("chapter-list");
let chapters = [], selected = -1;

function notice(id, message) { $(id).textContent = message; }
function showGate() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  chapters = [];
  selected = -1;
  library.hidden = true;
  gate.hidden = false;
  $("logout").hidden = true;
  $("passcode").focus();
}
function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins + ":" + String(secs).padStart(2, "0");
}
function choose(index, play = false) {
  if (index < 0 || index >= chapters.length) return;
  selected = index;
  const chapter = chapters[index];
  $("now-playing").textContent = chapter.title;
  audio.src = "/api/audio/" + encodeURIComponent(chapter.id);
  audio.load();
  $("previous").disabled = index === 0;
  $("next").disabled = index === chapters.length - 1;
  for (const [i, button] of [...chapterList.querySelectorAll("button")].entries())
    button.setAttribute("aria-current", String(i === index));
  notice("player-message", "");
  if (play) audio.play().catch(() => notice("player-message", "Press Play to listen."));
}
function render() {
  chapterList.replaceChildren();
  chapters.forEach((chapter, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chapter";
    button.setAttribute("aria-label", chapter.title + ", " + formatDuration(chapter.durationSeconds));
    const number = document.createElement("span");
    number.className = "chapter-number";
    number.textContent = String(i + 1).padStart(2, "0");
    const title = document.createElement("span");
    title.className = "chapter-title";
    title.textContent = chapter.title;
    const duration = document.createElement("span");
    duration.className = "chapter-duration";
    duration.textContent = formatDuration(chapter.durationSeconds);
    button.append(number, title, duration);
    button.addEventListener("click", () => choose(i, true));
    chapterList.append(button);
  });
  $("count").textContent = chapters.length + (chapters.length === 1 ? " chapter" : " chapters");
  $("now-playing").textContent = chapters.length ? "Select a chapter" : "No private chapters added yet";
  $("previous").disabled = true;
  $("next").disabled = true;
}
async function loadLibrary() {
  try {
    const res = await fetch("/api/chapters", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401) return showGate();
    if (!res.ok) throw Error("Library unavailable");
    const data = await res.json();
    if (!Array.isArray(data.chapters)) throw Error("Invalid library");
    chapters = data.chapters;
    render();
    gate.hidden = true;
    library.hidden = false;
    $("logout").hidden = false;
    return true;
  } catch {
    showGate();
    notice("login-message", "Could not load the private library. Try again.");
    return false;
  }
}
$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const passcode = $("passcode").value;
  notice("login-message", "");
  try {
    const res = await fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ passcode }),
    });
    $("passcode").value = "";
    if (res.status === 429) return notice("login-message", "Too many attempts. Try later.");
    if (!res.ok) return notice("login-message", "Incorrect passcode or sign-in unavailable.");
    await loadLibrary();
  } catch {
    notice("login-message", "Unable to sign in. Check your connection.");
  }
});
$("logout").addEventListener("click", async () => {
  try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); }
  finally { showGate(); }
});
$("previous").addEventListener("click", () => choose(selected - 1));
$("next").addEventListener("click", () => choose(selected + 1));
audio.addEventListener("ended", () => choose(selected + 1, true));
audio.addEventListener("error", () => {
  if (audio.getAttribute("src"))
    notice("player-message", "Could not stream this chapter. Check your session and try again.");
});
void loadLibrary();
