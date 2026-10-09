(function () {
  "use strict";
  var PG = window.PG;
  var NS = "http://www.w3.org/2000/svg";
  var DATA = null, CUR = null, FILTER = "all";
  var REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- tiny DOM helpers (textContent only: documents are untrusted) ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") el.className = attrs[k]; else if (k === "text") el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }
  function s(tag, attrs, text) {
    var el = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    if (text != null) el.textContent = text;
    return el;
  }
  function $(id) { return document.getElementById(id); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  // ---------- number helpers (display only; all math comes from the pipeline) ----------
  function simple(logret) { return (Math.exp(logret) - 1) * 100; }
  function dir(v) { return v > 0 ? "up" : v < 0 ? "down" : "flat"; }
  // signed move with a shape, so direction never depends on color alone
  function moveEl(logret, digits, tag) {
    if (logret == null || isNaN(logret)) return h(tag || "span", { class: "mv flat", text: "n/a" });
    var p = simple(logret), d = dir(Math.round(p * 100));
    return h(tag || "span", { class: "mv " + d },
      h("span", { class: "mv-g", "aria-hidden": "true", text: d === "up" ? "▲" : d === "down" ? "▼" : "◆" }),
      PG.pct(logret, digits).replace("-", "−"));
  }
  function pctTxt(logret, digits) { return PG.pct(logret, digits).replace("-", "−"); }
  function ratioTxt(r) { return r == null ? "n/a" : Math.round(r * 100) + "%"; }
  function etTime(ev) { return ev.pub_et.slice(11, 16); }
  function session(ev) {
    var t = ev.pub_et.slice(11, 16), m = +t.slice(0, 2) * 60 + +t.slice(3, 5);
    if (m >= 960) return { k: "AMC", long: "after the close" };
    if (m < 570) return { k: "BMO", long: "before the open" };
    return { k: "MKT", long: "during market hours" };
  }
  function etClock(min) { // minutes after the 16:00 ET close -> ET wall clock
    var t = Math.round(960 + min) % 1440, hh = Math.floor(t / 60), mm = t % 60;
    return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
  }
  function measured(e) { return e.reaction && e.reaction.ok && e.reaction.path && e.reaction.path.length; }
  function shortId(e) { return e.ticker + " " + e.filing_date.slice(5); }

  // ---------- load ----------
  // Served by pg.serve: the live API. Served as plain static files: the committed snapshot.
  function getJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
  }
  getJSON("api/events").catch(function () { return getJSON("data/events.json"); })
    .then(function (d) { DATA = d; init(); })
    .catch(function (e) { showEmpty("Could not load the data file", "The data failed to load (" + e.message + "). If you opened this page from disk, run the server instead: python -m pg.serve"); });

  function showEmpty(title, body) {
    var box = $("empty");
    clear(box);
    box.appendChild(h("p", { class: "kicker", text: "No data" }));
    box.appendChild(h("h2", { text: title }));
    box.appendChild(h("p", { text: body }));
    box.hidden = false;
    $("view").hidden = true;
  }

  function init() {
    renderTape();
    if (!DATA.events.length) {
      showEmpty("No earnings releases loaded yet",
        "The data pipeline has not produced any releases. Run the 'Fetch data' workflow in GitHub Actions, then rebuild the site. Nothing on this page is made up to fill the gap.");
      return;
    }
    $("n-all").textContent = DATA.events.length;
    $("n-ok").textContent = DATA.events.filter(measured).length;
    $("f-all").addEventListener("click", function () { setFilter("all"); });
    $("f-ok").addEventListener("click", function () { setFilter("ok"); });
    renderRail();
    var first = DATA.events.filter(measured)[0] || DATA.events[0];
    var hash = decodeURIComponent((location.hash || "").slice(1));
    var start = DATA.events.filter(function (e) { return e.id === hash; })[0] || first;
    select(start.id, false);
    window.addEventListener("hashchange", function () {
      var id = decodeURIComponent((location.hash || "").slice(1));
      if (CUR && id !== CUR.id && DATA.events.some(function (e) { return e.id === id; })) select(id, false);
    });
    var fb = $("foot-build");
    fb.textContent = "Build " + (DATA.generated_at_utc || "").slice(0, 16).replace("T", " ") + " UTC. Filings fetched " +
      ((DATA.fetch && DATA.fetch.fetched_at_utc) || "unknown").slice(0, 10) + ". Prices: " + DATA.price_data.source + ".";
  }

  // ---------- masthead tape: dataset-level facts ----------
  function renderTape() {
    var t = $("tape"); clear(t);
    var A = DATA.analogs || {}, acc = DATA.accuracy_total || {};
    var rejected = (acc.quote_rejected || 0) + (acc.xbrl_mismatch || 0);
    var items = [
      ["Releases", String(DATA.n_events), ""],
      ["Nights measured", (A.n_valid || 0) + "/" + (A.n_events || DATA.n_events), "amber"],
      ["XBRL match", (acc.xbrl_match || 0) + "/" + (acc.xbrl_checked || 0), "ok"],
      ["Quotes rejected", String(rejected), rejected ? "bad" : ""],
      ["Median priced in", A.median_priced_in != null ? Math.round(A.median_priced_in * 100) + "%" : "n/a", "amber"],
      ["Direction matched", A.n_sign ? Math.round(A.sign_agreement * A.n_sign) + "/" + A.n_sign : "n/a", ""],
      ["Extraction model", (DATA.extraction_models || []).join(", ") || "none", "dim"],
    ];
    items.forEach(function (it) {
      t.appendChild(h("div", { class: "tp " + it[2] }, h("dt", { text: it[0] }), h("dd", { text: it[1] })));
    });
  }

  // ---------- rail: list of releases ----------
  function setFilter(f) {
    FILTER = f;
    $("f-all").setAttribute("aria-pressed", f === "all" ? "true" : "false");
    $("f-ok").setAttribute("aria-pressed", f === "ok" ? "true" : "false");
    renderRail();
  }

  function spark(ev) {
    var W = 72, H = 22, svg = s("svg", { viewBox: "0 0 " + W + " " + H, class: "spark", "aria-hidden": "true" });
    var r = ev.reaction;
    if (!measured(ev)) {
      svg.appendChild(s("line", { x1: 2, x2: W - 2, y1: H / 2, y2: H / 2, class: "sp-none" }));
      return svg;
    }
    var ys = r.path.map(function (p) { return p[1]; }).concat([0, simple(r.cash_gap)]);
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys), sp = (hi - lo) || 1;
    var X = function (m) { return 2 + (m / r.open_minute) * (W - 8); }, Y = function (v) { return H - 3 - ((v - lo) / sp) * (H - 6); };
    svg.appendChild(s("line", { x1: 2, x2: W - 2, y1: Y(0), y2: Y(0), class: "sp-zero" }));
    svg.appendChild(s("line", { x1: X(r.pub_minute), x2: X(r.pub_minute), y1: 1, y2: H - 1, class: "sp-pub" }));
    svg.appendChild(s("path", { d: r.path.map(function (p, i) { return (i ? "L" : "M") + X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1); }).join(" "), class: "sp-line" }));
    var cy = Y(simple(r.cash_gap));
    svg.appendChild(s("path", { d: "M" + (W - 3) + " " + (cy - 3) + "l3 3l-3 3l-3 -3z", class: "sp-cash" }));
    return svg;
  }

  function renderRail() {
    var nav = $("events"); clear(nav);
    var list = DATA.events.filter(function (e) { return FILTER === "all" || measured(e); });
    var lastMonth = "";
    list.forEach(function (ev) {
      var mo = ev.filing_date.slice(0, 7);
      if (mo !== lastMonth) {
        lastMonth = mo;
        var d = new Date(mo + "-01T12:00:00Z");
        nav.appendChild(h("p", { class: "mo", "aria-hidden": "true", text: d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) }));
      }
      var r = ev.reaction, ok = measured(ev), ss = session(ev);
      var b = h("button", { type: "button", "data-id": ev.id, class: "ev" + (ok ? "" : " ev-off"),
        "aria-label": ev.ticker + ", " + ev.filing_date + ", released " + etTime(ev) + " ET " + ss.long + ". " +
          (ok ? "Priced in " + ratioTxt(r.priced_in) + "." : "Not measured: " + ((r && r.reason) || "no price data") + ".") },
        h("span", { class: "ev-t", text: ev.ticker }),
        h("span", { class: "ev-d", text: ev.filing_date.slice(5).replace("-", "/") }),
        h("span", { class: "ev-s s-" + ss.k.toLowerCase(), title: "Released " + etTime(ev) + " ET, " + ss.long, text: ss.k + " " + etTime(ev) }),
        spark(ev),
        ok ? h("span", { class: "ev-r", text: ratioTxt(r.priced_in) }) : h("span", { class: "ev-r none", text: "—" }),
        ok ? null : h("span", { class: "ev-why", text: (r && r.reason) || "no price data" }));
      b.addEventListener("click", function () { select(ev.id, true); });
      b.addEventListener("keydown", railKeys);
      nav.appendChild(b);
    });
    markCurrent();
  }
  function railKeys(e) {
    if (["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].indexOf(e.key) < 0) return;
    var bs = Array.prototype.slice.call($("events").querySelectorAll("button.ev"));
    var i = bs.indexOf(e.currentTarget), n = bs.length;
    var j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (e.key === "ArrowDown" || e.key === "ArrowRight") ? Math.min(n - 1, i + 1) : Math.max(0, i - 1);
    if (j === i) return;
    e.preventDefault();
    bs[j].focus(); bs[j].click();
  }
  function markCurrent() {
    Array.prototype.forEach.call($("events").querySelectorAll("button.ev"), function (b) {
      var on = CUR && b.getAttribute("data-id") === CUR.id;
      b.setAttribute("aria-current", on ? "true" : "false");
      if (on && b.scrollIntoView) {
        var nav = $("events"), horiz = nav.scrollWidth > nav.clientWidth + 4;
        if (horiz) nav.scrollLeft = b.offsetLeft - nav.clientWidth / 2 + b.offsetWidth / 2;
      }
    });
  }

  function select(id, user) {
    CUR = DATA.events.filter(function (e) { return e.id === id; })[0];
    if (!CUR) return;
    history.replaceState(null, "", "#" + encodeURIComponent(id));
    markCurrent();
    $("empty").hidden = true;
    $("view").hidden = false;
    renderHead(); renderNight(true); renderClaims(); renderGap(); renderAnalogs(); renderEvidence();
    if (window.PGChat) window.PGChat.setEvent(CUR);
    $("memo-out").hidden = $("memo-copy").hidden = $("memo-dl").hidden = true;
    document.title = CUR.ticker + " " + CUR.filing_date + " · PrintGap";
    if (user && window.innerWidth < 900) {
      var top = $("main").getBoundingClientRect().top + window.scrollY - 8;
      if (window.scrollY > top) window.scrollTo({ top: top, behavior: REDUCED ? "auto" : "smooth" });
    }
  }

  // ---------- event header ----------
  function renderHead() {
    var ev = CUR, ss = session(ev);
    $("ev-title").textContent = ev.ticker;
    $("ev-company").textContent = ev.company || "";
    $("ev-period").textContent = ev.period_label || ("Filed " + ev.filing_date);
    var m = $("ev-meta"); clear(m);
    m.appendChild(h("li", null, h("span", { class: "k", text: "8-K accepted" }), h("span", { class: "v", text: ev.pub_et.slice(0, 16) + " ET" }), h("span", { class: "chip s-" + ss.k.toLowerCase(), text: ss.k })));
    m.appendChild(h("li", null, h("span", { class: "k", text: "SEC filing" }),
      h("a", { class: "v", href: ev.url, rel: "noopener", target: "_blank", text: ev.accession + " ↗" })));
    if (ev.sha256_raw) m.appendChild(h("li", null, h("span", { class: "k", text: "Doc sha256" }), h("span", { class: "v dim", title: ev.sha256_raw, text: ev.sha256_raw.slice(0, 8) + "…" + ev.sha256_raw.slice(-4) })));
    if (ev.extraction && ev.extraction.model) m.appendChild(h("li", null, h("span", { class: "k", text: "Copied by" }), h("span", { class: "v dim", text: ev.extraction.model })));
    var head = PG.headline(ev);
    $("hero-h").textContent = head || (ev.ticker + " released results " + ev.pub_et + ". The overnight reaction could not be measured; the reason is shown below.");
  }

  // ---------- the overnight window ----------
  var CH = null; // current chart state for scrubbing

  function renderNight(animate) {
    var ev = CUR, r = ev.reaction;
    var sub = $("hero-sub");
    if (measured(ev)) sub.textContent = r.base_day + " 16:00 → " + r.target_day + " 09:30 ET · " + PG.hours(r.open_minute) + " with the cash market shut";
    else sub.textContent = "not measured";
    drawChart(animate);
    renderReadout();
    var cap = $("chart-cap");
    if (measured(ev)) {
      cap.textContent = "Amber line: last price of r" + ev.ticker + " on Bitget 15-minute candles, as change vs the 16:00 ET close. Blue diamond: where the cash stock opened at 09:30 ET. " +
        "Dashed link: what the rToken still had to move when the open arrived (" + pctTxt(r.residual) + "). " +
        "The white marker is the SEC acceptance time of the 8-K; companies can put the release on the wire a little earlier, so part of the “before” move may already be the news.";
    } else cap.textContent = "";
  }

  function chartSize() {
    var fig = $("chart-fig"), W = Math.max(300, Math.round(fig.clientWidth));
    var narrow = W < 620;
    return { W: W, H: narrow ? 300 : 380, narrow: narrow,
      pad: narrow ? { l: 42, r: 46, t: 50, b: 44 } : { l: 54, r: 108, t: 54, b: 60 } };
  }

  function drawChart(animate) {
    var svg = $("timeline"); clear(svg);
    var ev = CUR, r = ev.reaction, sz = chartSize(), W = sz.W, H = sz.H;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    CH = null;
    if (!measured(ev)) { drawEmptyWindow(svg, sz, r); return; }

    var g = PG.chartGeometry(r, W, H, sz.pad);
    svg.setAttribute("aria-label", PG.headline(ev) || "Overnight rToken path");
    svg.setAttribute("tabindex", "0");
    var defs = s("defs");
    var cpPre = s("clipPath", { id: "cp-pre" }); cpPre.appendChild(s("rect", { x: 0, y: 0, width: g.pubX, height: H }));
    var cpPost = s("clipPath", { id: "cp-post" }); cpPost.appendChild(s("rect", { x: g.pubX, y: 0, width: W - g.pubX, height: H }));
    var hatch = s("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
    hatch.appendChild(s("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "hatch-l" }));
    defs.appendChild(cpPre); defs.appendChild(cpPost); defs.appendChild(hatch);
    svg.appendChild(defs);

    // plot field + session bands (US extended-hours convention; the regular session is closed throughout)
    svg.appendChild(s("rect", { x: g.x0, y: g.y0, width: g.x1 - g.x0, height: g.y1 - g.y0, class: "field" }));
    var bands = [[0, 240, "after-hours"], [240, 720, "overnight"], [720, r.open_minute, "pre-market"]];
    bands.forEach(function (b, i) {
      var xa = g.X(b[0]), xb = g.X(b[1]);
      svg.appendChild(s("rect", { x: xa, y: g.y1 + 30, width: Math.max(0, xb - xa - 2), height: 3, class: "band b" + i }));
      if (!sz.narrow) svg.appendChild(s("text", { x: xa + 2, y: g.y1 + 46, class: "band-t" }, b[2].toUpperCase()));
    });

    // y grid
    var step = niceStep((g.hi - g.lo) / (sz.narrow ? 4 : 5));
    for (var v = Math.ceil(g.lo / step) * step; v <= g.hi + 1e-9; v += step) {
      var y = g.Y(v), vv = Math.abs(v) < 1e-9 ? 0 : v;
      svg.appendChild(s("line", { x1: g.x0, x2: g.x1, y1: y, y2: y, class: "grid" }));
      svg.appendChild(s("text", { x: g.x0 - 8, y: y + 4, "text-anchor": "end", class: "ax" }, (vv > 0 ? "+" : vv < 0 ? "−" : "") + Math.abs(vv).toFixed(step < 1 ? 1 : 0) + "%"));
    }
    svg.appendChild(s("line", { x1: g.x0, x2: g.x1, y1: g.zeroY, y2: g.zeroY, class: "zero" }));

    // x ticks in ET (the window is defined in ET)
    var tstep = sz.narrow ? 240 : 120;
    for (var m = 0; m <= r.open_minute; m += tstep) {
      var x = g.X(m);
      if (g.openX - x < (sz.narrow ? 34 : 40) && m > 0) continue;
      svg.appendChild(s("line", { x1: x, x2: x, y1: g.y1, y2: g.y1 + 5, class: "tick" }));
      svg.appendChild(s("text", { x: x, y: g.y1 + 19, "text-anchor": m === 0 ? "start" : "middle", class: "ax" }, etClock(m)));
    }
    svg.appendChild(s("text", { x: g.openX, y: g.y1 + 19, "text-anchor": "middle", class: "ax strong" }, "09:30"));

    // area + line, split at the 8-K
    var pts = g.points;
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    var area = d + " L" + pts[pts.length - 1][0].toFixed(1) + " " + g.zeroY.toFixed(1) + " L" + pts[0][0].toFixed(1) + " " + g.zeroY.toFixed(1) + " Z";
    svg.appendChild(s("path", { d: area, class: "area pre", "clip-path": "url(#cp-pre)" }));
    svg.appendChild(s("path", { d: area, class: "area post", "clip-path": "url(#cp-post)" }));
    var linePre = s("path", { d: d, class: "line pre", "clip-path": "url(#cp-pre)" });
    var linePost = s("path", { d: d, class: "line post", "clip-path": "url(#cp-post)" });
    svg.appendChild(linePre); svg.appendChild(linePost);

    // segment labels: before / after the 8-K
    var lblY = g.y0 - 30;
    function segLabel(xa, xb, title, val) {
      var w = xb - xa;
      if (w < (sz.narrow ? 74 : 104)) return;
      var gg = s("g", { class: "seg-l" });
      gg.appendChild(s("line", { x1: xa + 2, x2: xb - 2, y1: lblY + 8, y2: lblY + 8, class: "seg-rule" }));
      gg.appendChild(s("text", { x: (xa + xb) / 2, y: lblY + 2, "text-anchor": "middle" }, title + " " + pctTxt(val)));
      svg.appendChild(gg);
    }
    segLabel(g.x0, g.pubX, "BEFORE 8-K", r.rt_pre_pub);
    segLabel(g.pubX, g.openX, "AFTER 8-K", r.rt_post_pub);

    // 8-K marker
    svg.appendChild(s("line", { x1: g.pubX, x2: g.pubX, y1: g.y0 - 14, y2: g.y1, class: "pub" }));
    var flip = g.pubX > (g.x0 + g.x1) / 2;
    var pubTxt = "8-K " + etTime(CUR);
    var tw = pubTxt.length * 7 + 12;
    var tx = flip ? g.pubX - tw : g.pubX;
    svg.appendChild(s("rect", { x: tx, y: g.y0 - 14, width: tw, height: 16, class: "pub-tag" }));
    svg.appendChild(s("text", { x: tx + 6, y: g.y0 - 2, class: "pub-t" }, pubTxt));

    // the open
    svg.appendChild(s("line", { x1: g.openX, x2: g.openX, y1: g.y0 - 14, y2: g.y1, class: "open" }));
    if (!sz.narrow) svg.appendChild(s("text", { x: g.openX + 6, y: g.y0 - 2, class: "open-t" }, "CASH OPEN"));

    // residual link, rToken end, cash open diamond
    var last = pts[pts.length - 1];
    svg.appendChild(s("line", { x1: last[0], x2: g.openX, y1: last[1], y2: g.cashY, class: "resid" }));
    var dot = s("circle", { cx: last[0], cy: last[1], r: 4.5, class: "end" });
    svg.appendChild(dot);
    svg.appendChild(s("path", { d: "M" + g.openX + " " + (g.cashY - 7) + " l7 7 l-7 7 l-7 -7 Z", class: "cash" }));

    // gap bracket: how much of the cash gap the rToken covered
    var bx = g.openX + (sz.narrow ? 20 : 28);
    var rtY = g.Y(simple(r.rt_move));
    svg.appendChild(s("line", { x1: bx, x2: bx, y1: g.zeroY, y2: g.cashY, class: "brk-cash" }));
    svg.appendChild(s("line", { x1: bx - 4, x2: bx + 4, y1: g.cashY, y2: g.cashY, class: "brk-cash" }));
    svg.appendChild(s("line", { x1: bx - 4, x2: bx + 4, y1: g.zeroY, y2: g.zeroY, class: "brk-cash" }));
    svg.appendChild(s("line", { x1: bx - 7, x2: bx - 7, y1: g.zeroY, y2: rtY, class: "brk-rt" }));
    if (!sz.narrow) {
      var midY = (g.zeroY + g.cashY) / 2;
      svg.appendChild(s("text", { x: bx + 10, y: midY - 2, class: "brk-v" }, ratioTxt(r.priced_in)));
      svg.appendChild(s("text", { x: bx + 10, y: midY + 13, class: "brk-k" }, "PRICED IN"));
    }

    // scrub layer
    var cross = s("g", { class: "cross", visibility: "hidden" });
    var cl = s("line", { y1: g.y0, y2: g.y1, class: "cross-l" });
    var cd = s("circle", { r: 4, class: "cross-d" });
    var cbox = s("rect", { height: 20, class: "cross-box" });
    var ct = s("text", { class: "cross-t" });
    cross.appendChild(cl); cross.appendChild(cd); cross.appendChild(cbox); cross.appendChild(ct);
    svg.appendChild(cross);
    var hit = s("rect", { x: g.x0, y: g.y0 - 20, width: g.x1 - g.x0, height: g.y1 - g.y0 + 20, class: "hit" });
    svg.appendChild(hit);
    CH = { g: g, r: r, cross: cross, cl: cl, cd: cd, cbox: cbox, ct: ct, idx: null, W: W };
    hit.addEventListener("pointermove", function (e) {
      var rect = svg.getBoundingClientRect(), px = (e.clientX - rect.left) * (W / rect.width);
      var best = 0, bd = Infinity;
      pts.forEach(function (p, i) { var dd = Math.abs(p[0] - px); if (dd < bd) { bd = dd; best = i; } });
      scrubTo(best);
    });
    hit.addEventListener("pointerleave", function () { scrubTo(null); });
    scrubHint();

    if (animate && !REDUCED && linePost.getTotalLength) {
      [linePre, linePost].forEach(function (p) {
        var L = p.getTotalLength();
        p.style.strokeDasharray = L + " " + L; p.style.strokeDashoffset = L;
        p.getBoundingClientRect();
        p.style.transition = "stroke-dashoffset 900ms cubic-bezier(.3,.7,.2,1)";
        p.style.strokeDashoffset = "0";
        setTimeout(function () { p.style.strokeDasharray = ""; p.style.transition = ""; }, 1000);
      });
      svg.classList.remove("in"); svg.getBoundingClientRect(); svg.classList.add("in");
    }
  }

  function drawEmptyWindow(svg, sz, r) {
    var W = sz.W, H = Math.min(sz.H, 240), p = sz.pad;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("height", H);
    svg.removeAttribute("tabindex");
    var reason = (r && r.reason) || "no price data for this release";
    svg.setAttribute("aria-label", "Overnight window not measured: " + reason);
    var defs = s("defs"), hatch = s("pattern", { id: "hatch", width: 7, height: 7, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
    hatch.appendChild(s("line", { x1: 0, y1: 0, x2: 0, y2: 7, class: "hatch-l" })); defs.appendChild(hatch); svg.appendChild(defs);
    var x0 = p.l, x1 = W - p.r, y0 = 24, y1 = H - 40;
    svg.appendChild(s("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: "void" }));
    var span = 1050;
    for (var m = 0; m <= span; m += sz.narrow ? 240 : 120) {
      var x = x0 + (m / span) * (x1 - x0);
      if (x1 - x < 36 && m > 0) continue;
      svg.appendChild(s("text", { x: x, y: y1 + 18, "text-anchor": m === 0 ? "start" : "middle", class: "ax" }, etClock(m)));
    }
    svg.appendChild(s("text", { x: x1, y: y1 + 18, "text-anchor": "middle", class: "ax strong" }, "09:30"));
    svg.appendChild(s("text", { x: (x0 + x1) / 2, y: (y0 + y1) / 2 - 4, "text-anchor": "middle", class: "void-h" }, "NO PATH MEASURED"));
    svg.appendChild(s("text", { x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 16, "text-anchor": "middle", class: "void-t" }, reason));
    $("scrub").textContent = "";
  }

  function scrubHint() {
    $("scrub").textContent = "Hover the chart, or focus it and use ← →, to read any 15-minute candle.";
  }
  function scrubTo(i) {
    if (!CH) return;
    CH.idx = i;
    if (i == null) { CH.cross.setAttribute("visibility", "hidden"); scrubHint(); return; }
    var p = CH.r.path[i], pt = CH.g.points[i], g = CH.g;
    CH.cross.setAttribute("visibility", "visible");
    CH.cl.setAttribute("x1", pt[0]); CH.cl.setAttribute("x2", pt[0]);
    CH.cd.setAttribute("cx", pt[0]); CH.cd.setAttribute("cy", pt[1]);
    var val = (p[1] > 0 ? "+" : p[1] < 0 ? "−" : "") + Math.abs(p[1]).toFixed(2) + "%";
    var label = etClock(p[0]) + " ET  " + val;
    var w = label.length * 7 + 14, bx = Math.min(Math.max(pt[0] - w / 2, g.x0), g.x1 - w);
    CH.cbox.setAttribute("x", bx); CH.cbox.setAttribute("y", g.y1 - 26); CH.cbox.setAttribute("width", w);
    CH.ct.setAttribute("x", bx + 7); CH.ct.setAttribute("y", g.y1 - 12); CH.ct.textContent = label;
    var rel = p[0] < CH.r.pub_minute ? PG.hours(CH.r.pub_minute - p[0]) + " before the 8-K" : PG.hours(p[0] - CH.r.pub_minute) + " after the 8-K";
    $("scrub").textContent = etClock(p[0]) + " ET · r" + CUR.ticker + " " + val + " vs the 16:00 close · " + rel;
  }
  $("timeline").addEventListener("keydown", function (e) {
    if (!CH) return;
    var n = CH.r.path.length, i = CH.idx == null ? n - 1 : CH.idx;
    if (e.key === "ArrowRight") i = Math.min(n - 1, i + (CH.idx == null ? 0 : 1));
    else if (e.key === "ArrowLeft") i = Math.max(0, i - (CH.idx == null ? 0 : 1));
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = n - 1;
    else if (e.key === "Escape") { scrubTo(null); return; }
    else return;
    e.preventDefault(); scrubTo(i);
  });
  $("timeline").addEventListener("blur", function () { scrubTo(null); });

  var lastW = 0, rz = null;
  if (window.ResizeObserver) {
    new ResizeObserver(function () {
      var w = Math.round($("chart-fig").clientWidth);
      if (!CUR || w === lastW) return;
      lastW = w;
      cancelAnimationFrame(rz); rz = requestAnimationFrame(function () { drawChart(false); });
    }).observe($("chart-fig"));
  }

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  // ---------- readout next to the chart ----------
  function renderReadout() {
    var box = $("readout"), ev = CUR, r = ev.reaction; clear(box);
    if (!measured(ev)) {
      box.className = "readout off";
      box.appendChild(h("p", { class: "ro-k", text: "Priced in" }));
      box.appendChild(h("p", { class: "ro-big none", text: "n/a" }));
      box.appendChild(h("p", { class: "ro-why" }, h("strong", { text: "Not measured. " }), "Reason recorded by the pipeline: ", h("span", { class: "mono", text: (r && r.reason) || "no price data" }), "."));
      box.appendChild(h("p", { class: "ro-note", text: "Measuring a night needs the rToken's 15-minute candles from the 16:00 ET close to the next open, plus the cash stock's prior close and its next opening price. Without all three, PrintGap shows nothing rather than an estimate." }));
      return;
    }
    box.className = "readout";
    var hasRatio = r.priced_in != null;
    box.appendChild(h("p", { class: "ro-k", text: "Priced in by 09:25 ET" }));
    box.appendChild(h("p", { class: "ro-big" + (hasRatio ? "" : " none"), text: hasRatio ? ratioTxt(r.priced_in) : "n/a" }));
    if (hasRatio) {
      // meter: 0..150%, with the full-gap mark at 100%
      var f = Math.max(0, Math.min(1.5, r.priced_in)) / 1.5 * 100;
      var meter = h("div", { class: "meter", role: "img", "aria-label": "rToken move covered " + ratioTxt(r.priced_in) + " of the stock's opening gap" },
        h("span", { class: "meter-fill" + (r.priced_in > 1 ? " over" : ""), style: "width:" + f.toFixed(1) + "%" }),
        h("span", { class: "meter-full", style: "left:" + (100 / 1.5).toFixed(2) + "%" }));
      box.appendChild(meter);
      box.appendChild(h("p", { class: "meter-l" }, h("span", { text: "0" }), h("span", { class: "ml-full", text: "full gap" }), h("span", { text: "150%" })));
      box.appendChild(h("p", { class: "ro-sub", text: r.priced_in > 1 ? "The rToken moved further than the stock gapped: it overshot." : "Share of the stock's opening gap the rToken had already moved." }));
    } else {
      box.appendChild(h("p", { class: "ro-sub", text: "The opening gap is under 0.5%, too small for a ratio to mean anything." }));
    }
    var dl = h("dl", { class: "ro-list" });
    function row(cls, label, valEl, sw) {
      dl.appendChild(h("div", { class: "ro-row " + cls }, h("dt", null, sw ? h("span", { class: "sw " + sw, "aria-hidden": "true" }) : null, label), h("dd", null, valEl)));
    }
    row("", "r" + ev.ticker + " overnight", moveEl(r.rt_move), "sw-rt");
    row("sub", "before the 8-K", moveEl(r.rt_pre_pub), null);
    row("sub", "after the 8-K", moveEl(r.rt_post_pub), null);
    row("", "Stock opening gap", moveEl(r.cash_gap), "sw-cash");
    row("", "Left for the open", moveEl(r.residual), "sw-resid");
    box.appendChild(dl);
    box.appendChild(h("p", { class: "ro-agree " + (r.sign_agrees ? "yes" : "no") },
      h("span", { "aria-hidden": "true", text: r.sign_agrees ? "✓ " : "✕ " }),
      r.sign_agrees ? "rToken and stock moved the same direction" : "rToken and stock moved in opposite directions"));
    box.appendChild(h("p", { class: "ro-px" },
      "r" + ev.ticker + " " + r.rt_close.toFixed(2) + " → " + r.rt_preopen.toFixed(2), h("br"),
      "stock " + r.cash_close.toFixed(2) + " → " + r.cash_open.toFixed(2) + " open"));
    box.appendChild(h("p", { class: "ro-warn" }, h("strong", { text: "Thin book. " }), "Overnight rToken liquidity is low; a price on screen is not a fill."));
  }

  // ---------- verification ledger ----------
  var CHECKS = [
    ["quote", "Quote", "quote found character for character in the release"],
    ["num", "Number", "number appears inside the quote"],
    ["xbrl", "XBRL", "matches the SEC XBRL company fact"],
  ];
  function checkState(c, k) {
    var ck = c.checks || {};
    if (k === "quote") return ck.quote_in_document === true ? "pass" : ck.quote_in_document === false ? "fail" : "skip";
    if (k === "num") return ck.number_in_quote === true ? "pass" : ck.number_in_quote === false ? "fail" : "skip";
    if (ck.xbrl === "match") return "pass";
    if (ck.xbrl === "mismatch") return "fail";
    if (c.status === "rejected") return "skip";
    if (ck.xbrl === "unavailable") return "none";
    return "na";
  }
  var STATE_TXT = { pass: "passed", fail: "failed", skip: "not run, an earlier check failed", none: "no XBRL fact filed yet", na: "not applicable, XBRL has no such figure" };
  var STATE_G = { pass: "✓", fail: "✕", skip: "·", none: "∅", na: "–" };

  function statusInfo(c) {
    if (c.status === "verified") return { cls: "st-ok", g: "✓", t: "XBRL match" };
    if (c.status === "rejected") return { cls: "st-bad", g: "✕", t: "Rejected" };
    if (c.basis === "guidance") return { cls: "st-q", g: "“", t: "Outlook, quoted" };
    return { cls: "st-q", g: "“", t: "Quoted, no XBRL" };
  }
  function cleanQuote(q) { return String(q || "").replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim(); }

  function claimEl(c) {
    var st = statusInfo(c);
    var val = typeof c.value === "number" ? PG.fmtValue(c) : "n/a";
    var checks = h("ul", { class: "cks", "aria-label": "Checks" });
    CHECKS.forEach(function (k) {
      var stt = checkState(c, k[0]);
      checks.appendChild(h("li", { class: "ck " + stt, title: k[2] + ": " + STATE_TXT[stt] },
        h("span", { class: "ck-g", "aria-hidden": "true", text: STATE_G[stt] }), k[1],
        h("span", { class: "sr", text: ": " + STATE_TXT[stt] })));
    });
    var li = h("li", { class: "claim " + st.cls },
      h("div", { class: "c-st" }, h("span", { class: "c-badge" }, h("span", { "aria-hidden": "true", class: "c-g", text: st.g }), st.t)),
      h("div", { class: "c-main" },
        h("div", { class: "c-top" },
          h("span", { class: "c-metric", text: PG.METRIC_LABEL[c.metric] || String(c.metric) }),
          h("span", { class: "c-val" + (c.status === "rejected" ? " struck" : ""), text: val })),
        h("blockquote", { class: "c-quote", text: cleanQuote(c.quote) }),
        checks));
    var main = li.querySelector(".c-main");
    if (c.status === "rejected") main.appendChild(h("p", { class: "c-reason" }, h("strong", { text: "Discarded: " }), c.reason || "failed verification"));
    else if (c.xbrl && c.status === "verified") {
      var x = c.xbrl;
      main.appendChild(h("p", { class: "c-xbrl", text: "XBRL " + (x.tag || "") + " " + PG.money(x.value) + " · " + (x.form || "") +
        (x.filed ? " filed " + x.filed : "") + (x.start && x.end ? " · period " + x.start + " → " + x.end : "") }));
    }
    return li;
  }

  function renderClaims() {
    var list = $("claims-list"), sum = $("ledger-sum");
    clear(list); clear(sum);
    var cl = CUR.claims || [];
    var order = { verified: 0, quote_only: 1, rejected: 2 };
    var sorted = cl.slice().sort(function (a, b) {
      return (order[a.status] - order[b.status]) || ((a.basis === "guidance") - (b.basis === "guidance"));
    });
    var nV = cl.filter(function (c) { return c.status === "verified"; }).length;
    var nQ = cl.filter(function (c) { return c.status === "quote_only"; }).length;
    var nR = cl.filter(function (c) { return c.status === "rejected"; }).length;
    if (!cl.length) {
      var ran = CUR.extraction && CUR.extraction.model;
      list.appendChild(h("li", { class: "claims-empty" },
        h("p", { class: "ce-h", text: ran ? "The model found none of the tracked figures in this release." : "No extraction on file for this release." }),
        h("p", { text: ran
          ? "The release was read (" + CUR.extraction.model + ") and no revenue, net income, EPS, operating income, gross profit or guidance line came back, so the ledger is empty instead of guessed. The full filing is linked below."
          : "The language model has not been run on it yet, so nothing is shown rather than guessing." })));
    } else {
      var bar = h("div", { class: "sum-bar", role: "img", "aria-label": nV + " verified against XBRL, " + nQ + " quote verified only, " + nR + " rejected" });
      sorted.forEach(function (c) { bar.appendChild(h("span", { class: "sb " + statusInfo(c).cls })); });
      sum.appendChild(bar);
      sum.appendChild(h("p", { class: "sum-t" },
        h("span", { class: "sum-i st-ok" }, h("b", { text: String(nV) }), " XBRL match"),
        h("span", { class: "sum-i st-q" }, h("b", { text: String(nQ) }), " quoted only"),
        h("span", { class: "sum-i st-bad" }, h("b", { text: String(nR) }), " rejected")));
      sorted.forEach(function (c) { list.appendChild(claimEl(c)); });
    }
    var src = $("claims-src"); clear(src);
    src.appendChild(document.createTextNode("Source: "));
    src.appendChild(h("a", { href: CUR.url, rel: "noopener", target: "_blank", text: "SEC filing " + CUR.accession + " ↗" }));
    if (CUR.xbrl_period_end) src.appendChild(document.createTextNode(" · XBRL quarter ending " + CUR.xbrl_period_end));
  }

  // ---------- gap vs guidance ----------
  function renderGap() {
    var body = $("gap-body"), g = CUR.gap;
    clear(body);
    if (!g || !g.available) {
      body.appendChild(h("p", { class: "gap-big none", text: "No comparison" }));
      body.appendChild(h("p", { class: "gap-why" }, h("strong", { text: "Missing: " }), (g && g.reason) || "not available", "."));
    } else {
      var pos = g.position || "";
      body.appendChild(h("div", { class: "gap-top" },
        h("p", { class: "gap-big " + (g.vs_mid_pct >= 0 ? "up" : "down") },
          h("span", { "aria-hidden": "true", class: "mv-g", text: g.vs_mid_pct >= 0 ? "▲" : "▼" }),
          PG.pctPlain(g.vs_mid_pct).replace("-", "−")),
        h("p", { class: "gap-lbl" }, "vs guidance midpoint", h("br"), h("span", { class: "chip pos", text: pos }))));
      var lo = Math.min(g.guide_low, g.actual), hi = Math.max(g.guide_high, g.actual), span = (hi - lo) || 1;
      var a = lo - span * 0.3, b = hi + span * 0.3;
      var X = function (v) { return ((v - a) / (b - a)) * 100; };
      body.appendChild(h("div", { class: "range", role: "img", "aria-label": "Reported revenue " + PG.money(g.actual) + " against guidance " + PG.money(g.guide_low) + " to " + PG.money(g.guide_high) },
        h("span", { class: "rg-band", style: "left:" + X(g.guide_low).toFixed(2) + "%;width:" + Math.max(0.6, X(g.guide_high) - X(g.guide_low)).toFixed(2) + "%" }),
        h("span", { class: "rg-mid", style: "left:" + X(g.guide_mid).toFixed(2) + "%" }),
        h("span", { class: "rg-act", style: "left:" + X(g.actual).toFixed(2) + "%" }),
        h("span", { class: "rg-act-l", style: "left:" + X(g.actual).toFixed(2) + "%", text: "actual " + PG.money(g.actual) }),
        h("span", { class: "rg-lo", style: "left:" + X(g.guide_low).toFixed(2) + "%", text: PG.money(g.guide_low) }),
        h("span", { class: "rg-hi", style: "left:" + X(g.guide_high).toFixed(2) + "%", text: PG.money(g.guide_high) })));
      body.appendChild(h("p", { class: "gap-sub", text: "Reported " + PG.money(g.actual) + " (" + (g.actual_status === "verified" ? "XBRL match" : "quoted") + ") against " + PG.money(g.guide_low) + " to " + PG.money(g.guide_high) + " guided one quarter earlier." }));
      if (g.guide_from_event) {
        var src = DATA.events.filter(function (e) { return e.id === g.guide_from_event; })[0];
        if (src) {
          var btn = h("button", { type: "button", class: "linkish", text: "Guide came from the " + shortId(src) + " release →" });
          btn.addEventListener("click", function () { select(src.id, true); });
          body.appendChild(h("p", { class: "gap-src" }, btn));
        }
      }
    }
    if (CUR.yoy_revenue_pct != null) {
      body.appendChild(h("p", { class: "gap-yoy" }, h("span", { class: "k", text: "Revenue vs year-ago quarter" }),
        h("span", { class: "v " + (CUR.yoy_revenue_pct >= 0 ? "up" : "down") }, h("span", { class: "mv-g", "aria-hidden": "true", text: CUR.yoy_revenue_pct >= 0 ? "▲ " : "▼ " }), PG.pctPlain(CUR.yoy_revenue_pct).replace("-", "−")),
        h("span", { class: "src", text: "SEC XBRL" })));
    }
    body.appendChild(h("p", { class: "no-consensus" }, h("strong", { text: "Not analyst consensus. " }),
      "No consensus source is available to this build. The benchmark is the company's own prior-quarter guidance, and beating a cautious guide is common."));
  }

  // ---------- every measured night (dumbbell rows on one shared axis) ----------
  function renderAnalogs() {
    var body = $("analogs-body"); clear(body);
    var rows = DATA.events.filter(measured);
    var A = DATA.analogs;
    if (!rows.length) { body.appendChild(h("p", { class: "rule-note", text: "No release in the dataset has a measurable overnight window yet." })); return; }
    body.appendChild(h("p", { class: "rule-note", text: "Measured " + A.n_valid + " of " + A.n_events + " releases" +
      (A.median_priced_in != null ? "; median priced in " + Math.round(A.median_priced_in * 100) + "%" : "") + "." +
      (A.n_valid < 10 ? " Too few for statistics: this is a log, not a forecast." : "") }));
    var vals = [0];
    rows.forEach(function (e) { vals.push(simple(e.reaction.rt_move), simple(e.reaction.cash_gap)); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.06;
    lo -= pad; hi += pad;
    var X = function (v) { return ((v - lo) / (hi - lo)) * 100; };
    var leg = h("p", { class: "db-leg" },
      h("span", null, h("span", { class: "sw sw-rt", "aria-hidden": "true" }), "rToken overnight"),
      h("span", null, h("span", { class: "sw sw-cash", "aria-hidden": "true" }), "stock opening gap"));
    body.appendChild(leg);
    var ol = h("ol", { class: "db" });
    rows.forEach(function (e) {
      var r = e.reaction, a = X(simple(r.rt_move)), c = X(simple(r.cash_gap));
      var b = h("button", { type: "button", class: "db-row", "aria-current": e.id === CUR.id ? "true" : "false",
        "aria-label": shortId(e) + ": rToken " + pctTxt(r.rt_move, 1) + ", stock " + pctTxt(r.cash_gap, 1) + ", priced in " + ratioTxt(r.priced_in) },
        h("span", { class: "db-id", text: shortId(e) }),
        h("span", { class: "db-track", "aria-hidden": "true" },
          h("span", { class: "db-zero", style: "left:" + X(0).toFixed(2) + "%" }),
          h("span", { class: "db-link", style: "left:" + Math.min(a, c).toFixed(2) + "%;width:" + Math.abs(a - c).toFixed(2) + "%" }),
          h("span", { class: "db-rt", style: "left:" + a.toFixed(2) + "%" }),
          h("span", { class: "db-cash", style: "left:" + c.toFixed(2) + "%" })),
        h("span", { class: "db-r", text: ratioTxt(r.priced_in) }));
      b.addEventListener("click", function () { select(e.id, true); });
      ol.appendChild(h("li", null, b));
    });
    body.appendChild(ol);
    body.appendChild(h("p", { class: "db-axis", "aria-hidden": "true" },
      h("span", { text: "−" + Math.abs(lo).toFixed(0) + "%" }), h("span", { text: "0" }), h("span", { text: "+" + hi.toFixed(0) + "%" })));
    var axis = body.lastChild;
    axis.children[1].style.left = X(0).toFixed(2) + "%";
  }

  // ---------- evidence, chat, memo ----------
  function renderEvidence() {
    var ol = $("evidence"); clear(ol);
    PG.evidence(CUR, DATA.analogs).forEach(function (e) {
      ol.appendChild(h("li", { class: "k-" + e.kind, id: "evi-" + e.id, tabindex: "-1" }, h("span", { class: "eid", text: e.id }), h("span", { class: "etx", text: e.text })));
    });
  }

  // The chat lives in chat.js (the pop-up at the bottom right). It reads the selected release through this bridge.
  window.PGApp = {
    current: function () { return CUR; },
    evidence: function () { return CUR ? PG.evidence(CUR, DATA.analogs) : []; },
    measured: function (e) { return !!measured(e || CUR); },
    getJSON: getJSON,
  };
  $("desk-ask").addEventListener("click", function () { if (window.PGChat) window.PGChat.open(); });

  var MEMO = "";
  $("memo-build").addEventListener("click", function () {
    MEMO = PG.memo(CUR, DATA.analogs);
    var pre = $("memo-out"); pre.textContent = MEMO; pre.hidden = false;
    $("memo-copy").hidden = false; $("memo-dl").hidden = false;
  });
  $("memo-copy").addEventListener("click", function (e) {
    var b = e.currentTarget;
    (navigator.clipboard ? navigator.clipboard.writeText(MEMO) : Promise.reject()).then(
      function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); },
      function () { b.textContent = "Select the text and copy it manually"; });
  });
  $("memo-dl").addEventListener("click", function () {
    var a = h("a", { href: URL.createObjectURL(new Blob([MEMO], { type: "text/markdown" })), download: CUR.ticker + "-" + CUR.filing_date + "-printgap.md" });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });
})();
