# Bedtime Story Studio

[Listen to the stories and read the case study](https://cjimenz.github.io/bedtime-story-studio/)

The player streams the full chapters and offers a separate MP3 download for each episode.

## Add an episode

1. Put the finished MP3 in `docs/audio/` with a stable filename.
2. Append an object to [`docs/episodes.json`](docs/episodes.json) with a unique `id`, a `label`, a `title`, a whole-number `durationSeconds`, and a `src` such as `audio/chapter-10.mp3`. The player displays entries in catalog order.
3. Commit the MP3 and catalog entry together on `main`. GitHub Pages publishes `main:/docs`.

The catalog is the interface for the generation pipeline. The player loads it at runtime.
