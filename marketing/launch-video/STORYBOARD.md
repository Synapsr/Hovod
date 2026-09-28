# Hovod — launch film · storyboard

**Format** 1920×1080 · 60 fps · 64 s · stereo 48 kHz · two cuts from one composition: `en` and `fr`.
**Music** 120 BPM (one beat = 0.5 s, one bar = 2 s). Every section starts on a beat, almost all on a bar line; every hit is on the grid.
**Promise** *The video platform that belongs to you.* / *La plateforme vidéo qui vous appartient.*
**Story** They own your video → you get it back. The hook's "their rules" is answered at 0:50 by "your rules".

Built the Null Motion way: every section was first written as a flat black-and-white HyperFrames draft
(one idea, one move), then polished in the Hovod identity. Copy comes from hovod.dev and the README, never
invented features.

## Identity

| Token | Value | From |
|---|---|---|
| Background | `#09090b` + 80 px grid at 3.5 % + grain | hovod.dev, og-image |
| Brand | indigo `#6366f1`, logo tile radius 25 % with the white play triangle | favicon.svg, dashboard sidebar |
| Gradient text | `#818cf8 → #a78bfa → #c084fc` | `.gradient-text` on hovod.dev |
| Panels | zinc-900 `#18181b`, border zinc-800 `#27272a`, radius 16–24 px | dashboard |
| Statuses | queued amber `#fbbf24`, processing blue `#60a5fa`, ready emerald `#34d399` | `STATUS_CFG` |
| Type | Inter (optical size axis) 600–700, tracking −4 %; JetBrains Mono for labels and code | — |

## Beat sheet

| # | Time | Section | On screen (EN) | À l'écran (FR) | Motion | Sound |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:04 | Hook | *Your videos. / Their platform. / Their rules.* | *Vos vidéos. / Leur plateforme. / Leurs règles.* | One line at a time, masked rise; "Their" in red, the grid tightens | Low pulses, one tick per word |
| 2 | 0:04–0:10 | Pain | Invoice of a managed platform: encoding and streaming *per minute*, transcription / subtitles / analytics *add-on*, "your audience data: theirs", a total that never stops. **Death by add-ons.** | Facture d'une plateforme gérée : encodage et diffusion *à la minute*, transcription / sous-titres / stats *en option*, « données de votre audience : les leurs ». **Mort par options.** | Lines print like a receipt, counter rolls, everything implodes into one point | Receipt ticks, riser, half-beat of silence |
| 3 | 0:10–0:16 | Reveal | Logo + **Hovod** · *The video platform that belongs to you.* · Open source · Self-hosted · AI-powered | Logo + **Hovod** · *La plateforme vidéo qui vous appartient.* · Open source · Auto-hébergée · Propulsée par l'IA | The point bursts into the logo tile, glint, wordmark, gradient on the promise | **Drop** |
| 4 | 0:16–0:20 | 01 · Upload | *Drop in any video.* Dashboard, REST API or URL import. Resumable multipart. | *Déposez n'importe quelle vidéo.* Dashboard, API REST ou import par URL. Multipart reprenable. | The logo tile flies into the dashboard's sidebar (match cut); a 4K file lands, 16 MB parts upload three at a time | Whoosh, drop, part blips |
| 5 | 0:20–0:25 | 02 · Transcode | *Adaptive HLS, up to 8K.* H.264 · AAC · 6 s segments · HDR tone-mapped | *HLS adaptatif, jusqu'à la 8K.* H.264 · AAC · segments de 6 s · HDR → SDR | Uploaded → Queued → Processing; seven renditions grow 360p → 4320p with their real bitrates, segments stream into S3 | One note per rung |
| 6 | 0:25–0:30 | 03 · Stream | *Straight from your storage.* Playback never touches the API. | *Directement depuis votre stockage.* La lecture ne passe jamais par l'API. | Ready; the card morphs into the Hovod player (quality 4K, chapters on the scrubber) | Click, groove opens |
| 7 | 0:30–0:36 | AI | *AI, on your terms.* Transcripts, subtitles, chapters — any Whisper-compatible endpoint, even 100 % local. | *L'IA, à vos conditions.* Transcription, sous-titres, chapitres — tout endpoint compatible Whisper, même 100 % local. | Waveform → words light up → subtitle in the player → chapters stack | Sparkles |
| 8 | 0:36–0:40 | Share | *Embed anywhere. In one line.* Share pages, timestamped comments, reactions. | *Intégrez partout. En une ligne.* Pages de partage, commentaires horodatés, réactions. | `<iframe>` types itself, the player drops into a page, comments pop | Typing, pops |
| 9 | 0:40–0:44 | Analytics | *Analytics. Zero trackers.* No cookies, no third parties. | *Des stats. Zéro traqueur.* Sans cookies, sans tiers. | Views / unique viewers / watch time / completion count up, retention curve draws | Tick run |
| 10 | 0:44–0:50 | Deploy | *One command. Live in a minute.* `docker run … synapsr/hovod` · AWS S3 · Cloudflare R2 · Backblaze B2 · MinIO · DigitalOcean Spaces | *Une commande. En ligne en une minute.* | Terminal types, boot log checks off MariaDB, Redis, migrations, worker, API; storage chips slide in | Keys, confirms, snare build |
| 11 | 0:50–0:54 | Sovereignty | ***Your servers. Your rules.*** 100 % of your data stays on your infrastructure. GDPR by design · Your jurisdiction · No lock-in | ***Vos serveurs. Vos règles.*** 100 % de vos données restent sur votre infrastructure. | Kinetic headline answering the hook | **Second drop** |
| 12 | 0:54–0:58 | Offer | *Same code. Your call.* Self-hosted: free forever, unlimited, MIT · Hovod Cloud: from $29/mo, zero ops | *Le même code. À vous de choisir.* Auto-hébergé : gratuit pour toujours · Hovod Cloud : dès 29 € HT/mois | Two cards split from the centre | Two whooshes |
| 13 | 0:58–1:04 | End card | Logo · promise · **hovod.dev** · `docker run synapsr/hovod` · github.com/Synapsr/Hovod · created by Synapsr | idem, FR | Cards collapse into the lockup, one glint, hold | Final hit, reverb tail |
