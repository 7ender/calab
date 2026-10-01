#!/usr/bin/env python3
"""Test cleanup/selection against a fake engine in a throwaway directory."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2]


class EnvironmentSafety(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="identity-env-safety-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        (self.root / "tools").mkdir()
        (self.root / "bin").mkdir()
        shutil.copy2(SOURCE / "tools/identity-test-env.sh", self.root / "tools/identity-test-env.sh")
        self.log = self.root / "calls.jsonl"
        shim = self.root / "bin/docker"
        shim.write_text("""#!/usr/bin/env python3
import json, os, sys
with open(os.environ['IDENTITY_TEST_COMMAND_LOG'], 'a') as f:
    data = '' if sys.argv[1:3] == ['context', 'inspect'] else sys.stdin.read()
    f.write(json.dumps({'args': sys.argv[1:], 'stdin': data}) + '\\n')
if sys.argv[1:3] == ['context', 'inspect']:
    print('unix:///fixture.sock')
""")
        shim.chmod(0o755)
        self.env = os.environ.copy()
        self.env.pop("DOCKER_HOST", None)
        self.env.pop("IDENTITY_TEST_PORT_BASE", None)
        self.env["PATH"] = str(self.root / "bin") + os.pathsep + self.env["PATH"]
        self.env["IDENTITY_TEST_COMMAND_LOG"] = str(self.log)
        suffix = hashlib.sha256(str(self.root).encode()).hexdigest()[:10]
        self.project = "calaba-identity-test-" + suffix
        self.runtime = self.root / "infra/identity-test/.runtime" / suffix

    def run_script(self, *args, ok=True):
        result = subprocess.run([str(self.root / "tools/identity-test-env.sh"), *args], env=self.env,
                                input="", text=True, capture_output=True, timeout=10)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_core_selection_and_stable_ports(self):
        self.env["IDENTITY_TEST_PORT_BASE"] = "58400"
        self.run_script("up")
        call = self.calls()[-1]["args"]
        self.assertEqual(call[-2:], ["pg18", "valkey-qa"])
        self.assertIn(self.project, call)
        self.assertIn("/dev/null", call)
        self.assertEqual(self.runtime.joinpath("port-base").read_text().strip(), "58400")
        self.env.pop("IDENTITY_TEST_PORT_BASE")
        output = self.run_script("env", "17", "provider").stdout
        self.assertIn("127.0.0.1:58417/identity_provider", output)
        self.assertIn("redis://127.0.0.1:58483/15", output)
        self.env["IDENTITY_TEST_PORT_BASE"] = "59400"
        self.run_script("up", ok=False)

    def test_remote_engine_is_rejected_before_mutation(self):
        self.env["DOCKER_HOST"] = "ssh://unowned.test"
        self.run_script("up", ok=False)
        self.assertEqual(self.calls(), [])

    def test_invalid_parameters_never_reach_engine(self):
        self.run_script("create-db", "18", "qa;DROP", ok=False)
        self.run_script("env", "16", "qa", ok=False)
        self.env["IDENTITY_TEST_PORT_BASE"] = "65000;rm"
        self.run_script("up", ok=False)
        self.assertEqual(self.calls(), [])

    def test_database_command_only_targets_selected_test_service(self):
        self.run_script("create-db", "17", "rp")
        call = self.calls()[-1]
        self.assertEqual(call["args"][-10:], ["exec", "-T", "pg17", "psql", "-U", "identity_test", "-d",
                                             "identity_test", "-v", "ON_ERROR_STOP=1"])
        self.assertIn("CREATE DATABASE identity_rp", call["stdin"])
        self.assertIn("\\gexec", call["stdin"])

    def test_teardown_preserves_unowned_files_and_scopes_engine(self):
        self.runtime.mkdir(parents=True)
        (self.runtime / "port-base").write_text("57400\n")
        foreign = self.root / "foreign-project-data"
        foreign.write_text("keep")
        self.run_script("down")
        call = self.calls()[-1]["args"]
        self.assertIn(self.project, call)
        self.assertEqual(call[-2:], ["down", "--volumes"])
        self.assertNotIn("--remove-orphans", call)
        self.assertFalse(self.runtime.exists())
        self.assertEqual(foreign.read_text(), "keep")


if __name__ == "__main__":
    unittest.main(verbosity=2)
