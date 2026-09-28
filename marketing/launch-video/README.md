# Hovod — launch film

A 64-second motion-design film that introduces Hovod, in English and in French, built as code:
one [HyperFrames](https://github.com/heygen-com/hyperframes) composition (HTML + GSAP, rendered
frame by frame in headless Chrome) and one procedural soundtrack (Python), both driven by the same
timeline.

| Cut | File |
|---|---|
| English | `renders/hovod-launch-en.mp4` |
| Français | `renders/hovod-launch-fr.mp4` |

1920×1080 · 60 fps · H.264 + AAC · −14 LUFS. The storyboard and both copy decks are in
[`STORYBOARD.md`](STORYBOARD.md).

## Render

Requirements: Node 22+, FFmpeg/FFprobe on the `PATH`, Chrome or Chromium (HyperFrames downloads its
own with `npx hyperframes browser ensure`, or point `HYPERFRAMES_BROWSER_PATH` at one).

```bash
cd marketing/launch-video
npm run render:en        # renders/hovod-launch-en.mp4
npm run render:fr        # renders/hovod-launch-fr.mp4
npm run preview          # HyperFrames Studio, scrub the timeline in the browser
npm run check            # lint the composition
```

The language is a composition variable (`--variables '{"lang":"fr"}'`); in a plain browser tab,
`index.html?lang=fr` does the same.

`npm run render:making-of` (after `render:en`) renders the making-of in the Null Motion format:
the finished film on top, the seven black-and-white drafts it grew from underneath, a playhead
across them and the section on screen outlined in orange.

## Soundtrack

`audio/soundtrack.m4a` is generated, not recorded: a 120 BPM score (D minor tension in the hook,
the drop on B♭maj9 at 0:10, a house groove through the product tour, a breakdown on the deploy
step, the second drop on "your rules", the end on F maj9) plus every sound effect, placed on the
times the timeline itself recorded.

```bash
npm run audio            # timeline cues -> synthesis -> loudness normalisation
```

`scripts/build-audio.sh` loads the composition in headless Chrome to export the cues
(`audio/cues.json`), runs `audio/soundtrack.py` (numpy + scipy), then normalises to −14 LUFS /
−1.5 dBTP with FFmpeg's two-pass `loudnorm`. Change a timing in `src/film.js`, rebuild the audio,
and the music and effects follow.

## How it is built

```
index.html          composition root: scene layers with data-start / data-duration, fonts, audio
src/copy.js         every on-screen string, en + fr, same shape (from hovod.dev and the README)
src/film.js         the scenes and the one paused GSAP timeline (window.__timelines.main)
src/styles.css      the Hovod identity at 1080p
audio/              soundtrack.py, cues.json, soundtrack.m4a (AAC 256k, −14 LUFS)
assets/             Inter + JetBrains Mono (OFL), GSAP, Synapsr logo
scripts/            export-cues.sh, build-audio.sh
making-of/          drafts → film composition (reads renders/hovod-launch-en.mp4)
```

- **Identity** — the favicon tile and play triangle, indigo `#6366f1`, the `#818cf8 → #c084fc`
  gradient of hovod.dev, zinc panels and the dashboard's status colours. The UI on screen is
  rebuilt from the real dashboard (`apps/dashboard`): sidebar, status badges, 16 MB multipart
  parts, the real rendition ladder and bitrates, `segment_%03d.ts`, `transcript.json`,
  `subtitles.vtt`, `chapters.json`, the analytics tiles and labels of both locales.
- **Motion** — a seek-safe timeline: `fromTo` with explicit start states, counters as proxies whose
  setter writes the DOM, seeded randomness, no CSS animation. Cuts follow one grammar
  ("cut-the-curve": the outgoing piece accelerates out, the incoming one decelerates in, same
  direction), eases stay in the `power3` / `power4` / `expo` family, and the end card holds still.
- **Method** — written the [Null Motion](https://github.com/blixvip/NullMotion) way: each section
  started as a flat draft with one idea and one move, then was polished; the kinetic headlines,
  the glass panels and the chrome glint borrow its vocabulary. None of its code is used.

Fonts: Inter and JetBrains Mono, SIL Open Font License. GSAP: GreenSock standard license.
