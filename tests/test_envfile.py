import tempfile
import unittest
from pathlib import Path

from pg import envfile


class Env(unittest.TestCase):
    def test_parse(self):
        t = '# c\nA=1\nexport B="two words"\nC=\'x\'\nD=val # note\n\nbad line\nE=a=b\n'
        self.assertEqual(envfile.parse(t), {"A": "1", "B": "two words", "C": "x", "D": "val", "E": "a=b"})

    def test_real_env_wins_and_blank_is_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / ".env"
            p.write_text("A=file\nB=file\nC=\n")
            env = {"A": "real"}
            self.assertEqual(sorted(envfile.load(p, env)), ["B"])
            self.assertEqual(env, {"A": "real", "B": "file"})

    def test_missing_file_is_fine(self):
        self.assertEqual(envfile.load("/nonexistent/.env", {}), [])


if __name__ == "__main__":
    unittest.main()
