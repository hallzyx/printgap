// Run with: node tests/test_lib.js  (no dependencies)
const assert = require("assert");
const L = require("../site/lib.js");

const SYS = "SYS", Q = "What changed?";
let n = 0;
function t(name, fn) { fn(); n += 1; console.log("ok -", name); }

t("anthropic request", () => {
  const r = L.chatRequest("anthropic", "m1", "KEY", "", SYS, Q);
  assert.strictEqual(r.url, "https://api.anthropic.com/v1/messages");
  assert.strictEqual(r.headers["x-api-key"], "KEY");
  assert.strictEqual(r.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.strictEqual(r.body.system, SYS);
});

t("openai request: no temperature, completion tokens, bearer", () => {
  const r = L.chatRequest("openai", "gpt-4.1", "KEY", "", SYS, Q);
  assert.strictEqual(r.url, "https://api.openai.com/v1/chat/completions");
  assert.strictEqual(r.headers.authorization, "Bearer KEY");
  assert.ok(!("temperature" in r.body) && !("max_tokens" in r.body));
  assert.strictEqual(r.body.max_completion_tokens, 6000);
  assert.deepStrictEqual(r.body.messages.map(m => m.role), ["system", "user"]);
});

t("deepseek request", () => {
  const r = L.chatRequest("deepseek", "deepseek-chat", "KEY", "", SYS, Q);
  assert.strictEqual(r.url, "https://api.deepseek.com/chat/completions");
  assert.strictEqual(r.body.temperature, 0);
});

t("custom endpoint: trailing slash trimmed, https enforced", () => {
  const r = L.chatRequest("custom", "qwen-x", "KEY", "https://example.test/v1///", SYS, Q);
  assert.strictEqual(r.url, "https://example.test/v1/chat/completions");
  assert.throws(() => L.chatRequest("custom", "qwen-x", "KEY", "http://example.test/v1", SYS, Q), /https/);
  assert.throws(() => L.chatRequest("custom", "qwen-x", "KEY", "", SYS, Q), /https/);
});

t("missing key, missing model and unknown provider are refused", () => {
  assert.throws(() => L.chatRequest("openai", "gpt-4.1", "", "", SYS, Q), /key/);
  assert.throws(() => L.chatRequest("openai", "", "KEY", "", SYS, Q), /model/);
  assert.throws(() => L.chatRequest("gemini", "m", "KEY", "", SYS, Q), /Unknown/);
});

t("the key is never placed in the body", () => {
  ["anthropic", "openai", "deepseek"].forEach(p => {
    const r = L.chatRequest(p, "m", "SECRET-KEY", "", SYS, Q);
    assert.ok(!JSON.stringify(r.body).includes("SECRET-KEY"));
  });
});

t("response parsing", () => {
  assert.strictEqual(L.chatText("anthropic", { content: [{ type: "text", text: " hi [E1] " }] }), "hi [E1]");
  assert.strictEqual(L.chatText("openai", { choices: [{ message: { content: "yo [E2]" } }] }), "yo [E2]");
  assert.strictEqual(L.chatText("deepseek", {}), "");
  assert.strictEqual(L.chatError({ error: { message: "bad key" } }, 401), "bad key");
  assert.strictEqual(L.chatError({}, 500), "HTTP 500");
});

t("default models are filled for the three named providers", () => {
  ["anthropic", "openai", "deepseek"].forEach(p => assert.ok(L.PROVIDERS[p].model));
  assert.strictEqual(L.PROVIDERS.openai.model, "gpt-6.1-sol");
  assert.strictEqual(L.PROVIDERS.deepseek.model, "deepseek-flash");
  assert.strictEqual(L.PROVIDERS.custom.model, "");
});

t("evidence and memo still work", () => {
  const ev = { ticker: "X", pub_et: "t", accession: "a", url: "u", claims: [], gap: { available: false }, reaction: { ok: false, reason: "no data" } };
  const E = L.evidence(ev, null);
  assert.ok(E.length === 1 && /Reaction not measured/.test(E[0].text));
  assert.ok(/Limits/.test(L.memo(ev, null)));
});

console.log(n + " JS tests passed");
