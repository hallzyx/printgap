/* Pure helpers for the chat renderer (no DOM), so they can be tested with Node.
   The model's answer is untrusted text. Nothing here builds HTML: it splits the answer into
   markdown, math, chart and diagram pieces, validates chart JSON, lays charts out as plain
   numbers, and checks citations. The DOM layer (chat.js) draws the result with textContent,
   KaTeX, mermaid (strict) and DOMPurify. */
(function (root) {
  "use strict";

  var MAX_LABELS = 24, MAX_SERIES = 6, MAX_CHART_SRC = 20000;

  /* ---------- 1. split the answer: fenced chart/mermaid blocks and math become placeholders ---------- */
  // Placeholders are plain letters so markdown leaves them alone (no _, *, |, $ or \ inside).
  function mathToken(i) { return "PGMATH" + i + "Z"; }
  function blockToken(i) { return "PGBLOCK" + i + "Z"; }
  var TEXISH = /[\\^_{}=]/;

  // $...$, $$...$$, \(...\), \[...\] outside inline code. Money like "$35.1B to $40B" stays text.
  function protectMath(text, math) {
    var out = "", i = 0, n = text.length;
    while (i < n) {
      var c = text[i];
      if (c === "`") { // inline code span: copy verbatim up to the matching run
        var run = 0; while (text[i + run] === "`") run += 1;
        var fence = text.substr(i, run), end = text.indexOf(fence, i + run);
        while (end > -1 && text[end + run] === "`") end = text.indexOf(fence, end + run + 1);
        if (end < 0) { out += fence; i += run; continue; }
        out += text.slice(i, end + run); i = end + run; continue;
      }
      if (c === "\\") {
        var nx = text[i + 1];
        if (nx === "$") { out += "\\$"; i += 2; continue; }
        if (nx === "[" || nx === "(") {
          var close = nx === "[" ? "\\]" : "\\)", j = text.indexOf(close, i + 2);
          var body = j > -1 ? text.slice(i + 2, j) : "";
          if (j > -1 && body.trim() && (nx === "[" || body.indexOf("\n") < 0)) {
            math.push({ tex: body.trim(), display: nx === "[" });
            out += mathToken(math.length - 1); i = j + 2; continue;
          }
        }
        out += c + (nx || ""); i += 2; continue;
      }
      if (c === "$" && text[i + 1] === "$") {
        var k = text.indexOf("$$", i + 2);
        if (k > -1 && text.slice(i + 2, k).trim()) {
          math.push({ tex: text.slice(i + 2, k).trim(), display: true });
          out += mathToken(math.length - 1); i = k + 2; continue;
        }
        out += "$$"; i += 2; continue;
      }
      if (c === "$") {
        var first = text[i + 1];
        if (first && !/\s/.test(first)) {
          var m = i + 1, found = -1;
          while (m < n) {
            var d = text[m];
            if (d === "\n") break;
            if (d === "\\") { m += 2; continue; }
            if (d === "$") {
              if (!/\s/.test(text[m - 1]) && !/[0-9]/.test(text[m + 1] || "") && text[m + 1] !== "$") found = m;
              break;
            }
            m += 1;
          }
          if (found > -1) {
            var tex = text.slice(i + 1, found);
            // "$35.1B and $" would close on the second dollar sign; a number after the opener needs TeX in it
            if (!/[0-9]/.test(first) || TEXISH.test(tex) || /^[\d.,%+\-−*/()]+$/.test(tex)) {
              math.push({ tex: tex, display: false });
              out += mathToken(math.length - 1); i = found + 1; continue;
            }
          }
        }
        out += "$"; i += 1; continue;
      }
      out += c; i += 1;
    }
    return out;
  }

  var FENCE = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/;
  function prepare(src) {
    var lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
    var out = [], buf = [], blocks = [], math = [];
    function flush() { if (buf.length) { out.push(protectMath(buf.join("\n"), math)); buf = []; } }
    for (var i = 0; i < lines.length; i++) {
      var f = FENCE.exec(lines[i]);
      if (!f) { buf.push(lines[i]); continue; }
      var ch = f[2][0], len = f[2].length, lang = f[3].toLowerCase(), j = i + 1;
      while (j < lines.length) {
        var t = lines[j].trim();
        if (t.length >= len && t.replace(new RegExp("\\" + ch, "g"), "") === "" ) break;
        j += 1;
      }
      var inner = lines.slice(i + 1, j).join("\n");
      flush();
      if (lang === "chart" || lang === "mermaid") {
        blocks.push({ kind: lang, src: inner, closed: j < lines.length });
        out.push("\n" + f[1] + blockToken(blocks.length - 1) + "\n");
      } else {
        out.push(lines.slice(i, Math.min(j + 1, lines.length)).join("\n"));
      }
      i = j;
    }
    flush();
    return { md: out.join("\n"), blocks: blocks, math: math };
  }

  /* ---------- 2. inline tokens inside a rendered text node ---------- */
  var INLINE = /PGMATH(\d+)Z|PGBLOCK(\d+)Z|\[(E\d{1,3}(?:\s*[,;]\s*E\d{1,3})*)\]/g;
  function tokenizeInline(str) {
    var segs = [], last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(str))) {
      if (m.index > last) segs.push({ type: "text", text: str.slice(last, m.index) });
      if (m[1] != null) segs.push({ type: "math", i: +m[1] });
      else if (m[2] != null) segs.push({ type: "block", i: +m[2] });
      else segs.push({ type: "cite", ids: m[3].split(/\s*[,;]\s*/) });
      last = INLINE.lastIndex;
    }
    if (last < str.length) segs.push({ type: "text", text: str.slice(last) });
    return segs;
  }

  /* ---------- 3. citations: every id must exist in the evidence list shown on the page ---------- */
  var ABSTAIN = /evidence does not cover that|la evidencia no (cubre|contiene|incluye|abarca)/i;
  function citedIds(text) {
    var ids = [], seen = {}, m, re = /\[(E\d{1,3}(?:\s*[,;]\s*E\d{1,3})*)\]/g;
    while ((m = re.exec(String(text || "")))) {
      m[1].split(/\s*[,;]\s*/).forEach(function (id) { if (!seen[id]) { seen[id] = 1; ids.push(id); } });
    }
    return ids;
  }
  function verdict(text, evidenceIds) {
    var known = {};
    (evidenceIds || []).forEach(function (id) { known[id] = 1; });
    var t = String(text || "").trim(), cited = citedIds(t);
    var bogus = cited.filter(function (id) { return !known[id]; });
    var abstain = ABSTAIN.test(t);
    var kind = !t ? "empty" : bogus.length ? "bogus" : (!cited.length && !abstain) ? "uncited" : abstain && !cited.length ? "abstain" : "ok";
    return { kind: kind, cited: cited, bogus: bogus, abstain: abstain };
  }

  /* ---------- 4. links: only web and mail links survive ---------- */
  function safeHref(href) {
    var h = String(href == null ? "" : href).trim();
    // strip control chars and whitespace browsers ignore inside a scheme ("java\tscript:")
    var probe = h.replace(/[\u0000- \u007f-\u009f]/g, "").toLowerCase();
    if (/^https?:\/\//.test(probe) || /^mailto:/.test(probe)) return h;
    return null;
  }

  /* ---------- 5. charts: validate and normalise the ```chart JSON ---------- */
  function toNum(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (typeof v === "string") {
      var s = v.trim().replace(/−/g, "-").replace(/,/g, "");
      if (/^[+-]?(\d+(\.\d*)?|\.\d+)\s*%?$/.test(s)) return parseFloat(s.replace("%", ""));
    }
    return null;
  }
  function str(v, max) {
    var s = v == null ? "" : typeof v === "object" ? "" : String(v);
    s = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
  function parseChart(src) {
    if (typeof src !== "string" || !src.trim()) return { ok: false, error: "The chart block is empty." };
    if (src.length > MAX_CHART_SRC) return { ok: false, error: "The chart block is too large to draw." };
    var o;
    try { o = JSON.parse(src.trim()); } catch (e) { return { ok: false, error: "The chart block is not valid JSON." }; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "The chart block must be a JSON object." };
    var warnings = [];
    var type = o.type === "line" ? "line" : "bar";
    if (o.type != null && o.type !== "bar" && o.type !== "line") warnings.push("Unknown chart type \"" + str(o.type, 20) + "\", drawn as bars.");
    var series = Array.isArray(o.series) ? o.series : Array.isArray(o.values) ? [{ name: o.name || o.title, values: o.values }] : null;
    if (!series || !series.length) return { ok: false, error: "The chart has no series to draw." };
    if (series.length > MAX_SERIES) { warnings.push("Only the first " + MAX_SERIES + " series are drawn."); series = series.slice(0, MAX_SERIES); }
    var labels = Array.isArray(o.labels) ? o.labels.map(function (l) { return str(l, 60); }) : null;
    var longest = 0;
    series.forEach(function (s) { if (s && Array.isArray(s.values)) longest = Math.max(longest, s.values.length); });
    if (!labels || !labels.length) {
      if (!longest) return { ok: false, error: "The chart has no labels or values." };
      labels = []; for (var i = 0; i < longest; i++) labels.push(String(i + 1));
      warnings.push("The chart came without labels; points are numbered.");
    }
    if (labels.length > MAX_LABELS) { warnings.push("Only the first " + MAX_LABELS + " labels are drawn."); labels = labels.slice(0, MAX_LABELS); }
    var bad = 0, uneven = false, any = false;
    var norm = series.map(function (s, si) {
      s = s && typeof s === "object" ? s : {};
      var raw = Array.isArray(s.values) ? s.values : [];
      if (raw.length !== labels.length) uneven = true;
      var vals = labels.map(function (_, li) {
        if (li >= raw.length) return null;
        var v = toNum(raw[li]);
        if (v == null) bad += 1; else any = true;
        return v;
      });
      return { name: str(s.name, 60) || (series.length === 1 ? str(o.title, 60) || "Value" : "Series " + (si + 1)), values: vals };
    });
    if (!any) return { ok: false, error: "The chart has no numeric values." };
    if (uneven) warnings.push("A series did not have one value per label; missing points are left blank.");
    if (bad) warnings.push(bad + " value" + (bad === 1 ? " was" : "s were") + " not a number and " + (bad === 1 ? "is" : "are") + " left blank.");
    return { ok: true, warnings: warnings, chart: { type: type, title: str(o.title, 120), unit: str(o.unit, 12), labels: labels, series: norm } };
  }

  /* entity colour: amber for the rToken, ice blue for the cash stock, as everywhere else on the page */
  function colorKey(name) {
    var s = String(name || "");
    if (/\br[A-Z]{2,5}\b/.test(s) || /rtoken|token|bitget|overnight|nocturn/i.test(s)) return "rt";
    if (/cash|stock|acci[oó]n|share|gap|open|apertura|equity|nasdaq|nyse/i.test(s)) return "cash";
    if (/verif|xbrl|sec\b/i.test(s)) return "ok";
    return null;
  }
  function assignColors(names) {
    var used = {}, spare = ["ok", "n1", "n2", "n3", "cash", "rt"];
    var keys = names.map(function (n) { var k = colorKey(n); if (k && !used[k]) { used[k] = 1; return k; } return null; });
    return keys.map(function (k) {
      if (k) return k;
      for (var i = 0; i < spare.length; i++) if (!used[spare[i]]) { used[spare[i]] = 1; return spare[i]; }
      return "n2";
    });
  }

  function trimNum(v, digits) {
    var s = Math.abs(v).toFixed(digits == null ? 2 : digits);
    if (s.indexOf(".") > -1) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }
  function fmtValue(v, unit) {
    if (v == null || !isFinite(v)) return "n/a";
    var sign = v > 0 ? "+" : v < 0 ? "−" : "";
    var u = unit || "";
    return sign + trimNum(v) + (u === "%" ? "%" : u ? " " + u : "");
  }
  function glyph(v) { return v == null ? "" : v > 0 ? "▲" : v < 0 ? "▼" : "◆"; }

  function niceStep(raw) {
    if (!(raw > 0) || !isFinite(raw)) return 1;
    var p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  function fitLabel(text, px) {
    var max = Math.max(3, Math.floor(px / 6.6));
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  // Layout in plain numbers. The zero line is always inside the domain.
  function chartLayout(chart, W, H) {
    var pad = { l: 48, r: 12, t: 22, b: 30 };
    var x0 = pad.l, x1 = W - pad.r, y0 = pad.t, y1 = H - pad.b;
    var vals = [0];
    chart.series.forEach(function (s) { s.values.forEach(function (v) { if (v != null) vals.push(v); }); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (lo === hi) hi = lo + 1;
    var step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step + 1e-9) * step; hi = Math.ceil(hi / step - 1e-9) * step;
    if (lo === hi) hi = lo + step;
    function Y(v) { return y1 - ((v - lo) / (hi - lo)) * (y1 - y0); }
    var ticks = [];
    for (var v = lo, guard = 0; v <= hi + step / 2 && guard < 40; v += step, guard++) {
      var vv = Math.abs(v) < step / 1e6 ? 0 : v;
      ticks.push({ v: vv, y: Y(vv), text: fmtValue(vv, chart.unit) });
    }
    var nL = chart.labels.length, nS = chart.series.length, band = (x1 - x0) / nL;
    var single = nS === 1;
    var colors = single ? assignColors(chart.labels) : assignColors(chart.series.map(function (s) { return s.name; }));
    var zeroY = Y(0), bars = [], lines = [];
    if (chart.type === "bar") {
      var inner = band * (nS === 1 ? 0.56 : 0.78), bw = inner / nS;
      chart.series.forEach(function (s, si) {
        s.values.forEach(function (val, li) {
          if (val == null) return;
          var x = x0 + band * li + (band - inner) / 2 + bw * si, yv = Y(val);
          bars.push({ x: x, w: Math.max(1, bw - (nS > 1 ? 2 : 0)), y: Math.min(yv, zeroY), h: Math.max(1, Math.abs(zeroY - yv)),
            v: val, up: val >= 0, li: li, si: si, color: single ? colors[li] : colors[si],
            labelY: val >= 0 ? yv - 6 : yv + 14, showLabel: bw >= 30 });
        });
      });
    } else {
      chart.series.forEach(function (s, si) {
        var segs = [], cur = [], pts = [];
        s.values.forEach(function (val, li) {
          if (val == null) { if (cur.length) segs.push(cur); cur = []; return; }
          var p = { x: x0 + band * (li + 0.5), y: Y(val), v: val, li: li };
          cur.push(p); pts.push(p);
        });
        if (cur.length) segs.push(cur);
        lines.push({ si: si, color: single ? "rt" : colors[si], segments: segs, points: pts, showLabels: nL <= 6 && nS <= 2 });
      });
    }
    var xLabels = chart.labels.map(function (l, li) { return { x: x0 + band * (li + 0.5), text: fitLabel(l, band - 4), full: l }; });
    return { W: W, H: H, x0: x0, x1: x1, y0: y0, y1: y1, zeroY: zeroY, lo: lo, hi: hi, ticks: ticks, bars: bars, lines: lines,
      xLabels: xLabels, legend: single ? [] : chart.series.map(function (s, si) { return { name: s.name, color: colors[si] }; }), colors: colors };
  }

  function chartSummary(chart) {
    var parts = [];
    chart.labels.forEach(function (l, li) {
      var vs = chart.series.map(function (s) {
        var v = s.values[li];
        return (chart.series.length > 1 ? s.name + " " : "") + (v == null ? "no value" : (v > 0 ? "up " : v < 0 ? "down " : "") + fmtValue(v, chart.unit));
      });
      parts.push(l + ": " + vs.join(", "));
    });
    return (chart.title ? chart.title + ". " : "") + (chart.type === "line" ? "Line chart. " : "Bar chart. ") + parts.join("; ") + ".";
  }

  /* ---------- 6. conversation plumbing ---------- */
  // Last n finished turns, in the shape /api/ask accepts.
  function historyFor(thread, n) {
    var t = (thread || []).filter(function (m) { return m && !m.error && !m.pending && (m.role === "user" || m.role === "assistant") && typeof m.content === "string"; });
    // drop a trailing question that never got an answer
    var pairs = [];
    for (var i = 0; i < t.length; i++) {
      if (t[i].role === "user" && t[i + 1] && t[i + 1].role === "assistant") { pairs.push(t[i], t[i + 1]); i += 1; }
    }
    return pairs.slice(-(n || 6)).map(function (m) { return { role: m.role, content: m.content.slice(0, 2500) }; });
  }
  // Same wording as the server's _with_history, for the bring-your-own-key mode.
  function withHistory(history, question) {
    var turns = (history || []).map(function (m) { return (m.role === "user" ? "User: " : "Assistant: ") + String(m.content).trim().slice(0, 2500); });
    if (!turns.length) return question;
    return "Conversation so far (context only):\n" + turns.join("\n") + "\n\nNew question: " + question;
  }

  function errorInfo(status, message, network) {
    if (network) return { title: "No connection", text: "The question did not reach the PrintGap server. Check the connection and try again.", retry: true };
    if (status === 429) return { title: "Question limit reached", text: message || "Too many questions for now. Try again later.", retry: true };
    if (status === 502 || status === 503 || status === 504) return { title: "The model is unavailable", text: message || "The model could not answer right now.", retry: true };
    if (status >= 500) return { title: "Server error", text: message || "HTTP " + status, retry: true };
    return { title: "The question was refused", text: message || "HTTP " + status, retry: status !== 400 && status !== 404 };
  }

  // A long left-to-right flowchart is unreadable in a 400px panel; top-down reads the same story.
  function mermaidForNarrow(src) {
    var s = String(src || "");
    var arrows = (s.match(/-->|==>|-\.->|---/g) || []).length;
    if (arrows < 3) return s;
    return s.replace(/^(\s*(?:flowchart|graph))\s+(LR|RL)\b/m, "$1 TD");
  }

  function looksNumeric(cell) {
    var s = String(cell || "").trim().replace(/\s*\[E\d{1,3}(?:\s*[,;]\s*E\d{1,3})*\]\s*/g, "");
    return /^[▲▼+\-−(]*\s*[$€£]?\s*[+\-−]?\d[\d,.]*\s*(%|[kKmMbB]n?|bps?|x|USD)?\)?$/.test(s);
  }

  var api = { prepare: prepare, protectMath: protectMath, tokenizeInline: tokenizeInline, citedIds: citedIds, verdict: verdict,
    safeHref: safeHref, parseChart: parseChart, toNum: toNum, colorKey: colorKey, assignColors: assignColors, fmtValue: fmtValue,
    glyph: glyph, niceStep: niceStep, chartLayout: chartLayout, chartSummary: chartSummary, historyFor: historyFor,
    withHistory: withHistory, errorInfo: errorInfo, looksNumeric: looksNumeric, mermaidForNarrow: mermaidForNarrow, mathToken: mathToken, blockToken: blockToken };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RT = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
