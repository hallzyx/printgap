/* PrintGap chat: the pop-up at the bottom right.
   The model's answer is untrusted. It is split by richtext.js, turned into HTML by marked with raw HTML
   escaped, then sanitised by DOMPurify before it touches the page. Math goes through KaTeX (trust off),
   diagrams through mermaid (securityLevel strict, output sanitised again), charts are drawn here as SVG
   with textContent only. KaTeX and mermaid load the first time an answer needs them. */
(function () {
  "use strict";
  var PG = window.PG, RT = window.RT, APP = window.PGApp;
  var NS = "http://www.w3.org/2000/svg";
  var V = "vendor/";
  var MAXQ = 500, TURNS = 6;

  function $(id) { return document.getElementById(id); }
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
  function sv(tag, attrs, text) {
    var el = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    if (text != null) el.textContent = text;
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function reduced() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function narrow() { return !!(window.matchMedia && window.matchMedia("(max-width: 620px)").matches); }
  function clock(t) { var d = new Date(t); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }

  /* ---------- lazy loading of the vendored libraries ---------- */
  var loading = {};
  function loadScript(src) {
    if (!loading[src]) loading[src] = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = function () { res(); };
      s.onerror = function () { delete loading[src]; s.remove(); rej(new Error("could not load " + src)); };
      document.head.appendChild(s);
    });
    return loading[src];
  }
  function loadCSS(href) {
    if (loading[href]) return loading[href];
    loading[href] = new Promise(function (res) {
      var l = document.createElement("link");
      l.rel = "stylesheet"; l.href = href; l.onload = l.onerror = function () { res(); };
      document.head.appendChild(l);
    });
    return loading[href];
  }

  var MD = null, PURIFY = null;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function core() {
    return Promise.all([loadScript(V + "marked/marked.umd.js"), loadScript(V + "dompurify/purify.min.js")]).then(function () {
      if (MD) return;
      PURIFY = window.DOMPurify;
      MD = new window.marked.Marked({ gfm: true, breaks: false, async: false });
      MD.use({ renderer: {
        // raw HTML from the model is shown as text, never parsed (DOMPurify would strip it anyway)
        html: function (t) { return esc(t.text || t.raw || ""); },
        // no remote images: a model-written <img> could be a tracking pixel
        image: function (t) { return esc("[image: " + (t.text || t.title || "untitled") + "]"); },
      } });
      // every surviving link opens in a new tab without referrer or opener
      PURIFY.addHook("afterSanitizeAttributes", function (node) {
        if (node.tagName === "A") {
          var ok = RT.safeHref(node.getAttribute("href"));
          if (!ok) node.removeAttribute("href");
          else { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer nofollow"); node.setAttribute("referrerpolicy", "no-referrer"); }
        }
      });
    });
  }
  var MD_PURIFY = {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "b", "i", "del", "s", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
      "hr", "table", "thead", "tbody", "tr", "th", "td", "a", "span"],
    ALLOWED_ATTR: ["href", "title", "align", "start"],
    ALLOW_DATA_ATTR: false, ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i, RETURN_DOM_FRAGMENT: true,
  };

  var katexReady = null;
  function katexLib() {
    if (!katexReady) katexReady = Promise.all([loadCSS(V + "katex/katex.min.css"), loadScript(V + "katex/katex.min.js")]).then(function () { return window.katex; });
    return katexReady;
  }
  var mermaidReady = null, mermaidSeq = 0;
  function mermaidLib() {
    if (!mermaidReady) mermaidReady = loadScript(V + "mermaid/mermaid.min.js").then(function () {
      var M = window.mermaid;
      M.initialize({
        startOnLoad: false, securityLevel: "strict", theme: "base", htmlLabels: false, maxTextSize: 8000, maxEdges: 200,
        suppressErrorRendering: true, fontFamily: '"Plex Cond", "Arial Narrow", sans-serif',
        flowchart: { htmlLabels: false, curve: "linear", padding: 10, useMaxWidth: true },
        sequence: { useMaxWidth: true }, timeline: { useMaxWidth: true, disableMulticolor: true },
        themeVariables: {
          darkMode: true, fontFamily: '"Plex Cond", "Arial Narrow", sans-serif', fontSize: "14px",
          background: "#0f1419", mainBkg: "#151c23", primaryColor: "#151c23", primaryTextColor: "#e8ecf0", primaryBorderColor: "#ffb23e",
          secondaryColor: "#1b242d", secondaryTextColor: "#e8ecf0", secondaryBorderColor: "#8fd0ff",
          tertiaryColor: "#0f1419", tertiaryTextColor: "#e8ecf0", tertiaryBorderColor: "#2e3a46",
          lineColor: "#a6b1bc", textColor: "#e8ecf0", nodeBorder: "#ffb23e", nodeTextColor: "#e8ecf0",
          clusterBkg: "#0f1419", clusterBorder: "#2e3a46", titleColor: "#e8ecf0", edgeLabelBackground: "#0f1419",
          noteBkgColor: "#1b242d", noteTextColor: "#e8ecf0", noteBorderColor: "#2e3a46",
          actorBkg: "#151c23", actorBorder: "#ffb23e", actorTextColor: "#e8ecf0", signalColor: "#a6b1bc", signalTextColor: "#e8ecf0",
          cScale0: "#151c23", cScale1: "#1b242d", cScale2: "#151c23", cScale3: "#1b242d", cScale4: "#151c23", cScale5: "#1b242d",
          cScaleLabel0: "#e8ecf0", cScaleLabel1: "#e8ecf0", cScaleLabel2: "#e8ecf0", cScaleLabel3: "#e8ecf0", cScaleLabel4: "#e8ecf0", cScaleLabel5: "#e8ecf0",
          cScalePeer0: "#ffb23e", cScalePeer1: "#8fd0ff", cScalePeer2: "#ffb23e", cScalePeer3: "#8fd0ff",
        },
      });
      return M;
    });
    return mermaidReady;
  }
  var SVG_PURIFY = { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ["style"], RETURN_DOM_FRAGMENT: true };

  /* ---------- the rich renderer ---------- */
  function notice(text) { return h("p", { class: "rt-notice" }, h("span", { class: "rt-notice-g", "aria-hidden": "true", text: "!" }), text); }
  function codeBlock(src, lang) {
    return h("pre", { class: "rt-code" + (lang ? " rt-code-" + lang : "") }, h("code", { text: src }));
  }

  function citeEl(id, known) {
    if (known[id]) {
      var b = h("button", { type: "button", class: "cite", "data-e": id, title: known[id].slice(0, 220), "aria-label": "Evidence " + id + ": show it in the Evidence desk" }, id);
      return b;
    }
    return h("span", { class: "cite bad", title: "No fact " + id + " exists in this release's evidence list" },
      h("span", { "aria-hidden": "true", text: "✕ " }), id, h("span", { class: "sr", text: " (this evidence does not exist)" }));
  }

  // walk text nodes (outside code) and swap placeholders and [E3] citations for real elements
  function weave(root, prep, known, jobs) {
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), nodes = [], n;
    while ((n = tw.nextNode())) {
      var p = n.parentNode, inCode = false;
      while (p && p !== root) { if (p.nodeName === "CODE" || p.nodeName === "PRE") { inCode = true; break; } p = p.parentNode; }
      if (!inCode && /PGMATH\d+Z|PGBLOCK\d+Z|\[E\d/.test(n.nodeValue)) nodes.push(n);
    }
    nodes.forEach(function (node) {
      var segs = RT.tokenizeInline(node.nodeValue), frag = document.createDocumentFragment(), blockEls = [];
      segs.forEach(function (sg) {
        if (sg.type === "text") frag.appendChild(document.createTextNode(sg.text));
        else if (sg.type === "cite") {
          var wrap = h("span", { class: "cites" });
          sg.ids.forEach(function (id) { wrap.appendChild(citeEl(id, known)); });
          frag.appendChild(wrap);
        } else if (sg.type === "math" && prep.math[sg.i]) {
          var m = prep.math[sg.i];
          var el = h("span", { class: "rt-math" + (m.display ? " d" : "") }, h("code", { class: "rt-tex", text: m.tex }));
          jobs.math.push({ el: el, m: m });
          frag.appendChild(el);
        } else if (sg.type === "block" && prep.blocks[sg.i]) {
          var b = prep.blocks[sg.i], fig = h("div", { class: "rt-block rt-b-" + b.kind });
          jobs.blocks.push({ el: fig, b: b });
          blockEls.push(fig);
          frag.appendChild(fig);
        } else {
          frag.appendChild(document.createTextNode(sg.type === "math" ? "PGMATH" + sg.i + "Z" : "PGBLOCK" + sg.i + "Z"));
        }
      });
      var parent = node.parentNode;
      // a block alone in its paragraph replaces the paragraph (a div inside <p> is invalid)
      if (blockEls.length === 1 && parent.nodeName === "P" && parent.childNodes.length === 1 && !/\S/.test(node.nodeValue.replace(/PGBLOCK\d+Z/, ""))) {
        parent.parentNode.replaceChild(blockEls[0], parent);
      } else {
        parent.replaceChild(frag, node);
      }
    });
  }

  function decorateTables(root) {
    Array.prototype.forEach.call(root.querySelectorAll("table"), function (t) {
      Array.prototype.forEach.call(t.querySelectorAll("td"), function (td) { if (RT.looksNumeric(td.textContent)) td.className = "num"; });
      var heads = t.querySelectorAll("th"), cols = t.rows[1] ? t.rows[1].cells.length : 0;
      Array.prototype.forEach.call(heads, function (th, i) {
        var all = Array.prototype.every.call(t.querySelectorAll("tbody tr"), function (tr) { return !tr.cells[i] || tr.cells[i].className === "num"; });
        if (all && cols) th.className = "num";
      });
      var wrap = h("div", { class: "rt-table", tabindex: "0", role: "region", "aria-label": "Table" });
      t.parentNode.replaceChild(wrap, t);
      wrap.appendChild(t);
    });
  }

  function renderMath(jobs) {
    if (!jobs.length) return Promise.resolve();
    return katexLib().then(function (K) {
      jobs.forEach(function (j) {
        var holder = h("span", { class: "rt-k" });
        try {
          K.render(j.m.tex, holder, { displayMode: j.m.display, throwOnError: true, trust: false, strict: "ignore", maxSize: 20, maxExpand: 300, output: "htmlAndMathml" });
          clear(j.el); j.el.appendChild(holder);
          if (j.m.display) { j.el.setAttribute("tabindex", "0"); j.el.setAttribute("role", "group"); j.el.setAttribute("aria-label", "Formula"); }
        } catch (e) {
          j.el.classList.add("bad");
          j.el.setAttribute("title", "This formula could not be typeset; its source is shown.");
        }
      });
    }, function () { jobs.forEach(function (j) { j.el.classList.add("bad"); }); });
  }

  function renderBlock(job) {
    var b = job.b, el = job.el;
    if (b.kind === "chart") {
      var c = RT.parseChart(b.src);
      if (!c.ok) { el.className = "rt-block rt-fallback"; el.appendChild(notice(c.error + " Its text is shown instead.")); el.appendChild(codeBlock(b.src, "chart")); return Promise.resolve(); }
      drawChart(el, c.chart, c.warnings);
      return Promise.resolve();
    }
    // mermaid
    el.appendChild(h("p", { class: "rt-loading", text: "Drawing the diagram" }));
    if (b.src.length > 6000) return Promise.resolve(fail("The diagram is too large to draw."));
    function fail(why) {
      clear(el); el.className = "rt-block rt-fallback";
      el.appendChild(notice(why + " Its source is shown instead."));
      el.appendChild(codeBlock(b.src, "mermaid"));
    }
    return mermaidLib().then(function (M) {
      var id = "pgm" + (++mermaidSeq), drawSrc = RT.mermaidForNarrow(b.src);
      return Promise.resolve(M.parse(drawSrc)).then(function () { return M.render(id, drawSrc); }).then(function (out) {
        var frag = PURIFY.sanitize(out.svg, SVG_PURIFY);
        var svg = frag.querySelector && frag.querySelector("svg");
        if (!svg) throw new Error("empty");
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", "Diagram: " + b.src.replace(/\s+/g, " ").slice(0, 300));
        svg.removeAttribute("height");
        clear(el);
        var wrap = h("div", { class: "rt-mmd", tabindex: "0", role: "group", "aria-label": "Diagram, scrolls sideways if wide" });
        wrap.appendChild(svg);
        el.appendChild(wrap);
        // natural size (mermaid's 14px text), never shrunk below ~85%: a wide diagram scrolls instead of turning into dust
        var vb = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number), cw = wrap.clientWidth - 22;
        if (vb.length === 4 && vb[2] > 0 && cw > 0) {
          svg.style.maxWidth = "none";
          svg.style.width = Math.round(vb[2] <= cw ? vb[2] : Math.max(cw, vb[2] * 0.85)) + "px";
        }
        var src = h("details", { class: "rt-src" }, h("summary", { text: "Diagram source" }), codeBlock(b.src, "mermaid"));
        el.appendChild(src);
      }).catch(function () {
        ["d" + id, id].forEach(function (x) { var s = document.getElementById(x); if (s && !el.contains(s)) s.remove(); });
        fail("This diagram could not be drawn.");
      });
    }, function () { fail("The diagram library did not load."); });
  }

  function drawChart(el, chart, warnings) {
    var W = Math.max(260, Math.min(640, Math.round(el.getBoundingClientRect().width || $("chat-log").clientWidth - 40 || 360)));
    var H = Math.round(Math.max(190, Math.min(260, W * 0.58)));
    var g = RT.chartLayout(chart, W, H);
    var fig = h("figure", { class: "rt-chart", role: "group", "aria-label": "Chart" + (chart.title ? ": " + chart.title : "") });
    fig.appendChild(h("figcaption", { class: "rt-ch-cap" }, h("span", { class: "rt-ch-t", text: chart.title || "Chart" }),
      chart.unit ? h("span", { class: "rt-ch-u", text: chart.unit === "%" ? "percent" : chart.unit }) : null));
    var svg = sv("svg", { viewBox: "0 0 " + W + " " + H, class: "rt-ch-svg", role: "img", "aria-label": RT.chartSummary(chart), preserveAspectRatio: "xMidYMid meet" });
    // grid + y axis
    g.ticks.forEach(function (t) {
      svg.appendChild(sv("line", { x1: g.x0, x2: g.x1, y1: t.y, y2: t.y, class: t.v === 0 ? "zero" : "grid" }));
      svg.appendChild(sv("text", { x: g.x0 - 6, y: t.y + 4, "text-anchor": "end", class: "ax" }, t.text));
    });
    // x labels
    g.xLabels.forEach(function (l) {
      var tx = sv("text", { x: l.x, y: g.y1 + 18, "text-anchor": "middle", class: "xl" }, l.text);
      if (l.text !== l.full) tx.appendChild(sv("title", null, l.full));
      svg.appendChild(tx);
    });
    g.bars.forEach(function (b) {
      var r = sv("rect", { x: b.x.toFixed(1), y: b.y.toFixed(1), width: b.w.toFixed(1), height: b.h.toFixed(1), class: "bar c-" + b.color });
      r.appendChild(sv("title", null, chart.labels[b.li] + (chart.series.length > 1 ? " · " + chart.series[b.si].name : "") + ": " + RT.fmtValue(b.v, chart.unit)));
      svg.appendChild(r);
      if (b.showLabel) svg.appendChild(sv("text", { x: (b.x + b.w / 2).toFixed(1), y: b.labelY.toFixed(1), "text-anchor": "middle", class: "vl " + (b.up ? "up" : "down") },
        RT.glyph(b.v) + " " + RT.fmtValue(b.v, chart.unit)));
    });
    g.lines.forEach(function (ln) {
      ln.segments.forEach(function (seg) {
        if (seg.length > 1) svg.appendChild(sv("path", { d: seg.map(function (p, i) { return (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1); }).join(" "), class: "ln c-" + ln.color + (ln.si > 3 ? " dash" : "") }));
      });
      ln.points.forEach(function (p) {
        var c = sv("circle", { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 3.5, class: "pt c-" + ln.color });
        c.appendChild(sv("title", null, chart.labels[p.li] + " · " + chart.series[ln.si].name + ": " + RT.fmtValue(p.v, chart.unit)));
        svg.appendChild(c);
        if (ln.showLabels) svg.appendChild(sv("text", { x: p.x.toFixed(1), y: (p.v >= 0 ? p.y - 8 : p.y + 16).toFixed(1), "text-anchor": "middle", class: "vl " + (p.v >= 0 ? "up" : "down") },
          RT.glyph(p.v) + " " + RT.fmtValue(p.v, chart.unit)));
      });
    });
    fig.appendChild(svg);
    if (g.legend.length) {
      var lg = h("ul", { class: "rt-legend", "aria-label": "Legend" });
      g.legend.forEach(function (it) { lg.appendChild(h("li", null, h("span", { class: "sw2 c-" + it.color, "aria-hidden": "true" }), it.name)); });
      fig.appendChild(lg);
    }
    // the numbers as a table: for screen readers and for anyone who wants exact values
    var tbl = h("table"), thead = h("tr", null, h("th", { scope: "col", text: "" }));
    chart.series.forEach(function (s) { thead.appendChild(h("th", { scope: "col", class: "num", text: s.name })); });
    tbl.appendChild(h("thead", null, thead));
    var tb = h("tbody");
    chart.labels.forEach(function (l, li) {
      var tr = h("tr", null, h("th", { scope: "row", text: l }));
      chart.series.forEach(function (s) { var v = s.values[li]; tr.appendChild(h("td", { class: "num", text: v == null ? "n/a" : RT.glyph(v) + " " + RT.fmtValue(v, chart.unit) })); });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    fig.appendChild(h("details", { class: "rt-data" }, h("summary", { text: "Chart data" }), h("div", { class: "rt-table" }, tbl)));
    (warnings || []).forEach(function (w) { fig.appendChild(notice(w)); });
    el.appendChild(fig);
  }

  function renderRich(text, into, evidence) {
    var known = {};
    evidence.forEach(function (e) { known[e.id] = e.text; });
    var prep = RT.prepare(text);
    return core().then(function () {
      var frag = PURIFY.sanitize(MD.parse(prep.md), MD_PURIFY);
      var box = h("div", { class: "rt" });
      box.appendChild(frag);
      decorateTables(box);
      var jobs = { math: [], blocks: [] };
      weave(box, prep, known, jobs);
      into.appendChild(box);
      return Promise.all([renderMath(jobs.math)].concat(jobs.blocks.map(renderBlock)));
    }, function () {
      // the markdown library did not load: plain text, still safe
      into.appendChild(h("div", { class: "rt plain", text: text }));
    });
  }

  /* ---------- state ---------- */
  var S = { server: null, model: "", threads: {}, ev: null, busy: false, lang: "en", opener: null };
  var statusReady = (APP && APP.getJSON ? APP.getJSON("api/status") : Promise.reject())
    .then(function (st) { S.server = !!(st && st.chat && st.chat.enabled); S.model = (st && st.chat && st.chat.model) || ""; })
    .catch(function () { S.server = false; })
    .then(function () { paintMode(); });

  var SUGG = {
    en: ["Explain this release in plain words", "Table of the verified figures", "Chart: the rToken move vs the stock's opening gap", "How much of the gap was priced in?"],
    es: ["Explícame este release en simple", "Tabla de cifras verificadas", "Gráfico: movimiento del rToken vs gap de la acción", "¿Cuánto del gap estaba descontado?"],
  };
  try { if (/^es\b/i.test(navigator.language || "")) S.lang = "es"; } catch (e) { /* default en */ }

  function thread() { return S.ev ? (S.threads[S.ev.id] = S.threads[S.ev.id] || []) : []; }
  function evidence() { return APP ? APP.evidence() : []; }

  /* ---------- painting ---------- */
  function paintMode() {
    var byok = $("byok");
    if (S.server) {
      byok.hidden = true;
      $("chat-model").textContent = S.model ? "model " + S.model : "server model";
    } else {
      byok.hidden = false;
      if (!KEY) byok.open = true;
      $("chat-model").textContent = "your key";
    }
  }

  function paintContext() {
    var ev = S.ev;
    var ce = $("chat-ev"); clear(ce);
    if (ev) {
      ce.appendChild(document.createTextNode("r" + ev.ticker + " · " + (ev.period_label ? ev.period_label + " · " : "")));
      ce.appendChild(h("span", { class: "nowrap", text: "filed " + ev.filing_date }));
    } else ce.textContent = "no release selected";
    $("chat-launch-ev").textContent = ev ? "r" + ev.ticker : "";
    $("chat").setAttribute("aria-label", ev ? "Ask PrintGap about " + ev.ticker + " " + ev.filing_date : "Ask PrintGap");
  }

  function paintSuggestions() {
    var ul = $("chat-sugg"); clear(ul);
    var measuredNight = APP && APP.measured ? APP.measured() : true;
    SUGG[S.lang].forEach(function (q, i) {
      if (!measuredNight && (i === 2 || i === 3)) return;
      var b = h("button", { type: "button", class: "chip-q", text: q });
      b.addEventListener("click", function () { send(q); });
      ul.appendChild(h("li", null, b));
    });
    Array.prototype.forEach.call(document.querySelectorAll(".ci-lang button"), function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-lang") === S.lang ? "true" : "false"); });
  }

  function paintThread() {
    var log = $("chat-log"); clear(log);
    var t = thread();
    $("chat-intro").hidden = t.length > 0;
    $("chat-clear").disabled = !t.length || S.busy;
    t.forEach(function (m) { log.appendChild(m.node || buildMsg(m)); });
    paintStatus();
    scrollEnd(false);
  }

  function paintStatus() {
    var st = $("chat-status"); clear(st);
    if (S.busy && S.busyEv === (S.ev && S.ev.id)) {
      st.appendChild(h("span", { class: "typing", "aria-hidden": "true" }, h("i"), h("i"), h("i")));
      st.appendChild(document.createTextNode("Reading the evidence"));
      st.className = "chat-status on";
    } else if (S.busy) {
      st.textContent = "Still answering a question about another release.";
      st.className = "chat-status on";
    } else st.className = "chat-status";
  }

  function scrollEnd(smooth) {
    var b = $("chat-body");
    b.scrollTo({ top: b.scrollHeight, behavior: smooth && !reduced() ? "smooth" : "auto" });
  }

  function head(label, extra, t) {
    return h("p", { class: "msg-h" }, h("span", { class: "msg-who", text: label }), extra ? h("span", { class: "msg-m", text: extra }) : null, h("time", { text: clock(t) }));
  }

  function buildMsg(m) {
    var li;
    if (m.role === "user") {
      li = h("li", { class: "msg u" }, head("You", null, m.t), h("div", { class: "msg-b", text: m.content }));
    } else if (m.error) {
      var retry = h("button", { type: "button", class: "ch-btn", text: "Try again" });
      retry.addEventListener("click", function () { retryLast(m); });
      li = h("li", { class: "msg a err" }, head("Analyst", null, m.t),
        h("p", { class: "err-t" }, h("strong", { text: m.info.title + ". " }), m.info.text),
        m.info.retry ? h("div", { class: "msg-tools" }, retry) : null);
    } else {
      var body = h("div", { class: "msg-b" });
      li = h("li", { class: "msg a" }, head("Analyst", m.model, m.t), body);
      var v = RT.verdict(m.content, m.evIds);
      var flags = h("div", { class: "msg-flags" });
      if (v.kind === "empty") flags.appendChild(flag("The model returned an empty answer. Reasoning models can spend their whole budget thinking; try again or pick a smaller model."));
      else if (v.kind === "bogus") flags.appendChild(flag("This answer cites evidence that does not exist (" + v.bogus.join(", ") + "). Do not rely on it."));
      else if (v.kind === "uncited") flags.appendChild(flag("This answer cites no evidence. Treat it as unsupported."));
      if (flags.firstChild) li.appendChild(flags);
      var copy = h("button", { type: "button", class: "ch-btn", text: "Copy answer" });
      copy.addEventListener("click", function () {
        (navigator.clipboard ? navigator.clipboard.writeText(m.content) : Promise.reject()).then(
          function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy answer"; }, 1500); },
          function () { copy.textContent = "Copy failed: select the text instead"; });
      });
      li.appendChild(h("div", { class: "msg-tools" }, copy, h("span", { class: "msg-cites", text: v.cited.length ? "cites " + v.cited.join(" ") : "" })));
      m.rendered = renderRich(m.content, body, m.evidence || []).then(function () { if (m.follow) scrollToMsg(li); });
    }
    m.node = li;
    return li;
  }
  function flag(text) { return h("p", { class: "flag" }, h("span", { class: "flag-g", "aria-hidden": "true", text: "✕" }), text); }
  function scrollToMsg(li) {
    var b = $("chat-body");
    if (!li.isConnected) return;
    // show the start of a long answer rather than its end
    var top = li.offsetTop - 8;
    b.scrollTo({ top: top, behavior: reduced() ? "auto" : "smooth" });
  }

  /* ---------- asking ---------- */
  var KEY = "", modelEdited = false;
  var FORMAT = "Format: GitHub-flavored Markdown (tables allowed), LaTeX math in $...$ or $$...$$, diagrams in ```mermaid blocks, " +
    "charts in ```chart blocks holding JSON {\"type\":\"bar\"|\"line\",\"title\",\"unit\",\"labels\":[],\"series\":[{\"name\",\"values\":[]}]} " +
    "with every value taken from the evidence. Reply in the user's language.";

  function request(ev, q, history, E) {
    if (S.server) {
      return fetch("api/ask", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_id: ev.id, question: q, history: history }) })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (!r.ok) throw { status: r.status, message: j && j.error };
            return { text: String(j.answer || ""), model: j.model || S.model };
          });
        }, function () { throw { network: true }; });
    }
    var provider = $("prov").value, model = $("model").value.trim(), base = $("base").value.trim(), req;
    var sys = PG.chatSystem(E);
    sys = sys.indexOf("\n\nEVIDENCE:\n") > -1 ? sys.replace("\n\nEVIDENCE:\n", "\n" + FORMAT + "\n\nEVIDENCE:\n") : sys + "\n" + FORMAT;
    try { req = PG.chatRequest(provider, model, KEY, base, sys, RT.withHistory(history, q)); }
    catch (e) { return Promise.reject({ local: true, message: e.message }); }
    return fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw { status: r.status, message: PG.chatError(j, r.status) };
          return { text: PG.chatText(provider, j), model: model };
        });
      }, function () { throw { network: true, byok: true }; });
  }

  function send(raw) {
    var q = String(raw || "").trim();
    if (!q || S.busy || !S.ev) return;
    if (q.length > MAXQ) { setStatusText("Keep the question under " + MAXQ + " characters."); return; }
    var t = thread();
    var history = RT.historyFor(t, TURNS);
    var um = { role: "user", content: q, t: Date.now() };
    t.push(um);
    $("q").value = ""; autosize(); count();
    $("chat-intro").hidden = true;
    $("chat-log").appendChild(buildMsg(um));
    ask(S.ev, q, history, t, evidence());
  }

  // E is the evidence list of the release asked about, captured when the question was sent
  function ask(ev, q, history, t, E) {
    S.busy = true; S.busyEv = ev.id;
    $("chat-send").disabled = true; $("chat-clear").disabled = true;
    paintStatus(); scrollEnd(true);
    statusReady.then(function () { return request(ev, q, history, E); }).then(function (res) {
      return { role: "assistant", content: res.text, model: res.model, t: Date.now(), evidence: E, evIds: E.map(function (e) { return e.id; }), follow: true };
    }, function (err) {
      var info = err.local ? { title: "Add your key first", text: err.message + " Open “Use your own model key” below. The memo in the Evidence desk works without a key.", retry: false }
        : err.network && err.byok ? { title: "No answer from the provider", text: "Either the network failed or this provider does not accept calls from a web page (CORS). The memo works without a key.", retry: true }
        : RT.errorInfo(err.status || 0, err.message, !!err.network);
      return { role: "assistant", error: true, info: info, q: q, history: history, E: E, t: Date.now() };
    }).then(function (am) {
      t.push(am);
      S.busy = false;
      $("chat-send").disabled = false;
      if (S.ev && S.ev.id === ev.id) {
        $("chat-log").appendChild(buildMsg(am));
        $("chat-clear").disabled = false;
        if (am.error && am.info && am.info.title === "Add your key first") { $("byok").open = true; }
      }
      paintStatus();
      if (am.error) scrollEnd(true);
      else if (am.node) scrollToMsg(am.node);
    });
  }

  function retryLast(m) {
    if (S.busy) return;
    var t = thread(), i = t.indexOf(m);
    if (i < 0) return;
    t.splice(i, 1);
    if (m.node && m.node.parentNode) m.node.parentNode.removeChild(m.node);
    ask(S.ev, m.q, m.history, t, m.E);
  }

  function setStatusText(txt) { var st = $("chat-status"); st.className = "chat-status on"; st.textContent = txt; }

  /* ---------- citations -> the Evidence desk ---------- */
  $("chat-log").addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("button.cite");
    if (!b) return;
    var row = document.getElementById("evi-" + b.getAttribute("data-e"));
    if (!row) return;
    var full = narrow();
    if (full) close(false);
    Array.prototype.forEach.call(document.querySelectorAll("#evidence li.hl"), function (x) { x.classList.remove("hl"); });
    void row.offsetWidth;
    row.classList.add("hl");
    row.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
    if (full) row.focus({ preventScroll: true });
    clearTimeout(row._hl);
    row._hl = setTimeout(function () { row.classList.remove("hl"); }, 2600);
  });

  /* ---------- open / close ---------- */
  var panel = $("chat"), launch = $("chat-launch");
  function open() {
    if (!panel.hidden) { $("q").focus(); return; }
    S.opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : launch;
    panel.hidden = false;
    launch.setAttribute("aria-expanded", "true");
    launch.hidden = true;
    var full = narrow();
    panel.setAttribute("aria-modal", full ? "true" : "false");
    document.documentElement.classList.toggle("chat-lock", full);
    core().catch(function () {}); // warm the markdown libraries while the reader types
    paintThread();
    $("q").focus();
  }
  function close(restore) {
    if (panel.hidden) return;
    panel.hidden = true;
    launch.hidden = false;
    launch.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("chat-lock");
    if (restore !== false) launch.focus();
  }
  launch.addEventListener("click", open);
  $("chat-close").addEventListener("click", function () { close(); });
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab" && panel.getAttribute("aria-modal") === "true") {
      var f = Array.prototype.filter.call(panel.querySelectorAll("button, [href], input, select, textarea, summary, [tabindex]:not([tabindex='-1'])"),
        function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  window.addEventListener("resize", function () {
    if (panel.hidden) return;
    var full = narrow();
    panel.setAttribute("aria-modal", full ? "true" : "false");
    document.documentElement.classList.toggle("chat-lock", full);
  });

  $("chat-clear").addEventListener("click", function () {
    if (!S.ev || S.busy) return;
    S.threads[S.ev.id] = [];
    paintThread();
    setStatusText("Conversation cleared.");
    $("q").focus();
  });

  /* ---------- composer ---------- */
  var q = $("q");
  function autosize() { q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight + 2, 140) + "px"; }
  function count() { var n = q.value.length; $("chat-count").textContent = n + "/" + MAXQ; $("chat-count").className = "cf-count" + (n > MAXQ * 0.9 ? " near" : ""); }
  q.addEventListener("input", function () { autosize(); count(); });
  q.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(q.value); }
  });
  $("chat-form").addEventListener("submit", function (e) { e.preventDefault(); send(q.value); });

  Array.prototype.forEach.call(document.querySelectorAll(".ci-lang button"), function (b) {
    b.addEventListener("click", function () { S.lang = b.getAttribute("data-lang"); paintSuggestions(); });
  });

  /* ---------- bring your own key (static hosting only) ---------- */
  function syncProvider() {
    var pv = PG.PROVIDERS[$("prov").value];
    $("base-row").hidden = !pv.custom;
    if (!modelEdited) $("model").value = pv.model;
    $("model").placeholder = pv.custom ? "the model name your endpoint expects" : pv.model;
  }
  $("prov").addEventListener("change", function () { modelEdited = false; syncProvider(); });
  $("model").addEventListener("input", function () { modelEdited = true; });
  $("key").addEventListener("input", function (e) {
    KEY = e.target.value.trim();
    $("byok-state").textContent = KEY ? "key in memory" : "no key";
    $("byok-state").className = "byok-state" + (KEY ? " on" : "");
  });
  syncProvider();

  /* ---------- public ---------- */
  window.PGChat = {
    open: open,
    close: close,
    setEvent: function (ev) {
      S.ev = ev;
      paintContext();
      paintSuggestions();
      if (!panel.hidden) paintThread();
    },
  };
  if (APP && APP.current()) window.PGChat.setEvent(APP.current());
  else { paintContext(); paintSuggestions(); }
})();
