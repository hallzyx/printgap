import unittest

from pg import llm


class Resolve(unittest.TestCase):
    def test_no_keys_means_cache_only(self):
        self.assertIsNone(llm.resolve({}))
        self.assertIsNone(llm.resolve({"OPENAI_API_KEY": "   "}))  # blank is not a key

    def test_autodetect_order(self):
        env = {"OPENAI_API_KEY": "o", "DEEPSEEK_API_KEY": "d"}
        self.assertEqual(llm.resolve(env).name, "openai")
        self.assertEqual(llm.resolve({"DEEPSEEK_API_KEY": "d"}).name, "deepseek")
        self.assertEqual(llm.resolve({**env, "ANTHROPIC_API_KEY": "a"}).name, "anthropic")

    def test_explicit_provider_wins_and_needs_its_key(self):
        env = {"ANTHROPIC_API_KEY": "a", "DEEPSEEK_API_KEY": "d", "PRINTGAP_PROVIDER": "deepseek"}
        self.assertEqual(llm.resolve(env).name, "deepseek")
        with self.assertRaises(ValueError):
            llm.resolve({"ANTHROPIC_API_KEY": "a", "PRINTGAP_PROVIDER": "openai"})
        with self.assertRaises(ValueError):
            llm.resolve({"PRINTGAP_PROVIDER": "gemini"})

    def test_model_override_and_label(self):
        p = llm.resolve({"OPENAI_API_KEY": "o", "PRINTGAP_MODEL": "gpt-5"})
        self.assertEqual(p.label, "openai:gpt-5")
        self.assertEqual(llm.resolve({"ANTHROPIC_API_KEY": "a"}).model, "claude-sonnet-5-5")

    def test_compatible_needs_base_and_model(self):
        with self.assertRaises(ValueError):
            llm.resolve({"LLM_API_KEY": "k"})
        p = llm.resolve({"LLM_API_KEY": "k", "PRINTGAP_BASE_URL": "https://example.test/v1/", "PRINTGAP_MODEL": "qwen-x"})
        self.assertEqual((p.name, p.base_url, p.model), ("compatible", "https://example.test/v1", "qwen-x"))


class Qwen(unittest.TestCase):
    def test_qwen_defaults_to_the_hackathon_endpoint(self):
        p = llm.resolve({"QWEN_API_KEY": "q"})
        self.assertEqual((p.name, p.model, p.base_url), ("qwen", "qwen3.8-max", "https://hackathon.bitgetops.com/v1"))

    def test_qwen_endpoint_and_model_can_be_overridden(self):
        p = llm.resolve({"QWEN_API_KEY": "q", "PRINTGAP_BASE_URL": "https://other.test/v1/", "PRINTGAP_MODEL": "qwen-x"})
        self.assertEqual((p.base_url, p.model), ("https://other.test/v1", "qwen-x"))

    def test_qwen_sits_after_deepseek_and_before_compatible(self):
        self.assertEqual(llm.resolve({"QWEN_API_KEY": "q", "LLM_API_KEY": "k", "PRINTGAP_BASE_URL": "https://x.test", "PRINTGAP_MODEL": "m"}).name, "qwen")
        self.assertEqual(llm.resolve({"QWEN_API_KEY": "q", "DEEPSEEK_API_KEY": "d"}).name, "deepseek")

    def test_qwen_request_is_chat_completions_with_bearer(self):
        p = llm.resolve({"QWEN_API_KEY": "KEY"})
        url, h, b = llm.build_request(p, "SYS", "USER")
        self.assertEqual(url, "https://hackathon.bitgetops.com/v1/chat/completions")
        self.assertEqual(h["Authorization"], "Bearer KEY")
        self.assertEqual((b["model"], b["temperature"], b["max_tokens"]), ("qwen3.8-max", 0, 8000))
        self.assertNotIn("KEY", str(b))


class Requests(unittest.TestCase):
    def test_anthropic_shape(self):
        p = llm.Provider("anthropic", "m", "KEY", "https://api.anthropic.com")
        url, h, b = llm.build_request(p, "SYS", "USER")
        self.assertEqual(url, "https://api.anthropic.com/v1/messages")
        self.assertEqual(h["x-api-key"], "KEY")
        self.assertEqual(b["system"], "SYS")
        self.assertEqual(b["messages"][0]["content"], "USER")

    def test_openai_shape_has_no_temperature_and_uses_completion_tokens(self):
        p = llm.Provider("openai", "gpt-4.1", "KEY", "https://api.openai.com/v1")
        url, h, b = llm.build_request(p, "SYS", "USER", 100)
        self.assertEqual(url, "https://api.openai.com/v1/chat/completions")
        self.assertEqual(h["Authorization"], "Bearer KEY")
        self.assertNotIn("temperature", b)
        self.assertNotIn("max_tokens", b)
        self.assertEqual(b["max_completion_tokens"], 100)
        self.assertEqual(b["response_format"], {"type": "json_object"})
        self.assertEqual([m["role"] for m in b["messages"]], ["system", "user"])

    def test_deepseek_shape(self):
        p = llm.Provider("deepseek", "deepseek-chat", "KEY", "https://api.deepseek.com")
        url, _, b = llm.build_request(p, "SYS", "USER")
        self.assertEqual(url, "https://api.deepseek.com/chat/completions")
        self.assertEqual((b["temperature"], b["max_tokens"]), (0, 8000))

    def test_key_is_never_in_the_body(self):
        for name in ("anthropic", "openai", "deepseek"):
            p = llm.Provider(name, "m", "SECRET-KEY", "https://x.test")
            self.assertNotIn("SECRET-KEY", str(llm.build_request(p, "s", "u")[2]))


class Budgets(unittest.TestCase):
    def test_reasoning_models_get_room_to_think(self):
        o = llm.Provider("openai", "gpt-6.1-sol", "k", "https://api.openai.com/v1")
        self.assertEqual(llm.build_request(o, "s", "u")[2]["max_completion_tokens"], 16000)
        a = llm.Provider("anthropic", "m", "k", "https://api.anthropic.com")
        self.assertEqual(llm.build_request(a, "s", "u")[2]["max_tokens"], 4096)

    def test_current_defaults(self):
        self.assertEqual(llm.DEFAULTS["openai"][0], "gpt-6-luna")
        self.assertEqual(llm.DEFAULTS["deepseek"][0], "deepseek-flash")


class Parse(unittest.TestCase):
    def test_truncated_output_is_an_error_not_bad_json(self):
        o = llm.Provider("openai", "m", "k", "u")
        with self.assertRaises(ValueError) as cm:
            llm.parse_response(o, {"choices": [{"finish_reason": "length", "message": {"content": ""}}]})
        self.assertIn("cut off", str(cm.exception))
        a = llm.Provider("anthropic", "m", "k", "u")
        with self.assertRaises(ValueError):
            llm.parse_response(a, {"stop_reason": "max_tokens", "content": [{"type": "text", "text": "{"}]})

    def test_anthropic(self):
        p = llm.Provider("anthropic", "m", "k", "u")
        t, u = llm.parse_response(p, {"content": [{"type": "text", "text": "{}"}], "usage": {"a": 1}})
        self.assertEqual((t, u), ("{}", {"a": 1}))

    def test_openai_style(self):
        p = llm.Provider("deepseek", "m", "k", "u")
        t, _ = llm.parse_response(p, {"choices": [{"message": {"content": '{"claims": []}'}}]})
        self.assertEqual(t, '{"claims": []}')
        with self.assertRaises(ValueError):
            llm.parse_response(p, {"error": "x"})


if __name__ == "__main__":
    unittest.main()
