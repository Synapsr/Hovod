/* Hovod — launch film.
 *
 * One paused GSAP timeline, registered as window.__timelines.main once the fonts are in, so text
 * is measured exactly once, at setup, off screen.
 *
 * Seek safety: an element's first tween is a fromTo whose start state is also its state before
 * that tween; initial geometry is applied with gsap.set at build time; an element that comes back
 * later gets tl.set + tl.to (a set at t > 0 reverts cleanly when seeking backwards). No callbacks
 * drive pixels: counters are proxies whose setter writes the DOM while GSAP renders them.
 *
 * Times are absolute seconds. Music is 120 BPM: a beat is 0.5 s, a bar 2 s, and every section
 * starts on a bar line. Sound cues are recorded with cue() and exported for audio/soundtrack.py.
 */
(function () {
  "use strict";

  const BEAT = 0.5;
  const T = {
    hook: 0, pain: 4, reveal: 10, upload: 16, transcode: 20, stream: 25, ai: 30,
    share: 36, analytics: 40, deploy: 44, sov: 50, offer: 54, end: 58, total: 64,
  };
  const STAGE = { x: 770, y: 146, w: 1060, h: 788 };
  const MAIN = { x: 84, y: 52 };

  // ── helpers ────────────────────────────────────────────────────────────────
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const px = (n) => Math.round(n) + "px";

  function seeded(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // An object whose `v` writes to the DOM whenever GSAP renders it.
  function proxy(write, start) {
    const o = {};
    let v = start || 0;
    Object.defineProperty(o, "v", { get: () => v, set: (x) => { v = x; write(x); }, enumerable: true });
    write(v);
    return o;
  }

  // Kinetic-type words. "{…}" keeps a phrase together and paints it with the brand gradient.
  function words(text, o) {
    o = o || {};
    const out = [];
    const re = /\{([^}]*)\}|(\S+)/g;
    let m;
    while ((m = re.exec(text))) {
      const grad = m[1] !== undefined;
      const w = grad ? m[1] : m[2];
      const cls = ["w"];
      if (grad) cls.push(o.hl || "grad");
      if (!grad && o.red && o.red.test(w)) cls.push("their");
      const span = `<span class="${cls.join(" ")}">${esc(w)}</span>`;
      out.push(o.mask ? `<span class="m">${span}</span>` : span);
    }
    return out.join(" ");
  }

  // Off-screen measurement, independent of which scenes the runtime is showing.
  function measure(html, css) {
    const d = document.createElement("div");
    d.style.cssText = "position:absolute;left:0;top:-3000px;visibility:hidden;" + (css || "");
    d.innerHTML = html;
    document.body.appendChild(d);
    const r = d.getBoundingClientRect();
    const out = { w: r.width, h: r.height };
    d.remove();
    return out;
  }
  function pathLength(d) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("style", "position:absolute;left:0;top:-3000px");
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
    document.body.appendChild(svg);
    const l = p.getTotalLength();
    svg.remove();
    return l;
  }

  function lang() {
    let vars = {};
    try {
      vars = (window.__hyperframes && window.__hyperframes.getVariables && window.__hyperframes.getVariables()) || {};
    } catch (e) { vars = {}; }
    if (!vars.lang && window.__hfVariables && window.__hfVariables.lang) vars = window.__hfVariables;
    const q = new URLSearchParams(location.search).get("lang");
    const l = String(window.HOVOD_LANG || q || vars.lang || "en").toLowerCase();
    return l === "fr" ? "fr" : "en";
  }

  const I = {
    play: '<svg viewBox="0 0 32 32"><path d="M12 8v16l12-8z" fill="#fff"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    videos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6l-6 6 6 6"/><path d="M16 6l6 6-6 6"/></svg>',
    server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 2l1.9 5.6 5.6 1.9-5.6 1.9L11 17l-1.9-5.6L3.5 9.5l5.6-1.9z"/><path d="M19 13l.9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9z" opacity=".75"/></svg>',
    bucket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5.5" rx="8" ry="2.5"/><path d="M4 5.5l1.8 13c.2 1.4 2.9 2.5 6.2 2.5s6-1.1 6.2-2.5L20 5.5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
    cc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M10 10.5a2.5 2.5 0 1 0 0 3M17 10.5a2.5 2.5 0 1 0 0 3"/></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15M13 6l6 6-6 6"/></svg>',
    flame: '<svg viewBox="0 0 24 24"><path d="M12 2c.6 3.2 2.6 4.9 4.3 6.7C18 10.5 19 12.4 19 15a7 7 0 0 1-14 0c0-2.3 1-4 2.4-5.4.2 1.7.9 2.9 2.2 3.6C9.3 9.2 10.3 5.4 12 2z" fill="#fb923c"/><path d="M12 12c.3 1.6 1.4 2.4 2.2 3.3.5.6.8 1.2.8 2a3 3 0 0 1-6 0c0-1.1.5-1.9 1.2-2.6.1.8.5 1.3 1 1.6-.1-1.6.3-3 .8-4.3z" fill="#fde047"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.6 1.1 5.2 3 1.6-1.9 3.1-3 5.2-3 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z" fill="#f43f5e"/></svg>',
    party: '<svg viewBox="0 0 24 24"><path d="M3 21l5-14 9 9z" fill="#fbbf24"/><path d="M8 7l9 9-3 1.1L6.9 10z" fill="#f59e0b"/><circle cx="17" cy="5" r="1.6" fill="#a78bfa"/><circle cx="20.5" cy="10" r="1.3" fill="#34d399"/><circle cx="13" cy="3" r="1.1" fill="#f472b6"/><path d="M14 8.5c1-2 2.8-2.6 4.6-2.3" stroke="#60a5fa" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>',
    cursor: '<svg viewBox="0 0 34 40" width="34" height="40"><path d="M5 3.5l23 17-10.6 1.5 6.4 12.6-5.2 2.6-6.4-12.8L5 32.5z" fill="#fafafa" stroke="#18181b" stroke-width="2" stroke-linejoin="round"/></svg>',
  };

  // ── build ──────────────────────────────────────────────────────────────────
  function build() {
    const LANG = lang();
    const FR = LANG === "fr";
    const C = window.HOVOD_COPY[LANG];
    document.documentElement.lang = LANG;
    const nf = (n, dec) => {
      const f = Math.abs(n).toFixed(dec || 0).split(".");
      f[0] = f[0].replace(/\B(?=(\d{3})+(?!\d))/g, FR ? " " : ",");
      return f.join(FR ? "," : ".");
    };
    const money = (n) => (FR ? nf(n, 2) + " €" : "$" + nf(n, 2));
    const pct = (n) => n + (FR ? " %" : "%");

    const tl = gsap.timeline({ paused: true, defaults: { duration: 0.6, ease: "power3.out" } });
    const cues = [];
    const cue = (type, t, gain, extra) => { cues.push(Object.assign({ t: +t.toFixed(4), type: type, gain: gain == null ? 1 : gain }, extra || {})); };

    // cut-the-curve exit: accelerate out, fading during the first stretch of travel; ends at t
    function outX(els, t, dist, dur) {
      dur = dur || 0.3;
      const n = els.length || 1;
      const st = Math.min(0.022, 0.25 / n);
      const t0 = t - dur - st * (n - 1);
      tl.to(els, { x: dist, duration: dur, ease: "power4.in", stagger: st }, t0);
      tl.to(els, { opacity: 0, duration: 0.18, ease: "power1.in", stagger: st }, t0 + dur - 0.18);
    }
    // waterfall entrance: +230 → 0, gaps start at 50 ms and shrink ×0.84 per word
    function inWaterfall(els, t, dist) {
      let at = t, gap = 0.05;
      els.forEach((el) => {
        tl.fromTo(el, { x: dist == null ? 230 : dist, opacity: 0 }, { x: 0, opacity: 1, duration: 0.36, ease: "power4.out" }, at);
        at += gap;
        gap *= 0.84;
      });
    }
    function rise(els, t, o) {
      o = o || {};
      tl.fromTo(els, { yPercent: o.from == null ? 118 : o.from }, { yPercent: 0, duration: o.dur || 0.75, ease: o.ease || "expo.out", stagger: o.stagger == null ? 0.07 : o.stagger }, t);
    }
    function drop(els, t, o) {
      o = o || {};
      tl.to(els, { yPercent: o.to == null ? 118 : o.to, duration: o.dur || 0.34, ease: "power3.in", stagger: o.stagger == null ? 0.02 : o.stagger }, t);
    }
    function pop(el, t, o) {
      o = o || {};
      tl.fromTo(el, { y: o.y == null ? 16 : o.y, opacity: 0, scale: o.scale == null ? 1 : o.scale }, { y: 0, opacity: 1, scale: 1, duration: o.dur || 0.5, ease: o.ease || "power3.out", stagger: o.stagger || 0 }, t);
    }
    function typeLine(el, t, dur, chars) {
      tl.fromTo(el, { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: dur, ease: "steps(" + Math.max(1, chars) + ")" }, t);
    }
    function blink(el, from, to, period) {
      period = period || 0.5;
      const n = Math.max(0, Math.floor((to - from) / period) - 1);
      tl.fromTo(el, { opacity: 1 }, { opacity: 0, duration: period, ease: "steps(1)", repeat: n, yoyo: true, immediateRender: false }, from);
    }

    // ── background ───────────────────────────────────────────────────────────
    const gI = $("#g-indigo"), gV = $("#g-violet"), gT = $("#g-teal"), gR = $("#g-red"), grid = $("#grid");
    [gI, gV, gT, gR].forEach((g) => {
      const w = parseFloat(getComputedStyle(g).width);
      g.style.left = px(960 - w / 2);
      g.style.top = px(540 - w / 2);
    });
    gsap.set(gV, { x: 360, y: 260, scale: 0.4, opacity: 0 });
    gsap.set(gT, { x: 700, y: 520, scale: 0.9, opacity: 0 });
    tl.fromTo(grid, { backgroundPosition: "50% 0px" }, { backgroundPosition: "50% 160px", duration: T.total, ease: "none" }, 0);
    tl.fromTo(grid, { opacity: 0 }, { opacity: 0.55, duration: 1.2, ease: "power2.out" }, 0);
    tl.fromTo(gI, { x: 0, y: 380, scale: 0.7, opacity: 0 }, { opacity: 0.35, duration: 1.6, ease: "sine.inOut" }, 0);
    tl.fromTo(gR, { x: 0, y: 60, scale: 0.8, opacity: 0 }, { opacity: 0.55, scale: 1, duration: 1.4, ease: "sine.inOut" }, 1.5);
    tl.to(gR, { opacity: 1, duration: 1.2, ease: "sine.inOut" }, 4.2);
    tl.to(gI, { opacity: 0.12, duration: 1, ease: "sine.inOut" }, 4);
    tl.to([gR, gI], { scale: 0.05, opacity: 0, duration: 0.62, ease: "expo.in" }, 9.08);
    // reveal: brand light
    tl.set(gI, { x: 0, y: 0, scale: 0.25, opacity: 0 }, T.reveal);
    tl.to(gI, { scale: 1, opacity: 1, duration: 1.6, ease: "expo.out" }, T.reveal);
    tl.to(gV, { scale: 1, opacity: 0.75, duration: 1.8, ease: "expo.out" }, T.reveal + 0.1);
    tl.to(grid, { opacity: 0.8, duration: 0.8, ease: "power2.out" }, T.reveal);
    // product: the light leaves the copy for the stage
    tl.to(gI, { x: 620, y: -300, scale: 0.95, opacity: 0.85, duration: 1.4, ease: "power2.inOut" }, 15.3);
    tl.to(gV, { x: -700, y: 420, scale: 0.9, opacity: 0.55, duration: 1.4, ease: "power2.inOut" }, 15.3);
    tl.to(gT, { opacity: 0.8, duration: 1.4, ease: "power2.inOut" }, 15.6);
    tl.to(grid, { opacity: 0.45, duration: 1, ease: "power2.inOut" }, 15.6);
    tl.to(gI, { x: 420, y: -200, duration: 8, ease: "sine.inOut" }, 17);
    tl.to(gI, { x: 640, y: -120, duration: 10, ease: "sine.inOut" }, 25);
    tl.to(gI, { x: 520, y: -260, duration: 14, ease: "sine.inOut" }, 35);
    // sovereignty
    tl.to(gI, { x: 0, y: -20, scale: 1.1, opacity: 1, duration: 0.9, ease: "expo.out" }, T.sov);
    tl.to(gV, { x: 0, y: 330, scale: 1.1, opacity: 0.7, duration: 1.2, ease: "expo.out" }, T.sov);
    tl.to(gT, { opacity: 0, duration: 0.8, ease: "power2.out" }, T.sov);
    tl.to(grid, { opacity: 0.85, duration: 0.6, ease: "power2.out" }, T.sov);
    // offer / end
    tl.to(gI, { x: 0, y: 60, scale: 1, opacity: 0.7, duration: 1.2, ease: "power2.inOut" }, T.offer - 0.2);
    tl.to(gV, { x: 0, y: 420, scale: 1.2, opacity: 0.5, duration: 1.2, ease: "power2.inOut" }, T.offer - 0.2);
    tl.to(grid, { opacity: 0.5, duration: 1, ease: "power2.inOut" }, T.offer);
    tl.to(gI, { x: 0, y: -60, scale: 1.15, opacity: 1, duration: 1.2, ease: "expo.out" }, T.end);
    tl.to(gV, { x: 0, y: 360, scale: 1, opacity: 0.65, duration: 1.4, ease: "expo.out" }, T.end);
    tl.to(grid, { opacity: 0.7, duration: 1, ease: "power2.out" }, T.end);
    tl.fromTo("#fade", { opacity: 1 }, { opacity: 0, duration: 0.9, ease: "power2.out" }, 0.02);
    tl.to("#fade", { opacity: 1, duration: 0.7, ease: "power2.in" }, T.total - 0.72);

    // ── HUD (0–10) ──────────────────────────────────────────────────────────
    const hud = $("#s-hud");
    hud.innerHTML = `<div class="hud"><i></i><i></i><i></i><i></i>
      <span class="tag tl">Hovod · ${esc(C.hud.title)}</span>
      <span class="tag tr"><span class="rec"></span><span id="tc">00:00:00:00</span></span>
      <span class="tag bl">${esc(C.hud.specs)}</span>
      <span class="tag br">${esc(C.hud.ladder)}</span></div>`;
    const tc = $("#tc");
    const tcP = proxy((v) => {
      const f = Math.floor(v * 60 + 1e-6);
      tc.textContent = "00:00:" + String(Math.floor(f / 60)).padStart(2, "0") + ":" + String(f % 60).padStart(2, "0");
    });
    tl.fromTo(tcP, { v: 0 }, { v: 10, duration: 10, ease: "none" }, 0);
    tl.fromTo($$(".hud i", hud), { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.7, ease: "expo.out", stagger: 0.05 }, 0.12);
    tl.fromTo($$(".hud .tag", hud), { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.06 }, 0.3);
    tl.to($(".hud", hud), { opacity: 0, duration: 0.4, ease: "power2.in" }, 9.1);

    // ── 1 · hook (0–4) ──────────────────────────────────────────────────────
    const hook = $("#s-hook");
    hook.innerHTML = `<div class="guide" id="hk-guide"></div>` +
      C.hook.map((line, i) => `<div class="hook-line" id="hk${i}">${words(line, { red: /^(Their|Leur|Leurs)$/ })}</div>`).join("");
    tl.fromTo("#hk-guide", { scaleX: 0, opacity: 1 }, { scaleX: 1, duration: 1.1, ease: "power3.inOut" }, 0.15);
    tl.to("#hk-guide", { opacity: 0, duration: 0.3, ease: "power2.in" }, 3.7);
    const hk = [0, 1, 2].map((i) => $$(".w", $("#hk" + i)));
    tl.fromTo(hk[0], { y: 70, opacity: 0, filter: "blur(10px)" }, { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.8, ease: "expo.out", stagger: 0.09 }, 0.42);
    cue("hit_soft", 0.5);
    // 1 → 2 at 1.5: both travel right
    outX(hk[0], 1.5, 230, 0.3);
    tl.fromTo(hk[1], { x: -320, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, ease: "expo.out", stagger: 0.06 }, 1.5);
    cue("hit_soft", 1.5);
    cue("swish", 1.3, 0.5);
    // 2 → 3 at 2.5: inverse zoom-through, the third line slams in
    tl.to(hk[1], { scale: 0.8, opacity: 0, filter: "blur(8px)", duration: 0.22, ease: "power3.in", stagger: 0.02 }, 2.26);
    tl.fromTo(hk[2], { scale: 1.5, opacity: 0, filter: "blur(16px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "power4.out", stagger: 0.07 }, 2.5);
    cue("hit", 2.5);
    // → invoice at 4.0: both travel up
    tl.to(hk[2], { y: -230, duration: 0.3, ease: "power4.in", stagger: 0.02 }, 3.68);
    tl.to(hk[2], { opacity: 0, duration: 0.16, ease: "power1.in", stagger: 0.02 }, 3.8);
    cue("whoosh_up", 3.72, 0.7);

    // ── 2 · pain (4–10) ─────────────────────────────────────────────────────
    const pain = $("#s-pain");
    const bars = (() => { const r = seeded(7); let s = ""; for (let i = 0; i < 46; i++) s += `<b style="width:${1 + Math.floor(r() * 4)}px"></b>`; return s; })();
    const headline = C.pain.headline.replace(/^(\S+ \S+) (\S+)$/, "$1 {$2}");
    pain.innerHTML = `<div id="pain-wrap" class="fill">
      <div id="receipt-shake" class="fill"><div id="receipt"><div class="paper"></div>
        <div class="inner">
          <div class="rc-title">${esc(C.pain.invoiceTitle)}</div>
          <div class="rc-vendor">${esc(C.pain.invoiceVendor)}</div>
          <div class="rc-no">No. 2026-0928</div>
          <div class="rc-rule"></div>
          ${C.pain.lines.map((l) => `<div class="rc-line"><span class="lbl">${esc(l[0])}</span><span class="dots"></span><span class="val">${esc(l[1])}</span></div>`).join("")}
          <div class="rc-rule"></div>
          <div class="rc-total"><span class="lbl">${esc(C.pain.total)}</span><span class="amt" id="rc-amt"></span></div>
        </div>
        <div class="rc-barcode">${bars}</div>
      </div></div>
      <div id="pain-dim" class="fill" style="background:#09090b"></div>
      <div id="pain-headline">${words(headline, { hl: "their" })}</div>
    </div>
    <div id="singularity"></div>`;
    const receipt = $("#receipt");
    tl.fromTo(receipt, { y: 230, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55, ease: "power4.out" }, T.pain);
    $$(".rc-line", receipt).forEach((ln, i) => {
      const t = 4.5 + i * BEAT;
      tl.fromTo(ln, { opacity: 0, x: -16 }, { opacity: 1, x: 0, duration: 0.3, ease: "power3.out" }, t - 0.04);
      tl.fromTo($(".val", ln), { scale: 1.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "power4.out" }, t + 0.08);
      cue("print", t - 0.02, 0.8, { i: i });
      cue("stamp", t + 0.08, 0.7, { i: i });
    });
    const amt = $("#rc-amt");
    tl.fromTo($(".rc-total", receipt), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.35 }, 7.2);
    const amtP = proxy((v) => { amt.textContent = money(v); });
    tl.fromTo(amtP, { v: 0 }, { v: 4812.4, duration: 1.9, ease: "power2.in" }, 7.25);
    cue("counter", 7.25, 0.7, { dur: 1.85 });
    tl.fromTo($(".rc-barcode", receipt), { opacity: 0 }, { opacity: 1, duration: 0.4 }, 7.4);
    tl.fromTo("#pain-dim", { opacity: 0 }, { opacity: 0.74, duration: 0.3, ease: "power2.out" }, 7.9);
    tl.to(receipt, { scale: 0.94, duration: 0.6, ease: "power3.out" }, 7.9);
    tl.fromTo($$("#pain-headline .w"), { scale: 1.5, opacity: 0, filter: "blur(16px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "power4.out", stagger: 0.07 }, 7.96);
    // the hit shakes the bill once
    [[-12, 3], [9, -2], [-6, 2], [3, -1], [0, 0]].forEach((p, k) => tl.to("#receipt-shake", { x: p[0], y: p[1], duration: 0.045, ease: "sine.inOut" }, 8.02 + k * 0.045));
    cue("hit", 8.0);
    tl.to("#pain-wrap", { scale: 0.03, rotation: -8, opacity: 0, filter: "blur(18px)", duration: 0.62, ease: "expo.in" }, 9.08);
    cue("riser", 8.0, 0.9, { dur: 1.7 });
    cue("suck", 9.1, 0.8);
    const sing = $("#singularity");
    tl.fromTo(sing, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.2, ease: "power3.out" }, 9.55);
    tl.to(sing, { scale: 1.9, duration: 0.25, ease: "power2.in" }, 9.75);

    // ── 3 · reveal (10–16) ──────────────────────────────────────────────────
    const reveal = $("#s-reveal");
    const rr = seeded(11);
    let raysHtml = "";
    for (let i = 0; i < 18; i++) raysHtml += `<i style="transform:rotate(${(i * 20 + rr() * 8).toFixed(2)}deg)"></i>`;
    const promiseRows = [C.reveal.promise[0], C.reveal.promise[1] + " {" + C.reveal.highlight + "}"];
    const wmHtml = "Hovod".split("").map((ch) => `<span class="m" style="padding:0.1em 0 0.18em;margin:-0.1em 0 -0.18em"><span class="w">${ch}</span></span>`).join("");
    reveal.innerHTML = `<div class="flash" id="flash"></div><div class="shock" id="shock"></div><div class="rays" id="rays">${raysHtml}</div>
      <div id="wordmark">${wmHtml}</div>
      <div id="promise">${promiseRows.map((row) => `<span class="row">${words(row, { mask: true })}</span>`).join("")}</div>
      <div id="chips">
        <span class="chip">${I.code}${esc(C.reveal.chips[0])}</span>
        <span class="chip">${I.server}${esc(C.reveal.chips[1])}</span>
        <span class="chip">${I.spark}${esc(C.reveal.chips[2])}</span>
      </div>`;
    tl.fromTo("#flash", { scale: 0.15, opacity: 1 }, { scale: 1.1, opacity: 0, duration: 1.0, ease: "power2.out" }, T.reveal);
    tl.fromTo("#shock", { scale: 0.05, opacity: 1 }, { scale: 3.1, opacity: 0, duration: 1.2, ease: "expo.out" }, T.reveal);
    $$("#rays i").forEach((ray, i) => {
      const d = ((i * 7) % 5) * 0.012;
      tl.fromTo(ray, { scaleX: 0, opacity: 1 }, { scaleX: 1, duration: 0.55, ease: "expo.out" }, T.reveal + d);
      tl.to(ray, { opacity: 0, duration: 0.7, ease: "sine.out" }, T.reveal + 0.12 + d);
    });
    cue("impact", T.reveal, 1);

    const fly = $("#s-fly");
    fly.innerHTML = `<div class="logo-tile" id="flylogo">${I.play}<span class="sheen" id="fly-sheen"></span></div>`;
    const flylogo = $("#flylogo");
    tl.fromTo(flylogo, { scale: 0.2, rotation: -24, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.95, ease: "expo.out" }, T.reveal);
    tl.fromTo("#fly-sheen", { left: "-80%" }, { left: "150%", duration: 0.8, ease: "power2.inOut" }, T.reveal + 0.45);
    cue("shimmer", T.reveal + 0.45, 0.6);
    // lockup: tile + word centred as one unit
    const wmW = measure("Hovod", "font:680 138px/1 var(--sans);letter-spacing:-0.045em;white-space:nowrap").w;
    const tileS = 132, gap = 34, lockW = tileS + gap + wmW;
    const lockX = 960 - lockW / 2, lockCY = 372;
    Object.assign($("#wordmark").style, { left: px(lockX + tileS + gap), top: px(lockCY - 69 - 5) });
    tl.to(flylogo, { x: lockX + tileS / 2 - 960, y: lockCY - 540, scale: tileS / 168, duration: 0.75, ease: "power3.inOut" }, 10.95);
    cue("swish", 10.95, 0.5);
    rise($$("#wordmark .w"), 11.2, { stagger: 0.045, dur: 0.7 });
    const prRows = $$("#promise .row");
    rise($$(".w", prRows[0]), 11.55, { stagger: 0.06 });
    rise($$(".w", prRows[1]), 11.8, { stagger: 0.06 });
    cue("hit_soft", 11.5, 0.6);
    const chips = $$("#chips .chip");
    tl.fromTo(chips, { y: 22, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, stagger: 0.1 }, 12.45);
    chips.forEach((c, i) => cue("tick", 12.45 + i * 0.1, 0.5));
    drop($$("#promise .w"), 15.2, { stagger: 0.012 });
    tl.to(chips, { y: 20, opacity: 0, duration: 0.3, ease: "power3.in", stagger: 0.03 }, 15.2);
    drop($$("#wordmark .w"), 15.28, { stagger: 0.02 });
    const slot = { x: STAGE.x + 20 + 22, y: STAGE.y + 52 + 20 + 22 };
    tl.to(flylogo, { x: slot.x - 960, y: slot.y - 540, scale: 44 / 168, duration: 0.9, ease: "expo.inOut" }, 15.35);
    cue("whoosh", 15.4, 0.8);

    // ── product stage (16–50) ───────────────────────────────────────────────
    const prod = $("#s-product");
    const steps = [
      { k: "upload", t0: T.upload, t1: T.transcode },
      { k: "transcode", t0: T.transcode, t1: T.stream },
      { k: "stream", t0: T.stream, t1: T.ai },
      { k: "ai", t0: T.ai, t1: T.share },
      { k: "share", t0: T.share, t1: T.analytics },
      { k: "analytics", t0: T.analytics, t1: T.deploy },
      { k: "deploy", t0: T.deploy, t1: T.sov },
    ];
    const copyHtml = steps.map((s, i) => {
      const c = C[s.k];
      return `<div class="cp" id="cp${i}">
        <div class="cp-label"><span class="n">0${i + 1}</span><span class="sep"></span><span>${esc(c.label)}</span></div>
        <div class="cp-title">${words(c.title)}</div>
        <div class="cp-sub">${words(c.sub)}</div></div>`;
    }).join("");
    const nav = [I.videos, I.chart, I.key, I.users, I.gear];
    const up = C.upload, tr = C.transcode, stc = C.stream, ai = C.ai, sh = C.share, an = C.analytics, dp = C.deploy;
    const rungs = [["4320p", "8K", 40], ["2160p", "4K", 20], ["1440p", "2K", 10], ["1080p", "HD", 6], ["720p", "", 3], ["480p", "", 1.8], ["360p", "", 1]];
    const rungW = (mb) => Math.round(120 + 420 * Math.log(mb) / Math.log(40));
    const mbps = (mb) => (FR ? String(mb).replace(".", ",") : String(mb)) + " Mbps";
    let partsHtml = "";
    for (let i = 0; i < 150; i++) partsHtml += "<i><s></s><b></b></i>";
    let segHtml = "";
    for (let i = 0; i < 12; i++) segHtml += `<div class="seg">segment_${String(11 - i).padStart(3, "0")}.ts</div>`;
    const wr = seeded(21);
    let waveHtml = "";
    for (let i = 0; i < 60; i++) {
      const env = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.11));
      waveHtml += `<i style="height:${Math.round(8 + 44 * env * (0.55 + 0.45 * wr()))}px"></i>`;
    }
    const ret = [100, 86, 78, 73, 70, 67, 64, 61, 57, 52];
    const RW = 470, RH = 250;
    const retPts = ret.map((v, i) => [Math.round(i * RW / (ret.length - 1)), Math.round(RH - (v / 100) * (RH - 20))]);
    let retD = `M${retPts[0][0]},${retPts[0][1]}`;
    for (let i = 1; i < retPts.length; i++) {
      const p0 = retPts[i - 1], p1 = retPts[i], cx = (p0[0] + p1[0]) / 2;
      retD += ` C${cx},${p0[1]} ${cx},${p1[1]} ${p1[0]},${p1[1]}`;
    }
    const vb = seeded(5);
    let vbarsHtml = "";
    for (let i = 0; i < 24; i++) vbarsHtml += `<i style="height:${Math.round(60 + 170 * (0.35 + 0.65 * Math.pow(i / 23, 0.8)) * (0.72 + 0.28 * vb()))}px"></i>`;
    const stars = (() => { const r = seeded(3); let s = ""; for (let i = 0; i < 26; i++) s += `<i style="left:${(r() * 100).toFixed(1)}%;top:${(r() * 100).toFixed(1)}%;opacity:${(0.25 + r() * 0.6).toFixed(2)}"></i>`; return s; })();
    const sceneArt = (id) => `<div class="scene" id="${id}">
        <div class="sky"></div><div class="stars">${stars}</div><div class="sun"></div><div class="haze"></div>
        <svg class="layer l1" viewBox="0 0 1240 300" preserveAspectRatio="none" style="height:46%"><path d="M0 300V170l90-60 80 40 120-95 110 80 90-55 130 90 95-70 120 85 110-60 90 45 105-40v190z" fill="#3b1d5e" opacity=".9"/></svg>
        <svg class="layer l2" viewBox="0 0 1240 300" preserveAspectRatio="none" style="height:36%"><path d="M0 300V190l120-50 100 60 150-110 120 90 140-70 110 80 150-95 130 85 120-40v160z" fill="#231339"/></svg>
        <svg class="layer l3" viewBox="0 0 1240 300" preserveAspectRatio="none" style="height:24%"><path d="M0 300V210l160-40 140 55 170-75 160 70 180-60 170 65 260-30v105z" fill="#0f0a1c"/></svg>
      </div>`;
    const chapT = [0, 72, 168, 245, 318];
    const chapParts = (fill) => [0, 1, 2, 3].map((i) => `<div class="part ch" style="left:calc(${(chapT[i] / 318 * 100).toFixed(3)}% + ${i ? 3 : 0}px);width:calc(${((chapT[i + 1] - chapT[i]) / 318 * 100).toFixed(3)}% - ${i ? 3 : 0}px)"><b${fill && i === 0 ? ' style="transform:scaleX(0.58)"' : ""}></b></div>`).join("");
    const codeHtml = `<span class="cap">${esc(sh.embedCaption)}</span><span class="cl" id="cl0"><span class="c-t">&lt;iframe</span></span>\n<span class="cl" id="cl1">  <span class="c-a">src</span><span class="c-p">=</span><span class="c-s">"https://v.acme.com/embed/hV3kP9xQ2mLr7tWz"</span></span>\n<span class="cl" id="cl2">  <span class="c-a">allow</span><span class="c-p">=</span><span class="c-s">"fullscreen"</span><span class="c-t">&gt;&lt;/iframe&gt;</span></span><span class="caret" id="code-caret"></span>`;
    const logs = [["secrets", "generated · /data/.hovod-secrets"], ["mariadb", "ready"], ["redis", "ready"], ["migrations", "0001–0004 applied"], ["worker", "4 cores · FFmpeg ready"], ["api", "listening on :3000"]];
    const termHtml = `<span class="tline"><span class="pr">$ </span><span class="k tcmd" id="tcmd">docker run -d -p 3000:3000 -v hovod-data:/data synapsr/hovod</span><span class="caret" id="t-caret"></span></span>` +
      `<span class="tline dim" id="tl1">latest: Pulling from synapsr/hovod</span>` +
      `<span class="tline" id="tl2"><span class="dim">7c3b88e1a0f2</span><span class="pbar"><b id="pull-bar"></b></span><span class="okc" id="pull-ok">Pull complete</span></span>` +
      logs.map((l, i) => `<span class="tline tlog" id="tlog${i}"><span class="okc tick">${I.check}</span>${l[0].padEnd(12, " ")}<span class="dim">${esc(l[1])}</span></span>`).join("") +
      `<span class="tline" id="tlive"><span class="hl larr">${I.arrow}</span>${esc(dp.live)} <span class="hl" style="text-decoration:underline">http://localhost:3000</span><span class="caret" id="t-caret2"></span></span>`;

    prod.innerHTML = `<div id="prod-wrap" class="fill">
      <div id="rail">${C.rail.map(() => "<i><b></b></i>").join("")}</div>
      <div id="copy">${copyHtml}</div>
      <div id="stage">
        <div class="win" id="win-app">
          <div class="win-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
            <div class="url">${I.lock}<span class="u" id="u-app0">app.hovod.dev/videos/new</span><span class="u" id="u-app1">app.hovod.dev/videos/vd_8Hq2kX3mPz1L</span><span class="u" id="u-app2">app.hovod.dev/analytics</span></div></div>
          <div class="side"><div class="hl" id="side-hl"></div>
            ${nav.map((ic, i) => `<div class="nav" style="top:${100 + i * 60}px">${ic}</div>`).join("")}
            <div class="slot"><div class="logo-tile small" id="side-logo">${I.play}</div></div></div>
          <div class="main">
            <div class="view" id="v-upload">
              <div class="v-crumb">${esc(up.crumb)} / ${esc(up.page)}</div>
              <div class="v-title">${esc(up.page)}</div>
              <div class="drop" id="drop"><div class="ring">${I.upload}</div><div class="t">${esc(up.drop)}</div><div class="f">MP4 · MOV · MKV · 8K</div></div>
              <div class="drop-hot" id="drop-hot"></div>
              <div id="up-info" style="position:absolute;left:400px;right:40px;top:412px"><div class="up-top"><span id="up-parts"></span><span class="pct" id="up-pct"></span></div><div class="bar"><b id="up-bar"></b></div></div>
              <div class="parts" id="parts" style="position:absolute;left:40px;right:40px;top:522px;margin:0">${partsHtml}</div>
            </div>
            <div class="view" id="v-transcode">
              <div class="ladder" id="ladder" style="top:170px">
                <div class="ladder-h"><span>${esc(tr.ladder)}</span><span>${esc(tr.renditions)}</span></div>
                ${rungs.map((r) => `<div class="rung"><span class="res">${r[0]}</span><span class="tag">${r[1]}</span><span class="track" style="width:${rungW(r[2])}px"><span class="fill"></span></span><span class="kbps">${mbps(r[2])}</span><span class="ok">${I.check}</span></div>`).join("")}
              </div>
              <div class="segs" id="segs"><span class="lbl">${esc(tr.segments)}</span><div class="seg-lane"><div class="seg-strip" id="seg-strip">${segHtml}</div></div>
                <div class="bucket"><span class="bi">${I.bucket}</span><span>${esc(tr.bucket)}</span></div></div>
            </div>
            <div class="view" id="v-analytics">
              <div class="v-title" id="an-title" style="margin-top:0">${esc(an.page)}</div>
              <div class="shield" id="shield" style="top:30px">${I.shield}${esc(an.shield)}</div>
              <div class="range">${an.ranges.map((r, i) => `<span class="${i === 1 ? "on" : ""}">${esc(r)}</span>`).join("")}</div>
              <div class="tiles">${an.tiles.map((t, i) => `<div class="tile"><div class="k">${esc(t[0])}</div><div class="v" id="tile${i}">0</div><span class="dl">${esc(an.deltas[i])}</span></div>`).join("")}</div>
              <div class="chart" style="left:40px;width:540px"><div class="ch-h">${esc(an.retention)}</div>
                <svg width="${RW}" height="${RH}" viewBox="0 0 ${RW} ${RH}" style="left:34px;bottom:30px;overflow:visible">
                  <defs><linearGradient id="retg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6366f1" stop-opacity=".45"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></linearGradient></defs>
                  ${[0, 1, 2, 3].map((k) => `<line x1="0" x2="${RW}" y1="${20 + k * (RH - 20) / 3}" y2="${20 + k * (RH - 20) / 3}" stroke="rgba(255,255,255,.06)"/>`).join("")}
                  <path id="ret-area" d="${retD} L${RW},${RH} L0,${RH} Z" fill="url(#retg)"/>
                  <path id="ret-line" d="${retD}" fill="none" stroke="#a5b4fc" stroke-width="4" stroke-linecap="round"/>
                  ${retPts.map((p) => `<circle class="ret-dot" cx="${p[0]}" cy="${p[1]}" r="6" fill="#0e0e11" stroke="#a5b4fc" stroke-width="3"/>`).join("")}
                </svg></div>
              <div class="chart" style="left:600px;right:40px"><div class="ch-h">${esc(an.views)}</div><div class="vbars">${vbarsHtml}</div></div>
            </div>
          </div>
          <div class="player" id="player">${sceneArt("scene-a")}
            <div class="cc" id="cc" style="bottom:22%"><span style="font-size:20px">${esc(ai.subtitle)}</span></div>
            <div class="hudchip" id="hc-src" style="left:22px;top:22px"><span class="led"></span><span class="k">${esc(stc.source)}</span><span>${esc(stc.sourceVal)}</span></div>
            <div class="hudchip" id="hc-api" style="left:22px;top:72px"><span class="k">${esc(stc.api)}</span><span class="g">${esc(stc.apiVal)}</span></div>
            <div class="ctrls" id="ctrls"><div class="scrub" id="scrub"><div class="part full" style="left:0;right:0"><b></b></div>${chapParts(false)}<div class="knob"></div></div>
              <div class="ctrl-row">${I.pause}${I.vol}<span class="time" id="ptime"></span><span class="sp"></span>${I.cc}<span class="q"><span id="q-auto">AUTO</span><span id="q-4k">4K</span></span>${I.full}</div></div>
            <div class="qmenu" id="qmenu">${["Auto", "4320p", "2160p", "1440p", "1080p", "720p", "480p", "360p"].map((q) => `<div class="qi${q === "2160p" ? " on" : ""}">${q}${q === "4320p" ? "<em>8K</em>" : q === "2160p" ? "<em>4K</em>" : ""}</div>`).join("")}</div>
          </div>
          <div class="meta-row" id="pmeta" style="top:612px;left:124px;right:40px">
            <span class="vt">${esc(stc.videoTitle)}</span><span class="badge ready"><span class="d"></span>${FR ? "Prêt" : "Ready"}</span>
            <span class="mono" id="pmeta-mono" style="margin-left:auto;font-size:16px;color:#71717a">${esc(stc.meta)}</span></div>
          <div class="wave" id="wave" style="left:124px;top:470px">${waveHtml}</div>
          <div class="wave" id="wave-hot" style="left:124px;top:470px">${waveHtml}</div>
          <div class="ai-badge" id="ai-badge" style="left:124px;top:560px">${I.spark}${esc(ai.badge)}</div>
          <div id="aifiles" style="position:absolute;left:124px;top:626px;display:flex;gap:10px">${ai.files.map((f) => `<span class="hudchip" style="position:static;background:rgba(255,255,255,.04)">${esc(f)}</span>`).join("")}</div>
          <div class="aipanel" id="aipanel" style="left:690px;right:40px;top:86px;bottom:34px;width:auto">
            <div class="tabs"><span class="tab on">${esc(ai.transcript)}</span><span class="tab">${esc(ai.chapters)}</span></div>
            <div class="tr-body"><span class="tr-ts">0:38 — 0:47</span>${ai.words.split(" ").map((w) => `<span class="tk">${esc(w)}</span>`).join(" ")}</div>
            <div class="chap-list" id="chaps"><div class="chap-h">${esc(ai.chapters)}</div>${ai.chapterList.map((c, i) => `<div class="chap${i === 0 ? " on" : ""}"><span class="ts">${c[0]}</span><span>${esc(c[1])}</span></div>`).join("")}</div>
          </div>
        </div>
        <div class="file" id="file">
          <div class="ficon"></div>
          <div class="fmain"><div class="fname">${esc(up.file)}</div><div class="fmeta">${esc(up.meta)}</div></div>
          <div id="fok" style="position:absolute;right:18px;top:33px;width:30px;height:30px;border-radius:50%;background:rgba(16,185,129,.16);color:#34d399;display:flex;align-items:center;justify-content:center">${I.check.replace("<svg ", '<svg style="width:16px;height:16px" ')}</div>
          <div class="badges">
            <span class="badge uploaded" id="b-up"><span class="d"></span>${FR ? "Importé" : "Uploaded"}</span>
            <span class="badge queued" id="b-q"><span class="d"></span>${FR ? "En file" : "Queued"}</span>
            <span class="badge processing" id="b-p"><span class="d" id="b-p-dot"></span>${FR ? "En cours" : "Processing"}</span>
            <span class="badge ready" id="b-r"><span class="d"></span>${FR ? "Prêt" : "Ready"}</span>
          </div>
        </div>
        <div class="win" id="win-site">
          <div class="win-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><div class="url">${I.lock}<span class="u" style="opacity:1">${esc(sh.site)}</span></div></div>
          <div class="article">
            <div class="art-nav" style="top:78px"><span class="brand">${esc(sh.brand)}</span>${sh.nav.map((n) => `<span>${esc(n)}</span>`).join("")}</div>
            <div class="art-title" style="top:140px">${esc(sh.siteTitle)}</div>
            <div class="art-lines" style="top:206px"><i style="width:540px"></i><i style="width:500px"></i><i style="width:360px"></i></div>
            <div class="code-card" id="code" style="left:50px;top:300px;width:560px;height:315px">${codeHtml}</div>
            <div class="player" id="player2" style="left:50px;top:300px;width:560px;height:315px">${sceneArt("scene-b")}
              <div class="ctrls"><div class="scrub">${chapParts(true)}<div class="knob" style="left:13.2%"></div></div><div class="ctrl-row" style="font-size:15px;gap:14px">${I.pause}<span class="time">0:42 / 5:18</span><span class="sp"></span>${I.cc}<span class="q">4K</span>${I.full}</div></div></div>
            <div class="reactions" id="reacts" style="left:50px;top:640px">${[[I.flame, 24], [I.heart, 18], [I.party, 12]].map((r) => `<span class="react">${r[0]}${r[1]}</span>`).join("")}</div>
            <div class="stores-h" id="cm-h" style="left:650px;top:306px">${esc(sh.commentsTitle)} · 2</div>
            ${sh.comments.map((c, i) => `<div class="comment" id="cm${i}" style="left:650px;top:${346 + i * 104}px;width:370px"><span class="av" style="background:${i ? "linear-gradient(135deg,#34d399,#0ea5e9)" : "linear-gradient(135deg,#f472b6,#8b5cf6)"}">${esc(c[1][0])}</span><div><div class="who">${esc(c[1])}<span class="ts">${esc(c[0])}</span></div><div class="txt">${esc(c[2])}</div></div></div>`).join("")}
          </div>
        </div>
        <div class="term" id="term" style="left:0;top:0;width:1060px;height:540px">
          <div class="tbar"><span class="dot" style="background:#ef4444"></span><span class="dot" style="background:#f59e0b"></span><span class="dot" style="background:#22c55e"></span><span class="tt">hovod — zsh</span></div>
          <div class="tbody">${termHtml}</div>
        </div>
        <div class="stores-h" id="stores-h" style="left:0;top:590px">${esc(dp.storage)}</div>
        <div class="stores" id="stores" style="left:0;top:626px">${[["AWS S3", "#ff9900"], ["Cloudflare R2", "#f38020"], ["Backblaze B2", "#e21e29"], ["MinIO", "#c72e49"], ["DigitalOcean Spaces", "#0080ff"]].map((s) => `<span class="store"><span class="sw" style="background:${s[1]}"></span>${s[0]}</span>`).join("")}</div>
      </div>
      <div id="cursor">${I.cursor}</div>
      <div class="click-ring" id="ring"></div>
    </div>`;

    const scr = (x, y) => ({ x: STAGE.x + x, y: STAGE.y + y });
    const cursor = $("#cursor"), ring = $("#ring");
    // the cursor's tip sits 5 × 3.5 px inside its box
    const moveCursor = (t, dur, sx, sy, ease) => tl.to(cursor, { x: sx - 5, y: sy - 3.5, duration: dur, ease: ease || "power3.inOut" }, t);
    function click(t, sx, sy) {
      tl.to(cursor, { scale: 0.86, duration: 0.07, ease: "power2.out", transformOrigin: "5px 4px" }, t);
      tl.to(cursor, { scale: 1, duration: 0.16, ease: "power2.out" }, t + 0.07);
      tl.set(ring, { x: sx, y: sy, scale: 0.3, opacity: 0.9 }, t);
      tl.to(ring, { scale: 2.2, opacity: 0, duration: 0.6, ease: "power2.out" }, t);
      cue("click", t, 0.8);
    }

    // copy column: fit each title into three lines, then waterfall in and out
    const cps = $$(".cp");
    cps.forEach((cp) => {
      const title = $(".cp-title", cp);
      let size = 76;
      while (size > 58 && measure(title.innerHTML, `width:590px;font:700 ${size}px/1.02 var(--sans);letter-spacing:-0.045em`).h > size * 1.02 * 3 + 4) size -= 2;
      title.style.fontSize = size + "px";
    });
    const rail = $$("#rail i b");
    steps.forEach((s, i) => {
      const ws = [$(".cp-label", cps[i])].concat($$(".cp-title .w", cps[i]), $$(".cp-sub .w", cps[i]));
      inWaterfall(ws, s.t0 + (i === 0 ? 0.2 : 0));
      if (i < steps.length - 1) outX(ws, s.t1, -230, 0.34);
      tl.fromTo(rail[i], { scaleX: 0 }, { scaleX: 1, duration: s.t1 - s.t0 - 0.1, ease: "none" }, s.t0);
      if (i > 0) cue("cut", s.t0, 0.6);
    });
    tl.fromTo("#rail", { opacity: 0 }, { opacity: 1, duration: 0.5 }, 16.0);

    // window + sidebar handoff ------------------------------------------------
    const winApp = $("#win-app");
    tl.fromTo(winApp, { y: 60, scale: 0.96, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.65 }, 15.5);
    tl.fromTo($$(".side .nav", winApp), { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: 0.4, stagger: 0.05 }, 16.1);
    tl.fromTo("#side-hl", { opacity: 0, y: 0 }, { opacity: 1, duration: 0.3 }, 16.3);
    tl.fromTo("#side-logo", { opacity: 0 }, { opacity: 1, duration: 0.02, ease: "none" }, 16.28);
    tl.to(flylogo, { opacity: 0, duration: 0.02, ease: "none" }, 16.29);
    cue("tick", 16.28, 0.6);
    tl.set("#u-app0", { opacity: 1 }, 15.5);
    tl.set("#u-app0", { opacity: 0 }, 20.0);
    tl.set("#u-app1", { opacity: 1 }, 20.0);
    tl.set("#u-app1", { opacity: 0 }, 39.9);
    tl.set("#u-app2", { opacity: 1 }, 39.9);

    // 01 · upload (16–20) ----------------------------------------------------
    const vUp = $("#v-upload");
    const file = $("#file");
    const FILE0 = { x: -150, y: 700 }, FILED = { x: 407, y: 253 }, FILEU = { x: 124, y: 450 };
    const grip = { x: 250, y: 58 };
    gsap.set(file, { x: FILE0.x, y: FILE0.y, rotation: -9, scale: 1.05 });
    gsap.set(cursor, { x: scr(FILE0.x + grip.x, 0).x - 5, y: scr(0, FILE0.y + grip.y).y - 3.5 });
    tl.fromTo([$(".v-crumb", vUp), $(".v-title", vUp), "#drop"], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.05 }, 16.3);
    tl.to(file, { opacity: 1, duration: 0.2, ease: "none" }, 16.55);
    tl.to(cursor, { opacity: 1, duration: 0.2, ease: "none" }, 16.55);
    tl.to(file, { x: FILED.x, y: FILED.y, rotation: 0, duration: 0.8, ease: "power3.inOut" }, 16.6);
    const dropTip = scr(FILED.x + grip.x, FILED.y + grip.y);
    moveCursor(16.6, 0.8, dropTip.x, dropTip.y);
    cue("whoosh", 16.6, 0.55);
    tl.fromTo("#drop-hot", { opacity: 0 }, { opacity: 1, duration: 0.2 }, 17.05);
    tl.to(file, { scale: 0.97, duration: 0.08, ease: "power2.out" }, 17.42);
    tl.to(file, { scale: 1, duration: 0.25, ease: "power3.out" }, 17.5);
    click(17.42, dropTip.x, dropTip.y);
    cue("drop", 17.45, 0.9);
    moveCursor(17.55, 0.5, dropTip.x + 180, dropTip.y + 160, "power2.in");
    tl.to(cursor, { opacity: 0, duration: 0.3, ease: "power2.in" }, 17.75);
    tl.to("#drop-hot", { opacity: 0, duration: 0.35 }, 17.5);
    tl.to("#drop", { opacity: 0.4, duration: 0.4 }, 17.5);
    tl.to(file, { x: FILEU.x, y: FILEU.y, duration: 0.5, ease: "power3.inOut" }, 17.58);
    tl.fromTo("#up-info", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4 }, 17.85);
    tl.fromTo("#parts", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4 }, 17.9);
    // 150 parts of 16 MB, three in flight at a time
    const upStart = 18.0, upEnd = 19.72, gdt = (upEnd - upStart - 0.12) / 50;
    $$("#parts i").forEach((p, k) => {
      const t = upStart + Math.floor(k / 3) * gdt;
      tl.fromTo($("s", p), { opacity: 0 }, { opacity: 0.9, duration: 0.04, ease: "none" }, t);
      tl.to($("s", p), { opacity: 0, duration: 0.12, ease: "none" }, t + 0.1);
      tl.fromTo($("b", p), { opacity: 0 }, { opacity: 1, duration: 0.08, ease: "none" }, t + 0.1);
    });
    const upParts = $("#up-parts"), upPct = $("#up-pct");
    const upP = proxy((v) => {
      const done = Math.min(150, Math.round(v));
      upParts.textContent = up.parts.replace("{done}", done).replace("{total}", 150);
      upPct.textContent = pct(Math.round(done / 1.5));
    });
    tl.fromTo(upP, { v: 0 }, { v: 150, duration: upEnd - upStart, ease: "none" }, upStart);
    tl.fromTo("#up-bar", { scaleX: 0 }, { scaleX: 1, duration: upEnd - upStart, ease: "none" }, upStart);
    cue("upload", upStart, 0.5, { dur: upEnd - upStart });
    tl.fromTo("#fok", { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: "back.out(1.8)" }, 19.75);
    cue("done", 19.75, 0.7);

    // 02 · transcode (20–25) -------------------------------------------------
    tl.to([$(".v-crumb", vUp), $(".v-title", vUp), "#drop", "#up-info", "#parts"], { y: -40, opacity: 0, duration: 0.32, ease: "power3.in", stagger: 0.02 }, 19.72);
    tl.to("#fok", { scale: 0, opacity: 0, duration: 0.2, ease: "power3.in" }, 19.95);
    tl.to(file, { y: MAIN.y + 34, width: 896, height: 104, duration: 0.6, ease: "power3.inOut" }, 20.0);
    const bUp = $("#b-up"), bQ = $("#b-q"), bP = $("#b-p"), bR = $("#b-r");
    tl.fromTo(bUp, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3 }, 20.4);
    const swapBadge = (a, b, t) => {
      tl.to(a, { y: -10, opacity: 0, duration: 0.18, ease: "power3.in" }, t - 0.18);
      tl.fromTo(b, { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3 }, t);
      cue("tick", t, 0.55);
    };
    swapBadge(bUp, bQ, 20.8);
    swapBadge(bQ, bP, 21.2);
    tl.fromTo("#b-p-dot", { scale: 1, opacity: 1 }, { scale: 1.7, opacity: 0.45, duration: 0.25, ease: "sine.inOut", yoyo: true, repeat: 11 }, 21.3);
    swapBadge(bP, bR, 24.5);
    const vTr = $("#v-transcode");
    const ladRows = $$(".rung", vTr);
    tl.fromTo($(".ladder-h", vTr), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 }, 20.5);
    ladRows.slice().reverse().forEach((row, j) => tl.fromTo(row, { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.45 }, 20.6 + j * 0.06));
    const ends = [24.25, 23.75, 23.5, 23.0, 22.75, 22.25, 22.0];
    ladRows.forEach((row, i) => {
      const t0 = 21.25 + (6 - i) * 0.04;
      tl.fromTo($(".fill", row), { scaleX: 0 }, { scaleX: 1, duration: ends[i] - t0, ease: "power1.inOut" }, t0);
      tl.fromTo($(".ok", row), { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: "back.out(1.7)" }, ends[i]);
      cue("note", ends[i], 0.7, { step: 6 - i });
    });
    tl.fromTo("#segs", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.45 }, 21.0);
    // the conveyor advances one segment per beat, straight into the bucket
    const pitch = 123, stripW = 12 * pitch - 8;
    tl.fromTo("#seg-strip", { x: -stripW }, { x: -stripW + pitch, duration: 0.3, ease: "power3.inOut" }, 21.25);
    for (let k = 1; k < 7; k++) tl.to("#seg-strip", { x: -stripW + pitch * (k + 1), duration: 0.3, ease: "power3.inOut" }, 21.25 + k * BEAT);
    tl.to(["#ladder", "#segs"], { y: -30, opacity: 0, duration: 0.3, ease: "power3.in", stagger: 0.04 }, 24.7);

    // 03 · stream (25–30) ----------------------------------------------------
    const player = $("#player");
    const P1 = { x: 124, y: 86, w: 896, h: 504 }, P2 = { x: 124, y: 86, w: 540, h: 304 };
    gsap.set(player, { x: 142, y: MAIN.y + 34 + 20, width: 58, height: 64, borderRadius: 10 });
    tl.fromTo(player, { opacity: 0 }, { opacity: 1, duration: 0.12, ease: "none" }, 24.98);
    tl.to(player, { x: P1.x, y: P1.y, width: P1.w, height: P1.h, borderRadius: 14, duration: 0.8, ease: "power3.inOut" }, 25.0);
    tl.to(file, { opacity: 0, duration: 0.3, ease: "power2.in" }, 25.05);
    cue("whoosh", 25.0, 0.6);
    tl.fromTo("#ctrls", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 25.6);
    const scrub = $("#scrub");
    const knob = $(".knob", scrub), fullB = $(".full b", scrub), chB = $$(".ch b", scrub), ptime = $("#ptime");
    const mmss = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
    const playP = proxy((sec) => {
      const p = sec / 318;
      knob.style.left = (p * 100).toFixed(3) + "%";
      fullB.style.transform = `scaleX(${p.toFixed(5)})`;
      chB.forEach((b, i) => {
        const a = chapT[i] / 318, z = chapT[i + 1] / 318;
        b.style.transform = `scaleX(${Math.max(0, Math.min(1, (p - a) / (z - a))).toFixed(5)})`;
      });
      ptime.textContent = mmss(sec) + " / 5:18";
    }, 38);
    tl.fromTo(playP, { v: 38 }, { v: 48.3, duration: 10.3, ease: "none" }, 25.6);
    const layers = (id) => ({ l1: $(`#${id} .l1`), l2: $(`#${id} .l2`), l3: $(`#${id} .l3`), sun: $(`#${id} .sun`) });
    const A = layers("scene-a");
    tl.fromTo(A.l1, { xPercent: 0 }, { xPercent: -3, duration: 11, ease: "none" }, 25);
    tl.fromTo(A.l2, { xPercent: 0 }, { xPercent: -5.5, duration: 11, ease: "none" }, 25);
    tl.fromTo(A.l3, { xPercent: 0 }, { xPercent: -8.5, duration: 11, ease: "none" }, 25);
    tl.fromTo(A.sun, { yPercent: 0 }, { yPercent: -28, duration: 11, ease: "none" }, 25);
    // quality menu, opened by the cursor
    const qTip = scr(P1.x + P1.w * 0.97 - 26 - 20 - 29, P1.y + P1.h - P1.h * 0.06 - 18);
    const qmenu = $("#qmenu");
    Object.assign(qmenu.style, { left: px(P1.w * 0.97 - 26 - 20 - 230 + 30), top: px(P1.h - P1.h * 0.06 - 36 - 12 - 340) });
    tl.set(cursor, { x: qTip.x + 190, y: qTip.y + 120, scale: 1 }, 26.19);
    tl.to(cursor, { opacity: 1, duration: 0.2, ease: "none" }, 26.2);
    moveCursor(26.25, 0.6, qTip.x, qTip.y);
    click(26.92, qTip.x, qTip.y);
    tl.fromTo(qmenu, { opacity: 0, y: 10, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 0.3, transformOrigin: "80% 100%" }, 26.98);
    tl.fromTo($$(".qi", qmenu), { opacity: 0, x: 8 }, { opacity: 1, x: 0, duration: 0.3, stagger: 0.025 }, 27.02);
    tl.to(qmenu, { opacity: 0, y: 6, duration: 0.22, ease: "power3.in" }, 27.95);
    tl.set("#q-auto", { opacity: 0 }, 28.0);
    tl.set("#q-4k", { opacity: 1 }, 28.0);
    cue("tick", 28.0, 0.5);
    moveCursor(28.1, 0.5, qTip.x + 200, qTip.y + 140, "power2.in");
    tl.to(cursor, { opacity: 0, duration: 0.3, ease: "power2.in" }, 28.3);
    tl.fromTo("#hc-src", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.45 }, 28.2);
    tl.fromTo("#hc-api", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.45 }, 28.4);
    cue("blip", 28.2, 0.5);
    cue("blip", 28.4, 0.5);
    tl.to(["#hc-src", "#hc-api"], { opacity: 0, duration: 0.25, ease: "power2.in" }, 29.72);
    tl.fromTo("#pmeta", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5 }, 25.75);

    // 04 · AI (30–36) --------------------------------------------------------
    tl.to(player, { x: P2.x, y: P2.y, width: P2.w, height: P2.h, duration: 0.7, ease: "power3.inOut" }, 30.0);
    tl.to("#pmeta", { y: -200, duration: 0.7, ease: "power3.inOut" }, 30.0);
    tl.to("#pmeta-mono", { opacity: 0, duration: 0.2 }, 30.0);
    tl.fromTo("#aipanel", { x: 60, opacity: 0 }, { x: 0, opacity: 1, duration: 0.6 }, 30.15);
    cue("whoosh", 30.1, 0.5);
    const toks = $$("#aipanel .tk");
    toks.forEach((tk, i) => tl.fromTo(tk, { color: "#52525b" }, { color: "#fafafa", duration: 0.14, ease: "none" }, 30.7 + i * (2.4 / toks.length)));
    cue("sparkle", 30.7, 0.6, { dur: 2.4 });
    tl.fromTo("#cc", { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3 }, 31.0);
    tl.to("#cc", { opacity: 0, duration: 0.25 }, 35.55);
    $$("#wave i").forEach((b) => { b.style.background = "rgba(255,255,255,.13)"; });
    tl.fromTo("#wave", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 30.5);
    tl.fromTo("#wave-hot", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 4.8, ease: "none" }, 30.6);
    pop("#ai-badge", 31.4);
    cue("blip", 31.4, 0.5);
    tl.fromTo("#chaps", { opacity: 0 }, { opacity: 1, duration: 0.2 }, 33.2);
    tl.fromTo($$("#chaps .chap"), { x: 24, opacity: 0 }, { x: 0, opacity: 1, duration: 0.4, ease: "power4.out", stagger: 0.1 }, 33.3);
    [0, 1, 2, 3].forEach((i) => cue("tick", 33.3 + i * 0.1, 0.55));
    tl.to($(".full", scrub), { opacity: 0, duration: 0.25 }, 33.35);
    tl.fromTo($$(".ch", scrub), { opacity: 0 }, { opacity: 1, duration: 0.25, stagger: 0.06 }, 33.35);
    pop($$("#aifiles .hudchip"), 34.0, { y: 12, dur: 0.4, stagger: 0.1 });
    [0, 1, 2].forEach((i) => cue("blip", 34 + i * 0.1, 0.4));

    // 05 · share (36–40) -----------------------------------------------------
    const winSite = $("#win-site");
    tl.to(winApp, { x: -230, duration: 0.3, ease: "power4.in" }, 35.7);
    tl.to(winApp, { opacity: 0, duration: 0.16, ease: "power1.in" }, 35.86);
    tl.fromTo(winSite, { x: 230, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, ease: "power4.out" }, 35.96);
    cue("whoosh", 35.8, 0.7);
    const cl = $$("#code .cl");
    typeLine(cl[0], 36.3, 0.12, 7);
    typeLine(cl[1], 36.45, 0.55, 49);
    typeLine(cl[2], 37.05, 0.3, 30);
    cue("typing", 36.3, 0.55, { dur: 1.05 });
    blink("#code-caret", 37.35, 37.85, 0.25);
    tl.to("#code", { opacity: 0, scale: 0.98, duration: 0.25, ease: "power3.in" }, 37.5);
    tl.fromTo("#player2", { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.5 }, 37.62);
    cue("pop", 37.62, 0.7);
    const B = layers("scene-b");
    tl.fromTo(B.l1, { xPercent: -3.2 }, { xPercent: -4.4, duration: 3, ease: "none" }, 37.5);
    tl.fromTo(B.l2, { xPercent: -5.8 }, { xPercent: -7.8, duration: 3, ease: "none" }, 37.5);
    tl.fromTo(B.l3, { xPercent: -9 }, { xPercent: -12, duration: 3, ease: "none" }, 37.5);
    tl.fromTo(B.sun, { yPercent: -30 }, { yPercent: -38, duration: 3, ease: "none" }, 37.5);
    pop("#cm-h", 37.95, { y: 10, dur: 0.4 });
    pop("#cm0", 38.15, { dur: 0.45 });
    pop("#cm1", 38.5, { dur: 0.45 });
    cue("pop", 38.15, 0.6);
    cue("pop", 38.5, 0.6);
    tl.fromTo($$("#reacts .react"), { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.8)", stagger: 0.08 }, 38.8);
    [0, 1, 2].forEach((i) => cue("bubble", 38.8 + i * 0.08, 0.5, { i: i }));

    // 06 · analytics (40–44) -------------------------------------------------
    tl.to(winSite, { x: -230, duration: 0.3, ease: "power4.in" }, 39.7);
    tl.to(winSite, { opacity: 0, duration: 0.16, ease: "power1.in" }, 39.86);
    // re-dress the app window while it is off screen
    tl.set(["#aipanel", "#ai-badge", "#aifiles", "#wave", "#wave-hot", "#pmeta", player], { opacity: 0 }, 39.9);
    tl.set("#side-hl", { y: 60 }, 39.9);
    tl.set("#v-analytics", { opacity: 1 }, 39.9);
    tl.set(winApp, { x: 230, opacity: 0 }, 39.96);
    tl.to(winApp, { x: 0, opacity: 1, duration: 0.5, ease: "power4.out" }, 39.96);
    cue("whoosh", 39.8, 0.7);
    const shieldX = 40 + measure(esc(an.page), "font:650 34px/1 var(--sans);letter-spacing:-0.03em;white-space:nowrap").w + 24;
    $("#shield").style.left = px(shieldX);
    tl.fromTo($$("#v-analytics .tile"), { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, stagger: 0.06 }, 40.1);
    an.tiles.forEach((t, i) => {
      const el = $("#tile" + i);
      const p = proxy((v) => { el.textContent = FR && t[2] === " %" ? nf(Math.round(v)) + " %" : nf(Math.round(v)) + t[2]; });
      tl.fromTo(p, { v: 0 }, { v: t[1], duration: 1.5, ease: "power3.out" }, 40.3 + i * 0.06);
    });
    cue("counter", 40.3, 0.5, { dur: 1.3 });
    tl.fromTo($$("#v-analytics .dl"), { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.35, stagger: 0.06 }, 41.7);
    const retLine = $("#ret-line"), retLen = Math.ceil(pathLength(retD));
    retLine.style.strokeDasharray = retLen + " " + retLen;
    tl.fromTo(retLine, { strokeDashoffset: retLen }, { strokeDashoffset: 0, duration: 1.2, ease: "power2.inOut" }, 40.7);
    tl.fromTo("#ret-area", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 1.2, ease: "power2.inOut" }, 40.75);
    $$("#v-analytics .ret-dot").forEach((d, i) => tl.fromTo(d, { scale: 0, opacity: 0, transformOrigin: "50% 50%" }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2)" }, 40.72 + i * 0.12));
    tl.fromTo($$("#v-analytics .vbars i"), { scaleY: 0 }, { scaleY: 1, duration: 0.5, stagger: 0.03 }, 40.9);
    tl.fromTo($$("#v-analytics .chart"), { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.08 }, 40.2);
    tl.fromTo("#shield", { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.4 }, 42.2);
    cue("blip", 42.2, 0.6);

    // 07 · deploy (44–50) ----------------------------------------------------
    tl.to(winApp, { y: -60, scale: 0.94, duration: 0.32, ease: "power3.in" }, 43.68);
    tl.to(winApp, { opacity: 0, duration: 0.16, ease: "power1.in" }, 43.84);
    tl.fromTo("#term", { y: 230, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: "power4.out" }, 43.96);
    cue("whoosh_up", 43.8, 0.7);
    typeLine($("#tcmd"), 44.35, 1.15, 64);
    cue("typing", 44.35, 0.7, { dur: 1.15 });
    const cmdW = 64 * 21 * 0.6;
    tl.fromTo("#t-caret", { x: -cmdW }, { x: 0, duration: 1.15, ease: "steps(64)" }, 44.35);
    tl.set("#t-caret", { opacity: 0 }, 45.6);
    cue("enter", 45.55, 0.8);
    tl.fromTo("#tl1", { opacity: 0 }, { opacity: 1, duration: 0.1 }, 45.65);
    tl.fromTo("#tl2", { opacity: 0 }, { opacity: 1, duration: 0.1 }, 45.8);
    tl.fromTo("#pull-bar", { scaleX: 0 }, { scaleX: 1, duration: 0.72, ease: "power1.inOut" }, 45.82);
    tl.fromTo("#pull-ok", { opacity: 0 }, { opacity: 1, duration: 0.15 }, 46.55);
    cue("blip", 46.55, 0.45);
    logs.forEach((l, i) => {
      const t = 46.75 + i * 0.25;
      tl.fromTo("#tlog" + i, { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: 0.22 }, t);
      cue("confirm", t, 0.5, { i: i });
    });
    tl.fromTo("#tlive", { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: 0.3 }, 48.3);
    cue("done", 48.3, 0.8);
    blink("#t-caret2", 48.5, 49.9, 0.3);
    tl.fromTo("#stores-h", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 }, 48.45);
    tl.fromTo($$("#stores .store"), { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.45, stagger: 0.07 }, 48.55);
    [0, 1, 2, 3, 4].forEach((i) => cue("tick", 48.55 + i * 0.07, 0.4));
    // zoom-through into the second drop
    tl.to("#prod-wrap", { scale: 1.18, filter: "blur(10px)", duration: 0.24, ease: "power3.in" }, 49.76);
    tl.to("#prod-wrap", { opacity: 0.1, duration: 0.24, ease: "none" }, 49.76);
    cue("riser", 48.0, 0.8, { dur: 2.0 });

    // ── 11 · sovereignty (50–54) ────────────────────────────────────────────
    const sov = $("#s-sov");
    sov.innerHTML = `<div id="sov-wrap" class="fill">
      <div class="orbit" id="orb1"></div><div class="orbit o2" id="orb2"></div>
      <div class="sov-line" id="sovA" style="top:318px">${words(C.sovereignty.a)}</div>
      <div class="sov-line" id="sovB" style="top:508px">${words("{" + C.sovereignty.b + "}")}</div>
      <div id="sov-stat">${esc(C.sovereignty.stat).replace(/^100(\s| )?%/, '<b id="sov-num"></b>')}</div>
      <div id="sov-micro">${C.sovereignty.micro.map((m) => `<span><i></i>${esc(m)}</span>`).join("")}</div></div>`;
    tl.fromTo($$("#sovA .w"), { scale: 1.5, opacity: 0, filter: "blur(16px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "power4.out", stagger: 0.08 }, T.sov);
    cue("impact", T.sov, 1);
    tl.fromTo($$("#sovB .w"), { scale: 1.5, opacity: 0, filter: "blur(16px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "power4.out" }, T.sov + 0.5);
    cue("hit", T.sov + 0.5, 0.9);
    tl.fromTo(["#orb1", "#orb2"], { scale: 0.86, opacity: 0, rotation: -10 }, { scale: 1, opacity: 1, rotation: -6, duration: 1.4, ease: "power2.out", stagger: 0.1 }, T.sov);
    tl.to(["#orb1", "#orb2"], { rotation: -3, duration: 2.3, ease: "sine.inOut" }, T.sov + 1.4);
    const sovNum = $("#sov-num");
    if (sovNum) {
      const np = proxy((v) => { sovNum.textContent = pct(Math.round(v)); });
      tl.fromTo(np, { v: 0 }, { v: 100, duration: 0.7, ease: "power2.out" }, 51.3);
    }
    tl.fromTo("#sov-stat", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5 }, 51.3);
    cue("counter", 51.3, 0.45, { dur: 0.9 });
    tl.fromTo($$("#sov-micro span"), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.45, stagger: 0.1 }, 52.0);
    [0, 1, 2].forEach((i) => cue("tick", 52.0 + i * 0.1, 0.4));
    tl.to("#sovA", { y: -230, opacity: 0, duration: 0.3, ease: "power4.in" }, 53.7);
    tl.to("#sovB", { y: 230, opacity: 0, duration: 0.3, ease: "power4.in" }, 53.7);
    tl.to(["#sov-stat", "#sov-micro", "#orb1", "#orb2"], { opacity: 0, duration: 0.25, ease: "power2.in" }, 53.72);
    cue("swish", 53.75, 0.6);

    // ── 12 · offer (54–58) ──────────────────────────────────────────────────
    const of = C.offer;
    $("#s-offer").innerHTML = `<div id="offer-title">${words(of.title, { mask: true })}</div>
      <div class="card" id="card-self" style="left:356px">
        <div class="ck">${I.server}${esc(of.selfName)}</div>
        <div class="price">${esc(of.selfPrice)}</div>
        <ul>${of.selfPoints.map((p) => `<li>${I.check}${esc(p)}</li>`).join("")}</ul>
        <div class="foot"><span class="pr">$</span>docker run synapsr/hovod</div></div>
      <div class="card hot" id="card-cloud" style="left:984px">
        <div class="ck">${I.cloud}${esc(of.cloudName)}</div>
        <div class="price">${esc(of.cloudPrice)}<small>${esc(of.cloudPer)}</small></div>
        <ul>${of.cloudPoints.map((p) => `<li>${I.check}${esc(p)}</li>`).join("")}</ul>
        <div class="foot">hovod.dev</div></div>`;
    rise($$("#offer-title .w"), T.offer, { stagger: 0.05, dur: 0.7 });
    tl.fromTo("#card-self", { x: 300, opacity: 0, scale: 0.92, filter: "blur(10px)" }, { x: 0, opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.7, ease: "power4.out" }, T.offer + 0.1);
    tl.fromTo("#card-cloud", { x: -300, opacity: 0, scale: 0.92, filter: "blur(10px)" }, { x: 0, opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.7, ease: "power4.out" }, T.offer + 0.1);
    cue("whoosh", T.offer, 0.7);
    ["#card-self", "#card-cloud"].forEach((c, k) => {
      const card = $(c);
      tl.fromTo([$(".ck", card), $(".price", card)], { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.45, stagger: 0.08 }, 54.35 + k * 0.1);
      tl.fromTo($$("li", card), { opacity: 0, x: -12 }, { opacity: 1, x: 0, duration: 0.4, stagger: 0.08 }, 54.6 + k * 0.1);
      tl.fromTo($(".foot", card), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.4 }, 54.95 + k * 0.1);
    });
    [54.6, 54.7, 54.8].forEach((t) => cue("tick", t, 0.4));
    tl.to("#card-self", { x: 290, scale: 0.8, opacity: 0, filter: "blur(10px)", duration: 0.34, ease: "power3.in" }, 57.66);
    tl.to("#card-cloud", { x: -290, scale: 0.8, opacity: 0, filter: "blur(10px)", duration: 0.34, ease: "power3.in" }, 57.66);
    drop($$("#offer-title .w"), 57.66, { to: -118, dur: 0.3, stagger: 0.015 });
    cue("suck", 57.7, 0.5);

    // ── 13 · end card (58–64) ───────────────────────────────────────────────
    const endPromise = FR ? "La plateforme vidéo qui {vous appartient.}" : "The video platform that belongs {to you.}";
    $("#s-end").innerHTML = `<div class="flash" id="flash2"></div>
      <div class="logo-tile" id="end-tile">${I.play}<span class="sheen" id="end-sheen"></span></div>
      <div id="end-word">${wmHtml}</div>
      <div id="end-promise">${words(endPromise, { mask: true })}</div>
      <div id="end-row">
        <span class="pill site">hovod.dev</span>
        <span class="pill cmd"><span class="pr">$</span>docker run synapsr/hovod<span class="caret" id="end-caret" style="width:10px;height:24px"></span></span>
        <span class="pill gh">${I.star}github.com/Synapsr/Hovod</span>
      </div>
      <div id="end-by">${esc(C.end.by)}<img src="assets/img/synapsr.svg" alt="Synapsr"></div>`;
    const ewW = measure("Hovod", "font:680 136px/1 var(--sans);letter-spacing:-0.045em;white-space:nowrap").w;
    const eT = 128, eGap = 32, eX = 960 - (eT + eGap + ewW) / 2, eCY = 392;
    Object.assign($("#end-tile").style, { width: px(eT), height: px(eT), borderRadius: px(eT * 0.25), left: px(eX), top: px(eCY - eT / 2) });
    Object.assign($("#end-word").style, { left: px(eX + eT + eGap), top: px(eCY - 68 - 5) });
    gsap.set("#flash2", { x: eX + eT / 2 - 960, y: eCY - 540 });
    tl.fromTo("#flash2", { scale: 0.15, opacity: 0.9 }, { scale: 1, opacity: 0, duration: 0.9, ease: "power2.out" }, T.end);
    tl.fromTo("#end-tile", { scale: 0.4, rotation: -14, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.7, ease: "power4.out" }, T.end);
    cue("impact", T.end, 0.9);
    tl.fromTo("#end-sheen", { left: "-80%" }, { left: "150%", duration: 0.8, ease: "power2.inOut" }, T.end + 0.4);
    cue("shimmer", T.end + 0.4, 0.5);
    rise($$("#end-word .w"), T.end + 0.25, { stagger: 0.04, dur: 0.65 });
    rise($$("#end-promise .w"), T.end + 0.7, { stagger: 0.035, dur: 0.7 });
    tl.fromTo($$("#end-row .pill"), { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.55, stagger: 0.1 }, T.end + 1.2);
    [0, 1, 2].forEach((i) => cue("tick", T.end + 1.2 + i * 0.1, 0.45));
    tl.fromTo("#end-by", { opacity: 0 }, { opacity: 1, duration: 0.6 }, T.end + 1.8);
    blink("#end-caret", T.end + 1.8, T.total, 0.5);

    // ── register ────────────────────────────────────────────────────────────
    cues.sort((a, b) => a.t - b.t);
    const out = document.createElement("script");
    out.type = "application/json";
    out.id = "hovod-cues";
    out.textContent = JSON.stringify({ lang: LANG, bpm: 120, duration: T.total, sections: T, cues: cues });
    document.body.appendChild(out);
    window.__hovodCues = cues;
    if (window.__hovodRegister) window.__hovodRegister(tl);
    else { window.__timelines = window.__timelines || {}; window.__timelines.main = tl; }
    tl.seek(0);
  }

  const fontsReady = document.fonts && document.fonts.load
    ? Promise.all([
      document.fonts.load('700 100px "Inter Film"'),
      document.fonts.load('400 20px "Inter Film"'),
      document.fonts.load('400 20px "JetBrains Mono Film"'),
      document.fonts.load('700 20px "JetBrains Mono Film"'),
    ]).catch(() => null)
    : Promise.resolve();
  fontsReady.then(() => {
    try { build(); } catch (e) { console.error("[hovod-film]", e && e.stack ? e.stack : e); throw e; }
  });
})();
