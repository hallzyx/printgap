// Run with: node tests/test_richtext.js  (no dependencies)
const assert = require("assert");
const R = require("../site/richtext.js");

let n = 0;
function t(name, fn) { fn(); n += 1; console.log("ok -", name); }

const REAL = [
  "| Cifra | Valor | Evidencia |",
  "|---|---:|---|",
  "| Ingresos | $46.7B | [E1] |",
  "",
  "```chart",
  '{"type":"bar","title":"rToken vs gap","unit":"%","labels":["rNVDA overnight","Stock gap"],"series":[{"name":"Move","values":[6.45,6.30]}]}',
  "```",
  "",
  "$$\\text{priced-in} = \\frac{\\text{movimiento rToken}}{\\text{gap del cash}} = \\frac{6.45\\%}{6.30\\%} = 1.02$$ [E5]",
].join("\n");

t("prepare: chart block and display math become placeholders, table survives", () => {
  const p = R.prepare(REAL);
  assert.strictEqual(p.blocks.length, 1);
  assert.strictEqual(p.blocks[0].kind, "chart");
  assert.ok(p.blocks[0].closed);
  assert.strictEqual(p.math.length, 1);
  assert.ok(p.math[0].display);
  assert.ok(p.math[0].tex.startsWith("\\text{priced-in}"));
  assert.ok(p.md.includes("PGBLOCK0Z") && p.md.includes("PGMATH0Z"));
  assert.ok(p.md.includes("| Ingresos | $46.7B | [E1] |"), "money in a table is not math");
  assert.ok(!p.md.includes("```chart"));
});

t("math: inline, \\( \\), \\[ \\], escaped dollars and money", () => {
  let p = R.prepare("ratio $\\frac{a}{b}$ and \\(x^2\\) then \\[y=1\\]");
  assert.deepStrictEqual(p.math.map(m => [m.tex, m.display]), [["\\frac{a}{b}", false], ["x^2", false], ["y=1", true]]);
  p = R.prepare("Revenue $35.1B, up from $30.0B [E1]. Costs \\$5 flat.");
  assert.strictEqual(p.math.length, 0, "money ranges are not math");
  assert.ok(p.md.includes("\\$5"));
  p = R.prepare("move of $6.45\\%$ overnight");
  assert.strictEqual(p.math.length, 1, "a number with TeX in it is math");
  p = R.prepare("the ratio is $1.02$ [E5], revenue $35.1B, up from $30.0B");
  assert.deepStrictEqual(p.math.map(m => m.tex), ["1.02"], "a bare number in dollars is math, money is not");
  p = R.prepare("unclosed $x and $$ y");
  assert.strictEqual(p.math.length, 0);
});

t("math and blocks are never taken from code", () => {
  const p = R.prepare("use `$x$` here\n\n```js\nconst a = '$y$';\n```\n\n```mermaid\nflowchart LR\nA-->B\n```");
  assert.strictEqual(p.math.length, 0);
  assert.strictEqual(p.blocks.length, 1);
  assert.strictEqual(p.blocks[0].kind, "mermaid");
  assert.ok(p.md.includes("```js") && p.md.includes("'$y$'"));
});

t("unterminated fence is kept as a block marked open", () => {
  const p = R.prepare("text\n```chart\n{\"type\":\"bar\"");
  assert.strictEqual(p.blocks.length, 1);
  assert.strictEqual(p.blocks[0].closed, false);
  assert.strictEqual(R.parseChart(p.blocks[0].src).ok, false);
});

t("tokenizeInline: math, blocks and grouped citations", () => {
  const s = R.tokenizeInline("a PGMATH0Z b [E1] c [E2, E10] PGBLOCK3Z");
  assert.deepStrictEqual(s.map(x => x.type), ["text", "math", "text", "cite", "text", "cite", "text", "block"]);
  assert.deepStrictEqual(s[5].ids, ["E2", "E10"]);
  assert.strictEqual(s[7].i, 3);
});

t("verdict: ok, inexistent ids, uncited and abstention", () => {
  const ids = ["E1", "E2", "E3"];
  assert.strictEqual(R.verdict("Rev up [E1].", ids).kind, "ok");
  const b = R.verdict("Rev up [E1] and [E9, E2].", ids);
  assert.strictEqual(b.kind, "bogus");
  assert.deepStrictEqual(b.bogus, ["E9"]);
  assert.strictEqual(R.verdict("It went up a lot.", ids).kind, "uncited");
  assert.strictEqual(R.verdict("The evidence does not cover that.", ids).kind, "abstain");
  assert.strictEqual(R.verdict("La evidencia no cubre eso.", ids).kind, "abstain");
  assert.strictEqual(R.verdict("   ", ids).kind, "empty");
});

t("safeHref: only http(s) and mailto, obfuscated schemes refused", () => {
  assert.strictEqual(R.safeHref("https://www.sec.gov/x"), "https://www.sec.gov/x");
  assert.strictEqual(R.safeHref("mailto:a@b.c"), "mailto:a@b.c");
  ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>",
    "vbscript:x", "//evil.example", "/relative", "#x", "", null].forEach(h => assert.strictEqual(R.safeHref(h), null, String(h)));
});

t("parseChart: the real example", () => {
  const c = R.parseChart(R.prepare(REAL).blocks[0].src);
  assert.ok(c.ok);
  assert.strictEqual(c.chart.type, "bar");
  assert.deepStrictEqual(c.chart.series[0].values, [6.45, 6.3]);
  assert.strictEqual(c.warnings.length, 0);
});

t("parseChart: malformed JSON and wrong shapes fail without throwing", () => {
  ["{not json", "", "[1,2]", "null", "42", '{"labels":["a"]}', '{"labels":["a"],"series":[{"values":["x"]}]}',
    '{"series":[]}', "x".repeat(30000)].forEach(src => {
    const c = R.parseChart(src);
    assert.strictEqual(c.ok, false, src.slice(0, 30));
    assert.ok(typeof c.error === "string" && c.error.length);
  });
  assert.strictEqual(R.parseChart(undefined).ok, false);
});

t("parseChart: NaN, strings, Infinity and uneven series", () => {
  const c = R.parseChart(JSON.stringify({ type: "line", labels: ["a", "b", "c"],
    series: [{ name: "r", values: [1, "2.5%", "abc", 9] }, { name: "s", values: ["−3", null] }, { values: [1e400, {}, [1]] }] }));
  assert.ok(c.ok);
  assert.deepStrictEqual(c.chart.series[0].values, [1, 2.5, null]);
  assert.deepStrictEqual(c.chart.series[1].values, [-3, null, null]);
  assert.deepStrictEqual(c.chart.series[2].values, [null, null, null]);
  assert.strictEqual(c.chart.series[2].name, "Series 3");
  assert.ok(c.warnings.some(w => /one value per label/.test(w)));
  assert.ok(c.warnings.some(w => /not a number/.test(w)));
  assert.strictEqual(R.toNum(NaN), null);
  assert.strictEqual(R.toNum("1e5"), null);
});

t("parseChart: html in labels stays inert text, oversize input is capped", () => {
  const c = R.parseChart(JSON.stringify({ type: "pie", title: "<img src=x onerror=alert(1)>", labels: Array.from({ length: 40 }, (_, i) => "<b>" + i),
    series: Array.from({ length: 9 }, () => ({ name: "<script>", values: Array(40).fill(1) })) }));
  assert.ok(c.ok);
  assert.strictEqual(c.chart.type, "bar");
  assert.strictEqual(c.chart.labels.length, 24);
  assert.strictEqual(c.chart.series.length, 6);
  assert.strictEqual(c.chart.title, "<img src=x onerror=alert(1)>", "kept as a string; the DOM layer only ever uses textContent");
  assert.ok(c.warnings.length >= 3);
});

t("chartLayout: zero is always in the domain, negatives hang below it", () => {
  const c = R.parseChart(JSON.stringify({ type: "bar", unit: "%", labels: ["rNVDA", "Stock gap"], series: [{ name: "m", values: [-8.03, -6.1] }] })).chart;
  const g = R.chartLayout(c, 360, 220);
  assert.ok(g.lo < -8.03 && g.hi >= 0);
  assert.ok(Math.abs(g.ticks.find(x => x.v === 0).y - g.zeroY) < 1e-9);
  g.bars.forEach(b => { assert.ok(!b.up); assert.ok(Math.abs(b.y - g.zeroY) < 1e-9, "negative bar starts at zero"); assert.ok(b.y + b.h <= g.y1 + 1e-9); });
  assert.deepStrictEqual(g.colors, ["rt", "cash"]);
  const pos = R.chartLayout(R.parseChart('{"labels":["a"],"series":[{"values":[5]}]}').chart, 300, 200);
  assert.ok(pos.lo === 0 && Math.abs(pos.bars[0].y + pos.bars[0].h - pos.zeroY) < 1e-9);
});

t("chartLayout: line gaps split segments; all-zero data still has a domain", () => {
  const c = R.parseChart('{"type":"line","labels":["a","b","c","d"],"series":[{"name":"x","values":[1,null,3,4]}]}').chart;
  const g = R.chartLayout(c, 400, 200);
  assert.strictEqual(g.lines[0].segments.length, 2);
  const z = R.chartLayout(R.parseChart('{"labels":["a"],"series":[{"values":[0]}]}').chart, 300, 200);
  assert.ok(z.hi > z.lo && isFinite(z.zeroY));
});

t("colours follow the page: amber rToken, ice-blue stock", () => {
  assert.strictEqual(R.colorKey("rToken overnight"), "rt");
  assert.strictEqual(R.colorKey("rNVDA"), "rt");
  assert.strictEqual(R.colorKey("Gap del stock"), "cash");
  assert.strictEqual(R.colorKey("Apertura de la acción"), "cash");
  assert.strictEqual(R.colorKey("revenue"), null);
  assert.deepStrictEqual(R.assignColors(["Revenue", "rToken", "Other"]), ["ok", "rt", "n1"]);
});

t("number formatting is signed and never colour-only", () => {
  assert.strictEqual(R.fmtValue(6.45, "%"), "+6.45%");
  assert.strictEqual(R.fmtValue(-8.031, "%"), "−8.03%");
  assert.strictEqual(R.fmtValue(0, ""), "0");
  assert.strictEqual(R.fmtValue(1.5, "USD"), "+1.5 USD");
  assert.strictEqual(R.glyph(2), "▲");
  assert.strictEqual(R.glyph(-2), "▼");
  assert.ok(/down/.test(R.chartSummary(R.parseChart('{"labels":["a"],"series":[{"values":[-1]}]}').chart)));
});

t("history: only finished question/answer pairs, newest six messages", () => {
  const th = [
    { role: "user", content: "q1" }, { role: "assistant", content: "a1" },
    { role: "user", content: "q2" }, { role: "assistant", content: "x", error: true },
    { role: "user", content: "q3" }, { role: "assistant", content: "a3" },
    { role: "user", content: "q4" }, { role: "assistant", content: "a4" },
    { role: "user", content: "q5" }, { role: "assistant", content: "a5" },
    { role: "user", content: "pending" },
  ];
  const h = R.historyFor(th, 6);
  assert.deepStrictEqual(h.map(m => m.content), ["q3", "a3", "q4", "a4", "q5", "a5"]);
  assert.strictEqual(R.withHistory([], "Q"), "Q");
  assert.ok(/^Conversation so far[\s\S]*User: q3[\s\S]*New question: Q$/.test(R.withHistory(h, "Q")));
});

t("errors map to a clear message and a retry decision", () => {
  assert.ok(R.errorInfo(429, "Too many").retry);
  assert.strictEqual(R.errorInfo(429, "Too many").title, "Question limit reached");
  assert.ok(R.errorInfo(502, "").retry);
  assert.strictEqual(R.errorInfo(400, "Keep it short").retry, false);
  assert.ok(R.errorInfo(0, "", true).retry);
});

t("long left-to-right flowcharts turn top-down for the narrow panel; short ones and other diagrams stay", () => {
  assert.strictEqual(R.mermaidForNarrow("flowchart LR\nA-->B-->C-->D"), "flowchart TD\nA-->B-->C-->D");
  assert.strictEqual(R.mermaidForNarrow("graph RL\nA-->B"), "graph RL\nA-->B");
  assert.strictEqual(R.mermaidForNarrow("timeline\ntitle x\n2024 : a"), "timeline\ntitle x\n2024 : a");
});

t("numeric table cells are detected for the mono column", () => {
  ["$46.7B", "+6.45%", "−8.03%", "1.02", "$0.68 [E2]", "▲ +3.1%", "(1.2)"].forEach(c => assert.ok(R.looksNumeric(c), c));
  ["Revenue", "[E1]", "up 5% vs guide", ""].forEach(c => assert.ok(!R.looksNumeric(c), c));
});

t("hostile markdown: script and html are left as text for the sanitizer, tokens do not escape", () => {
  const p = R.prepare('<img src=x onerror="alert(1)"> [x](javascript:alert(1)) <script>alert(1)</script> PGMATH99Z');
  assert.strictEqual(p.math.length, 0);
  assert.ok(p.md.includes("<script>"), "prepare does not try to sanitize; DOMPurify does");
  const seg = R.tokenizeInline(p.md).filter(s => s.type === "math");
  assert.strictEqual(seg[0].i, 99, "an out-of-range token is resolved by the DOM layer as plain text");
});

console.log(n + " richtext tests passed");
