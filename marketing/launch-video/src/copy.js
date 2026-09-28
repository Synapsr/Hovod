// On-screen copy for both cuts. Wording comes from hovod.dev (en + fr locales) and the README.
// Keep the two languages the same shape: every scene reads the same keys.
window.HOVOD_COPY = {
  en: {
    hook: ["Your videos.", "Their platform.", "Their rules."],
    hud: { title: "Launch film", specs: "1920 × 1080 · 60 fps", ladder: "HLS · 360p – 4320p" },

    pain: {
      invoiceTitle: "Invoice",
      invoiceVendor: "Managed video platform",
      lines: [
        ["Encoding", "per minute"],
        ["Streaming", "per minute"],
        ["Transcription", "add-on"],
        ["Subtitles", "add-on"],
        ["Analytics", "add-on"],
        ["Your audience data", "theirs"],
      ],
      total: "Total this month",
      currency: "$",
      headline: "Death by add-ons.",
    },

    reveal: {
      promise: ["The video platform", "that belongs"],
      highlight: "to you.",
      chips: ["Open source", "Self-hosted", "AI-powered"],
    },

    rail: ["Upload", "Transcode", "Stream", "AI", "Share", "Analytics", "Deploy"],

    upload: {
      label: "Upload",
      title: "Drop in any video.",
      sub: "Dashboard, REST API or URL import. Resumable multipart uploads.",
      page: "New video",
      drop: "Drag & drop a video or click to browse",
      file: "valley-4k.mov",
      meta: "3840×2160 · 2.4 GB",
      parts: "Uploading part {done} of {total}",
      crumb: "Videos",
    },

    transcode: {
      label: "Transcode",
      title: "Adaptive HLS, up to 8K.",
      sub: "H.264 · AAC · 6 s segments · HDR tone-mapped",
      ladder: "Rendition ladder",
      segments: "HLS segments",
      renditions: "master.m3u8 · 7 renditions",
      bucket: "s3://your-bucket/playback",
    },

    stream: {
      label: "Stream",
      title: "Straight from your storage.",
      sub: "Playback never touches the API. Your S3 or CDN serves every byte.",
      videoTitle: "Valley at dawn",
      meta: "2160p · 5:18 · HLS",
      source: "Source",
      sourceVal: "cdn.acme.com",
      api: "API bytes",
      apiVal: "0 B",
    },

    ai: {
      label: "AI",
      title: "AI, on your terms.",
      sub: "Transcripts, subtitles and chapters. Any Whisper-compatible endpoint, even 100% local.",
      transcript: "Transcript",
      badge: "Whisper · on your server",
      files: ["transcript.json", "subtitles.vtt", "chapters.json"],
      chapters: "Chapters",
      words: "At dawn, the valley wakes up in silence, long before the first light reaches the river.",
      subtitle: "At dawn, the valley wakes up in silence,",
      chapterList: [["0:00", "Dawn"], ["1:12", "The river"], ["2:48", "Summit"], ["4:05", "Night falls"]],
    },

    share: {
      label: "Share",
      title: "Embed anywhere. In one line.",
      sub: "Share pages, timestamped comments and reactions built in.",
      site: "journal.acme.com/stories/valley",
      siteTitle: "A morning in the valley",
      brand: "Acme Journal",
      nav: ["Stories", "Travel", "About"],
      commentsTitle: "Comments",
      embedCaption: "Embed code",
      comments: [["0:42", "Camille", "That light at 0:42 is unreal."], ["1:15", "Noah", "Finally, our own video stack."]],
    },

    analytics: {
      label: "Analytics",
      title: "Analytics. Zero trackers.",
      sub: "Views, retention, watch time. No cookies, no third parties.",
      page: "Analytics",
      tiles: [["Total Views", 12480, ""], ["Unique viewers", 8902, ""], ["Watch Time", 1204, " h"], ["Completion", 68, "%"]],
      retention: "Viewer retention",
      views: "Views over time",
      thousands: ",",
      deltas: ["+18%", "+12%", "+24%", "+4 pts"],
      ranges: ["7d", "30d", "90d", "All"],
      shield: "No cookies · No trackers",
    },

    deploy: {
      label: "Deploy",
      title: "One command. Live in a minute.",
      sub: "API, worker, dashboard, database and queue in a single image.",
      storage: "Bring your own S3-compatible storage",
      live: "Hovod is live on",
    },

    sovereignty: {
      a: "Your servers.",
      b: "Your rules.",
      stat: "100% of your data stays on your infrastructure.",
      micro: ["GDPR by design", "Your jurisdiction", "No lock-in"],
    },

    offer: {
      title: "Same code. Your call.",
      selfName: "Self-hosted",
      selfPrice: "Free, forever",
      selfPoints: ["Unlimited, no quotas", "MIT licensed", "One Docker image"],
      cloudName: "Hovod Cloud",
      cloudPrice: "From $29",
      cloudPer: "/mo",
      cloudPoints: ["Fully managed", "Streaming & CDN included", "Zero ops"],
    },

    end: {
      promise: "The video platform that belongs to you.",
      star: "Star on GitHub",
      by: "Created by",
    },
  },

  fr: {
    hook: ["Vos vidéos.", "Leur plateforme.", "Leurs règles."],
    hud: { title: "Film de lancement", specs: "1920 × 1080 · 60 i/s", ladder: "HLS · 360p – 4320p" },

    pain: {
      invoiceTitle: "Facture",
      invoiceVendor: "Plateforme vidéo gérée",
      lines: [
        ["Encodage", "à la minute"],
        ["Diffusion", "à la minute"],
        ["Transcription", "en option"],
        ["Sous-titres", "en option"],
        ["Statistiques", "en option"],
        ["Données de votre audience", "les leurs"],
      ],
      total: "Total ce mois-ci",
      currency: "€",
      headline: "Mort par options.",
    },

    reveal: {
      promise: ["La plateforme vidéo", "qui vous"],
      highlight: "appartient.",
      chips: ["Open source", "Auto-hébergée", "Propulsée par l’IA"],
    },

    rail: ["Upload", "Transcodage", "Diffusion", "IA", "Partage", "Stats", "Déploiement"],

    upload: {
      label: "Upload",
      title: "Déposez n’importe quelle vidéo.",
      sub: "Dashboard, API REST ou import par URL. Upload multipart reprenable.",
      page: "Nouvelle vidéo",
      drop: "Glissez-déposez une vidéo ou cliquez pour parcourir",
      file: "vallee-4k.mov",
      meta: "3840×2160 · 2,4 Go",
      parts: "Envoi du segment {done} sur {total}",
      crumb: "Vidéos",
    },

    transcode: {
      label: "Transcodage",
      title: "HLS adaptatif, jusqu’à la 8K.",
      sub: "H.264 · AAC · segments de 6 s · HDR converti en SDR",
      ladder: "Échelle de qualités",
      segments: "Segments HLS",
      renditions: "master.m3u8 · 7 qualités",
      bucket: "s3://votre-bucket/playback",
    },

    stream: {
      label: "Diffusion",
      title: "Directement depuis votre stockage.",
      sub: "La lecture ne passe jamais par l’API. Votre S3 ou CDN sert chaque octet.",
      videoTitle: "La vallée à l’aube",
      meta: "2160p · 5:18 · HLS",
      source: "Source",
      sourceVal: "cdn.acme.fr",
      api: "Octets API",
      apiVal: "0 o",
    },

    ai: {
      label: "IA",
      title: "L’IA, à vos conditions.",
      sub: "Transcription, sous-titres et chapitres. Tout endpoint compatible Whisper, même 100 % local.",
      transcript: "Transcription",
      badge: "Whisper · sur votre serveur",
      files: ["transcript.json", "subtitles.vtt", "chapters.json"],
      chapters: "Chapitres",
      words: "À l’aube, la vallée se réveille en silence, bien avant que la lumière n’atteigne la rivière.",
      subtitle: "À l’aube, la vallée se réveille en silence,",
      chapterList: [["0:00", "L’aube"], ["1:12", "La rivière"], ["2:48", "Le sommet"], ["4:05", "La nuit tombe"]],
    },

    share: {
      label: "Partage",
      title: "Intégrez partout. En une ligne.",
      sub: "Pages de partage, commentaires horodatés et réactions inclus.",
      site: "journal.acme.fr/recits/vallee",
      siteTitle: "Un matin dans la vallée",
      brand: "Acme Journal",
      nav: ["Récits", "Voyage", "À propos"],
      commentsTitle: "Commentaires",
      embedCaption: "Code d’intégration",
      comments: [["0:42", "Camille", "La lumière à 0:42, incroyable."], ["1:15", "Noah", "Enfin notre propre stack vidéo."]],
    },

    analytics: {
      label: "Stats",
      title: "Des stats. Zéro traqueur.",
      sub: "Vues, rétention, temps de visionnage. Sans cookies, sans tiers.",
      page: "Statistiques",
      tiles: [["Vues totales", 12480, ""], ["Spectateurs uniques", 8902, ""], ["Temps de visionnage", 1204, " h"], ["Complétion", 68, " %"]],
      retention: "Rétention des spectateurs",
      views: "Vues dans le temps",
      thousands: "\u202f",
      deltas: ["+18\u00a0%", "+12\u00a0%", "+24\u00a0%", "+4\u00a0pts"],
      ranges: ["7 j", "30 j", "90 j", "Tout"],
      shield: "Sans cookies · Sans traqueurs",
    },

    deploy: {
      label: "Déploiement",
      title: "Une commande. En ligne en une minute.",
      sub: "API, worker, dashboard, base de données et file d’attente dans une seule image.",
      storage: "Votre stockage compatible S3, votre choix",
      live: "Hovod est en ligne sur",
    },

    sovereignty: {
      a: "Vos serveurs.",
      b: "Vos règles.",
      stat: "100 % de vos données restent sur votre infrastructure.",
      micro: ["RGPD dès la conception", "Votre juridiction", "Zéro dépendance"],
    },

    offer: {
      title: "Le même code. À vous de choisir.",
      selfName: "Auto-hébergé",
      selfPrice: "Gratuit, pour toujours",
      selfPoints: ["Illimité, sans quotas", "Licence MIT", "Une seule image Docker"],
      cloudName: "Hovod Cloud",
      cloudPrice: "Dès 29 €",
      cloudPer: " HT/mois",
      cloudPoints: ["Entièrement géré", "Diffusion et CDN inclus", "Zéro ops"],
    },

    end: {
      promise: "La plateforme vidéo qui vous appartient.",
      star: "Star sur GitHub",
      by: "Créé par",
    },
  },
};
