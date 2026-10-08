/* Pure functions (no DOM) so they can be tested with Node. */
(function (root) {
  "use strict";

  var METRIC_LABEL = {
    revenue: "Revenue",
    net_income: "Net income (GAAP)",
    eps_diluted: "Diluted EPS (GAAP)",
    operating_income: "Operating income",
    gross_profit: "Gross profit",
    gross_margin_pct: "Gross margin (GAAP)",
    guidance_revenue_low: "Next-quarter revenue guidance, low",
    guidance_revenue_high: "Next-quarter revenue guidance, high",
    guidance_revenue_mid: "Next-quarter revenue guidance, midpoint",
    guidance_tolerance_pct: "Guidance tolerance (+/-)",
    guidance_gross_margin_pct: "Next-quarter gross margin guidance",
  };

  function money(v) {
    var a = Math.abs(v);
    if (a >= 1e9) return "$" + (v / 1e9).toFixed(a >= 1e11 ? 1 : 2) + "B";
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(1) + "M";
    return "$" + v.toFixed(2);
  }

  function fmtValue(c) {
    if (c.unit === "USD") return money(c.value);
    if (c.unit === "USD_per_share") return "$" + Number(c.value).toFixed(2);
    return Number(c.value).toFixed(1) + "%";
  }

  // log return -> signed percent string
  function pct(logret, digits) {
    if (logret == null || isNaN(logret)) return "n/a";
    var p = (Math.exp(logret) - 1) * 100;
    return (p >= 0 ? "+" : "") + p.toFixed(digits == null ? 2 : digits) + "%";
  }
  function pctPlain(p, digits) {
    if (p == null || isNaN(p)) return "n/a";
    return (p >= 0 ? "+" : "") + p.toFixed(digits == null ? 1 : digits) + "%";
  }

  function hours(min) {
    var h = Math.floor(min / 60), m = Math.round(min - h * 60);
    return h + "h " + (m < 10 ? "0" : "") + m + "m";
  }

  /* One sentence that says what happened, from the computed numbers only. */
  function headline(ev) {
    var r = ev.reaction;
    if (!r || !r.ok) return null;
    var sym = "r" + ev.ticker;
    var s = sym + " moved " + pct(r.rt_move) + " while the US cash market was closed; the stock then opened " +
      pct(r.cash_gap) + ".";
    if (r.priced_in != null) {
      s += " The rToken had priced in " + Math.round(r.priced_in * 100) + "% of that gap.";
    } else {
      s += " The gap is too small for a priced-in ratio to mean anything.";
    }
    return s;
  }

  /* Numbered evidence list: the ONLY facts the chat and the memo may use. */
  function evidence(ev, analogs) {
    var E = [], n = 0;
    function add(text, kind) { n += 1; E.push({ id: "E" + n, text: text, kind: kind }); }
    (ev.claims || []).forEach(function (c) {
      if (c.status === "rejected") return;
      var tag = c.status === "verified" ? "verified against SEC XBRL" : "quote verified in the release, no XBRL fact yet";
      add((METRIC_LABEL[c.metric] || c.metric) + " = " + fmtValue(c) + " (" + tag + '). Source quote: "' + c.quote + '"', "claim");
    });
    var g = ev.gap;
    if (g && g.available) {
      add("Reported revenue " + money(g.actual) + " vs prior-quarter company guidance " + money(g.guide_low) + " to " +
        money(g.guide_high) + " (midpoint " + money(g.guide_mid) + "): " + pctPlain(g.vs_mid_pct) + " vs midpoint, " +
        g.position + ". This is guidance, not analyst consensus.", "gap");
    }
    if (ev.yoy_revenue_pct != null) {
      add("Revenue growth vs the year-ago quarter: " + pctPlain(ev.yoy_revenue_pct) + " (from SEC XBRL).", "yoy");
    }
    var r = ev.reaction;
    if (r && r.ok) {
      add("r" + ev.ticker + " moved " + pct(r.rt_move) + " from the 16:00 ET close to 09:25 ET (" + pct(r.rt_pre_pub) +
        " before the release, " + pct(r.rt_post_pub) + " after it).", "reaction");
      add("The cash stock opened " + pct(r.cash_gap) + " vs its prior close. The rToken's last price before the open was " +
        pct(r.residual) + " away from that opening price.", "reaction");
      if (r.priced_in != null) add("Priced-in ratio (rToken overnight move / cash gap): " + r.priced_in.toFixed(2) + ".", "reaction");
    } else if (r) {
      add("Reaction not measured: " + (r.reason || "unknown reason") + ".", "reaction");
    }
    if (analogs) {
      add("Across " + analogs.n_valid + " measured earnings release" + (analogs.n_valid === 1 ? "" : "s") + " in this dataset" +
        (analogs.median_priced_in != null ? ", the median priced-in ratio is " + analogs.median_priced_in.toFixed(2) +
          " (" + analogs.n_with_ratio + " with a usable ratio)" : "") +
        ". With so few events this is a log, not a forecast.", "analogs");
    }
    return E;
  }

  function memo(ev, analogs) {
    var E = evidence(ev, analogs);
    var L = [];
    L.push("# " + ev.ticker + " earnings read-through");
    L.push("Released " + ev.pub_et + " | SEC filing " + ev.accession + " | " + ev.url);
    L.push("");
    var h = headline(ev);
    if (h) { L.push("**" + h + "**"); L.push(""); }
    L.push("## Evidence");
    E.forEach(function (e) { L.push("- [" + e.id + "] " + e.text); });
    L.push("");
    L.push("## Limits");
    L.push("- Figures marked verified were checked against SEC XBRL; quote-only figures were found in the release but not cross-checked.");
    L.push("- The comparison is against the company's own prior guidance, not analyst consensus.");
    L.push("- Overnight rToken liquidity is thin; the move shown is a price, not a fill you could get.");
    L.push("- PrintGap does not place orders or recommend trades. The decision is yours.");
    return L.join("\n");
  }

  /* Chat prompt: answer only from evidence, cite ids, abstain otherwise. */
  function chatSystem(E) {
    return "You answer a trader's question about ONE earnings release using ONLY the numbered evidence below.\n" +
      "Rules: cite evidence ids like [E3] for every factual statement; if the evidence does not contain the answer, " +
      "say exactly 'The evidence does not cover that.' and stop; never add outside facts, prices, forecasts or trade " +
      "recommendations; keep it under 120 words.\n\nEVIDENCE:\n" +
      E.map(function (e) { return "[" + e.id + "] " + e.text; }).join("\n");
  }

  /* Chart geometry for the overnight timeline. Returns plain numbers; the DOM layer draws them. */
  function chartGeometry(r, W, H, pad) {
    var x0 = pad.l, x1 = W - pad.r, y0 = pad.t, y1 = H - pad.b;
    var span = r.open_minute;
    var ys = r.path.map(function (p) { return p[1]; });
    var cashPct = (Math.exp(r.cash_gap) - 1) * 100;
    ys.push(cashPct, 0);
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    var padY = Math.max(0.15, (hi - lo) * 0.12);
    lo -= padY; hi += padY;
    function X(m) { return x0 + (m / span) * (x1 - x0); }
    function Y(v) { return y1 - ((v - lo) / (hi - lo)) * (y1 - y0); }
    return {
      X: X, Y: Y, lo: lo, hi: hi, x0: x0, x1: x1, y0: y0, y1: y1,
      points: r.path.map(function (p) { return [X(p[0]), Y(p[1])]; }),
      pubX: X(r.pub_minute), openX: X(r.open_minute), preX: X(r.preopen_minute),
      zeroY: Y(0), cashY: Y(cashPct), cashPct: cashPct,
    };
  }


  /* ---- chat providers (browser side). The key goes only to the endpoint of the provider picked. ---- */
  var PROVIDERS = {
    anthropic: { label: "Anthropic", model: "claude-sonnet-5-5", base: "https://api.anthropic.com", custom: false },
    openai: { label: "OpenAI", model: "gpt-6.1-sol", base: "https://api.openai.com/v1", custom: false },
    deepseek: { label: "DeepSeek", model: "deepseek-flash", base: "https://api.deepseek.com", custom: false },
    custom: { label: "Other OpenAI-compatible", model: "", base: "", custom: true },
  };

  function chatRequest(provider, model, key, base, system, question) {
    var p = PROVIDERS[provider];
    if (!p) throw new Error("Unknown provider");
    if (!key) throw new Error("Add an API key.");
    if (!model) throw new Error("Add a model name.");
    if (provider === "anthropic") {
      return {
        url: p.base + "/v1/messages",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true" },
        body: { model: model, max_tokens: 600, temperature: 0, system: system, messages: [{ role: "user", content: question }] },
      };
    }
    var root = p.custom ? String(base || "").replace(/\/+$/, "") : p.base;
    if (!/^https:\/\//.test(root)) throw new Error("The endpoint must start with https://");
    var body = { model: model, messages: [{ role: "system", content: system }, { role: "user", content: question }] };
    if (provider === "openai") body.max_completion_tokens = 6000; // reasoning models: tokens spent thinking count too; no temperature
    else { body.max_tokens = 3000; body.temperature = 0; }
    return { url: root + "/chat/completions", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: body };
  }

  function chatText(provider, json) {
    if (provider === "anthropic") return (json.content || []).map(function (b) { return b.text || ""; }).join("").trim();
    var c = json && json.choices && json.choices[0] && json.choices[0].message;
    return ((c && c.content) || "").trim();
  }

  function chatError(json, status) {
    var e = json && json.error;
    return (e && (e.message || (typeof e === "string" ? e : ""))) || ("HTTP " + status);
  }

  var api = { PROVIDERS: PROVIDERS, chatRequest: chatRequest, chatText: chatText, chatError: chatError, METRIC_LABEL: METRIC_LABEL, money: money, fmtValue: fmtValue, pct: pct, pctPlain: pctPlain, hours: hours,
    headline: headline, evidence: evidence, memo: memo, chatSystem: chatSystem, chartGeometry: chartGeometry };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PG = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
