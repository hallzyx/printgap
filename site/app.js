(function () {
  "use strict";
  var PG = window.PG;
  var NS = "http://www.w3.org/2000/svg";
  var DATA = null, CUR = null, KEY_IN_MEMORY = "";

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

  // ---------- load ----------
  fetch("data/events.json", { cache: "no-cache" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (d) { DATA = d; init(); })
    .catch(function (e) { showEmpty("Could not load the data file", "data/events.json failed to load (" + e.message + "). If you opened this page from disk, serve the folder over HTTP instead, for example: python3 -m http.server in the site folder."); });

  function showEmpty(title, body) {
    var box = $("empty");
    clear(box);
    box.appendChild(h("h2", { text: title }));
    box.appendChild(h("p", { text: body }));
    box.hidden = false;
    $("view").hidden = true;
  }

  function init() {
    if (!DATA.events.length) {
      showEmpty("No earnings releases loaded yet",
        "The data pipeline has not produced any releases. Run the 'Fetch data' workflow in GitHub Actions, then rebuild the site. Nothing on this page is made up to fill the gap.");
      return;
    }
    var nav = $("events");
    clear(nav);
    DATA.events.forEach(function (ev) {
      var b = h("button", { type: "button", "data-id": ev.id },
        h("span", { class: "e-t", text: ev.ticker }),
        h("span", { class: "e-d", text: ev.filing_date }));
      b.addEventListener("click", function () { select(ev.id); });
      nav.appendChild(b);
    });
    var first = DATA.events.filter(function (e) { return e.reaction && e.reaction.ok; })[0] || DATA.events[0];
    var hash = decodeURIComponent((location.hash || "").slice(1));
    var start = DATA.events.filter(function (e) { return e.id === hash; })[0] || first;
    select(start.id);
  }

  function select(id) {
    CUR = DATA.events.filter(function (e) { return e.id === id; })[0];
    history.replaceState(null, "", "#" + encodeURIComponent(id));
    Array.prototype.forEach.call($("events").children, function (b) {
      b.setAttribute("aria-current", b.getAttribute("data-id") === id ? "true" : "false");
    });
    $("empty").hidden = true;
    $("view").hidden = false;
    renderHero(); renderClaims(); renderGap(); renderAnalogs(); renderEvidence();
    $("answer").textContent = "";
    $("memo-out").hidden = $("memo-copy").hidden = $("memo-dl").hidden = true;
  }

  // ---------- hero + timeline ----------
  function renderHero() {
    var ev = CUR, r = ev.reaction;
    var head = PG.headline(ev);
    $("hero-h").textContent = head || (ev.ticker + " released results " + ev.pub_et);
    var sub = "Released " + ev.pub_et + ". ";
    if (r && r.ok) sub += "The rToken's window ran " + PG.hours(r.open_minute) + " from the 16:00 ET close to the 09:30 ET open (" + r.base_day + " to " + r.target_day + ").";
    else sub += "Price reaction not measured: " + ((r && r.reason) || "no price data") + ".";
    $("hero-sub").textContent = sub;
    var svg = $("timeline");
    clear(svg);
    if (!r || !r.ok || !r.path || !r.path.length) {
      svg.setAttribute("viewBox", "0 0 960 60");
      svg.appendChild(s("text", { x: 12, y: 34 }, "No overnight price path for this release."));
      $("chart-cap").textContent = "";
      return;
    }
    svg.setAttribute("viewBox", "0 0 960 330");
    svg.setAttribute("aria-label", head || "Overnight rToken path");
    drawTimeline(svg, ev);
  }

  function drawTimeline(svg, ev) {
    var r = ev.reaction, W = 960, H = 330, pad = { l: 58, r: 70, t: 34, b: 52 };
    var g = PG.chartGeometry(r, W, H, pad);
    var baseClose = new Date(new Date(ev.pub_utc).getTime() - r.pub_minute * 60000);
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
    var fmt = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hour12: false });

    // horizontal grid + y labels (percent vs the 16:00 ET close)
    var step = niceStep((g.hi - g.lo) / 4);
    for (var v = Math.ceil(g.lo / step) * step; v <= g.hi; v += step) {
      var y = g.Y(v);
      svg.appendChild(s("line", { x1: g.x0, x2: g.x1, y1: y, y2: y, class: "grid" }));
      svg.appendChild(s("text", { x: g.x0 - 8, y: y + 4, "text-anchor": "end" }, (v >= 0 ? "+" : "") + v.toFixed(step < 1 ? 1 : 0) + "%"));
    }
    svg.appendChild(s("line", { x1: g.x0, x2: g.x1, y1: g.zeroY, y2: g.zeroY, class: "zero" }));
    // time ticks every 2 hours, in the viewer's own clock
    for (var m = 0; m <= r.open_minute; m += 120) {
      var x = g.X(m);
      svg.appendChild(s("line", { x1: x, x2: x, y1: g.y1, y2: g.y1 + 5, class: "grid" }));
      svg.appendChild(s("text", { x: x, y: g.y1 + 20, "text-anchor": "middle" }, fmt.format(new Date(baseClose.getTime() + m * 60000))));
    }
    svg.appendChild(s("text", { x: g.x0, y: H - 8 }, "Clock shown in " + tz + ". Vertical axis: change vs the 16:00 ET close."));

    // area + path
    var d = g.points.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    svg.appendChild(s("path", { d: d + " L" + g.points[g.points.length - 1][0].toFixed(1) + " " + g.zeroY + " L" + g.points[0][0].toFixed(1) + " " + g.zeroY + " Z", class: "area" }));
    svg.appendChild(s("path", { d: d, class: "path" }));

    // release marker
    svg.appendChild(s("line", { x1: g.pubX, x2: g.pubX, y1: g.y0 - 8, y2: g.y1, class: "mark-line" }));
    svg.appendChild(s("text", { x: g.pubX + 6, y: g.y0 - 1, class: "lbl-strong" }, "Release " + ev.pub_et.slice(11)));
    // cash open marker
    svg.appendChild(s("line", { x1: g.openX, x2: g.openX, y1: g.y0 - 8, y2: g.y1, class: "mark-line" }));
    svg.appendChild(s("text", { x: g.openX - 6, y: g.y0 - 1, "text-anchor": "end", class: "lbl-strong" }, "Cash open 09:30 ET"));

    // end of rToken path, the residual, and the cash open
    var last = g.points[g.points.length - 1];
    svg.appendChild(s("line", { x1: last[0], x2: g.openX, y1: last[1], y2: g.cashY, class: "resid" }));
    svg.appendChild(s("circle", { cx: last[0], cy: last[1], r: 5, class: "dot" }));
    svg.appendChild(s("text", { x: last[0] - 8, y: last[1] - 10, "text-anchor": "end" }, "rToken " + PG.pct(r.rt_move)));
    var dm = "M" + g.openX + " " + (g.cashY - 7) + " l7 7 l-7 7 l-7 -7 Z";
    svg.appendChild(s("path", { d: dm, class: "cash" }));
    svg.appendChild(s("text", { x: g.openX + 11, y: g.cashY + 4 }, "stock " + PG.pct(r.cash_gap)));

    var cap = "Amber line: rToken price. Hollow diamond: where the cash stock opened. Dashed line: what the rToken had not priced when the open arrived (" + PG.pct(r.residual) + ").";
    $("chart-cap").textContent = cap;
  }

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  // ---------- claims ----------
  function badge(c) {
    if (c.status === "verified") return h("span", { class: "badge ok", text: "Matches SEC XBRL" });
    if (c.status === "quote_only") return h("span", { class: "badge warn", text: c.basis === "guidance" ? "Quote verified, company outlook" : "Quote verified, no XBRL fact yet" });
    return h("span", { class: "badge bad", text: "Rejected" });
  }
  function claimEl(c) {
    var el = h("div", { class: "claim" },
      h("div", { class: "claim-head" },
        h("div", null, h("span", { class: "claim-metric", text: PG.METRIC_LABEL[c.metric] || String(c.metric) }), badge(c)),
        h("div", { class: "claim-val", text: typeof c.value === "number" ? PG.fmtValue(c) : "n/a" })),
      h("blockquote", { class: "quote", text: c.quote || "" }));
    if (c.status === "rejected") el.appendChild(h("div", { class: "reason", text: c.reason || "Failed verification" }));
    return el;
  }
  function renderClaims() {
    var list = $("claims-list"), rej = $("rejected-list");
    clear(list); clear(rej);
    var ok = CUR.claims.filter(function (c) { return c.status !== "rejected"; });
    var bad = CUR.claims.filter(function (c) { return c.status === "rejected"; });
    if (!CUR.claims.length) {
      list.appendChild(h("p", { class: "note", text: "No extraction on file for this release. The language model has not been run on it yet, so nothing is shown rather than guessing." }));
    }
    ok.forEach(function (c) { list.appendChild(claimEl(c)); });
    var link = h("p", { class: "note" }, "Full release: ", h("a", { href: CUR.url, rel: "noopener", text: "SEC filing " + CUR.accession }));
    list.appendChild(link);
    var box = $("rejected");
    box.hidden = !bad.length;
    if (bad.length) {
      box.querySelector("summary").textContent = bad.length + " extracted figure" + (bad.length > 1 ? "s" : "") + " discarded by the verifier";
      bad.forEach(function (c) { rej.appendChild(claimEl(c)); });
    }
  }

  // ---------- gap vs guidance ----------
  function renderGap() {
    var body = $("gap-body"), g = CUR.gap;
    clear(body);
    if (CUR.yoy_revenue_pct != null) {
      body.appendChild(h("p", { class: "gapsub", text: "Revenue " + PG.pctPlain(CUR.yoy_revenue_pct) + " vs the year-ago quarter (SEC XBRL)." }));
    }
    if (!g || !g.available) {
      body.appendChild(h("p", { class: "note", text: (g && g.reason) || "Not available." }));
      body.appendChild(h("p", { class: "basis", text: "Analyst consensus is not used here: no source for it was available to this build." }));
      return;
    }
    body.appendChild(h("p", { class: "gapnum", text: PG.pctPlain(g.vs_mid_pct) + " vs guidance midpoint" }));
    body.appendChild(h("p", { class: "gapsub", text: "Revenue " + PG.money(g.actual) + " against guidance of " + PG.money(g.guide_low) + " to " + PG.money(g.guide_high) + ": " + g.position + "." }));
    var W = 420, lo = Math.min(g.guide_low, g.actual), hi = Math.max(g.guide_high, g.actual), span = (hi - lo) || 1;
    var a = lo - span * 0.25, b = hi + span * 0.25;
    var X = function (v) { return 20 + ((v - a) / (b - a)) * (W - 40); };
    var svg = s("svg", { viewBox: "0 0 " + W + " 70", role: "img", "aria-label": "Revenue against guidance range" });
    svg.appendChild(s("rect", { x: X(g.guide_low), y: 20, width: Math.max(2, X(g.guide_high) - X(g.guide_low)), height: 24, class: "band" }));
    svg.appendChild(s("line", { x1: X(g.actual), x2: X(g.actual), y1: 10, y2: 54, class: "actual" }));
    svg.appendChild(s("text", { x: X(g.guide_low), y: 66, "text-anchor": "middle" }, PG.money(g.guide_low)));
    svg.appendChild(s("text", { x: X(g.guide_high), y: 66, "text-anchor": "middle" }, PG.money(g.guide_high)));
    svg.appendChild(s("text", { x: X(g.actual), y: 8, "text-anchor": "middle" }, "actual " + PG.money(g.actual)));
    body.appendChild(h("div", { class: "range" }, svg));
    body.appendChild(h("p", { class: "basis", text: "Basis: the company's own guidance from its previous release, not analyst consensus. Beating a cautious guide is common." }));
  }

  // ---------- analogs ----------
  function renderAnalogs() {
    var body = $("analogs-body"); clear(body);
    var rows = DATA.events.filter(function (e) { return e.reaction && e.reaction.ok; });
    var A = DATA.analogs;
    if (!rows.length) { body.appendChild(h("p", { class: "note", text: "No release in the dataset has a measurable overnight window yet." })); return; }
    var sm = "Measured " + A.n_valid + " of " + A.n_events + " releases." +
      (A.median_priced_in != null ? " Median priced-in ratio " + A.median_priced_in.toFixed(2) + " (" + A.n_with_ratio + " usable)." : "") +
      (A.n_valid < 10 ? " That is too few releases for statistics: read this as a log, not a forecast." : "");
    body.appendChild(h("p", { class: "note", text: sm }));
    var t = h("table", { class: "t" });
    t.appendChild(h("thead", null, h("tr", null, h("th", { text: "Release" }), h("th", { text: "rToken" }), h("th", { text: "Stock gap" }), h("th", { text: "Priced in" }))));
    var tb = h("tbody");
    rows.forEach(function (e) {
      var r = e.reaction;
      var tr = h("tr", e.id === CUR.id ? { class: "cur" } : null,
        h("td", { text: e.ticker + " " + e.filing_date.slice(5) }),
        h("td", { text: PG.pct(r.rt_move, 1) }),
        h("td", { text: PG.pct(r.cash_gap, 1) }),
        h("td", { text: r.priced_in == null ? "n/a" : Math.round(r.priced_in * 100) + "%" }));
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    body.appendChild(h("div", { class: "tablewrap" }, t));
  }

  // ---------- evidence, chat, memo ----------
  function renderEvidence() {
    var ol = $("evidence"); clear(ol);
    PG.evidence(CUR, DATA.analogs).forEach(function (e) {
      ol.appendChild(h("li", null, h("span", { class: "eid", text: e.id }), h("span", { class: "etx", text: e.text })));
    });
  }

  var modelEdited = false;
  function syncProvider() {
    var pv = PG.PROVIDERS[$("prov").value];
    $("base-row").hidden = !pv.custom;
    if (!modelEdited) $("model").value = pv.model;
    $("model").placeholder = pv.custom ? "the model name your endpoint expects" : pv.model;
  }
  $("prov").addEventListener("change", function () { modelEdited = false; syncProvider(); });
  $("model").addEventListener("input", function () { modelEdited = true; });
  $("key").addEventListener("input", function (e) { KEY_IN_MEMORY = e.target.value.trim(); });
  syncProvider();

  $("ask-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var q = $("q").value.trim(), out = $("answer");
    if (!q) { out.textContent = "Type a question first."; return; }
    var provider = $("prov").value, E = PG.evidence(CUR, DATA.analogs), req;
    try {
      req = PG.chatRequest(provider, $("model").value.trim(), KEY_IN_MEMORY, $("base").value.trim(), PG.chatSystem(E), q);
    } catch (err) { out.textContent = err.message + " The memo below works without a key."; return; }
    var btn = e.target.querySelector("button");
    btn.disabled = true; out.textContent = "Reading the evidence...";
    fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(PG.chatError(j, r.status)); return j; }); })
      .then(function (j) {
        var text = PG.chatText(provider, j);
        clear(out); out.appendChild(document.createTextNode(text));
        var cited = (text.match(/\[E\d+\]/g) || []), known = {};
        E.forEach(function (x) { known["[" + x.id + "]"] = 1; });
        var bogus = cited.filter(function (c) { return !known[c]; });
        var abstain = /evidence does not cover that/i.test(text);
        if (!text) out.appendChild(h("div", { class: "flag", text: "The provider returned an empty answer. Reasoning models can use their whole budget thinking; try a smaller or non-reasoning model." }));
        else if (bogus.length) out.appendChild(h("div", { class: "flag", text: "This answer cites evidence that does not exist (" + bogus.join(", ") + "). Do not rely on it." }));
        else if (!cited.length && !abstain) out.appendChild(h("div", { class: "flag", text: "This answer cites no evidence. Treat it as unsupported." }));
      })
      .catch(function (err) {
        out.textContent = err instanceof TypeError
          ? "The request did not reach the provider. Either the network failed or this provider does not accept calls from a web page (CORS). The memo works without a key, and the Python pipeline can use this provider directly."
          : "The question failed: " + err.message;
      })
      .then(function () { btn.disabled = false; });
  });

  var MEMO = "";
  $("memo-build").addEventListener("click", function () {
    MEMO = PG.memo(CUR, DATA.analogs);
    var pre = $("memo-out"); pre.textContent = MEMO; pre.hidden = false;
    $("memo-copy").hidden = false; $("memo-dl").hidden = false;
  });
  $("memo-copy").addEventListener("click", function (e) {
    var b = e.target;
    (navigator.clipboard ? navigator.clipboard.writeText(MEMO) : Promise.reject()).then(
      function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy"; }, 1500); },
      function () { b.textContent = "Select the text and copy it manually"; });
  });
  $("memo-dl").addEventListener("click", function () {
    var a = h("a", { href: URL.createObjectURL(new Blob([MEMO], { type: "text/markdown" })), download: CUR.ticker + "-" + CUR.filing_date + "-printgap.md" });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });
})();
