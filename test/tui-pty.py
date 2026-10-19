"""Unix PTY regressions: python3 test/tui-pty.py (no credentials or paid requests)."""
import fcntl
import json
import os
from pathlib import Path
import pty
import signal
import select
import struct
import subprocess
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent


class Terminal:
    def __init__(self, *, real_models=False, responses=None, prompt=None):
        self.temp = tempfile.TemporaryDirectory(prefix="siftory-pty-")
        self.home = Path(self.temp.name)
        self.output = bytearray()
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
        env = {k: v for k, v in os.environ.items() if not (
            k.endswith("_API_KEY") or k.startswith(("ANTHROPIC_", "OPENAI_", "GOOGLE_", "GROQ_", "XAI_", "MOONSHOT_", "ZAI_", "MISTRAL_", "OPENROUTER_"))
        )}
        env["TERM"] = "xterm-256color"
        env.pop("SIFTORY_AGENT_DIR", None)
        if real_models:
            command = ["node", "src/cli.mjs", "--home", str(self.home)]
        else:
            script = self.home / "responses.json"
            script.write_text(json.dumps(responses or ["PTY_REPLY"]))
            command = ["node", "test/helper-faux-cli.mjs", str(script), "--home", str(self.home), "--model", "faux/faux-1"]
        if prompt is not None:
            command.append(prompt)
        self.process = subprocess.Popen(command, cwd=ROOT, stdin=slave, stdout=slave, stderr=slave, env=env)
        os.close(slave)

    def pump(self, seconds=0.05):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([self.master], [], [], 0.02)[0]:
                try:
                    self.output.extend(os.read(self.master, 65536))
                except OSError:
                    break

    def wait_for(self, text, timeout=5, since=0):
        end = time.monotonic() + timeout
        while text.encode() not in self.output[since:] and time.monotonic() < end:
            self.pump()
        if text.encode() not in self.output[since:]:
            raise AssertionError(f"terminal did not show {text!r}; process status={self.process.poll()}")

    def resize(self, rows, columns):
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        self.process.send_signal(signal.SIGWINCH)
        self.pump(0.1)

    def send(self, data):
        os.write(self.master, data)

    def assert_exit(self):
        end = time.monotonic() + 3
        while self.process.poll() is None and time.monotonic() < end:
            self.pump()
        assert self.process.poll() == 0, "Ctrl+C did not exit cleanly"
        assert not list((self.home / "sessions").glob("*/owner.lock")), "ownership lock leaked"
        assert not list((self.home / "sessions").glob("*/owner.guard")), "ownership guard leaked"

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=5)
        os.close(self.master)
        self.temp.cleanup()


class TuiTests(unittest.TestCase):
    def terminal(self, **kwargs):
        terminal = Terminal(**kwargs)
        self.addCleanup(terminal.close)
        terminal.wait_for("─")  # Initial editor border, after raw-mode input starts.
        return terminal

    def test_ctrl_c_exits_empty_and_nonempty_editors(self):
        for text in [b"", b"unfinished prompt"]:
            with self.subTest(text=text):
                terminal = self.terminal()
                terminal.send(text)
                terminal.pump(0.1)
                terminal.send(b"\x03")
                terminal.assert_exit()

    def test_ctrl_c_exits_while_tool_is_running(self):
        terminal = self.terminal(responses=[
            {"toolCall": "bash", "args": {"command": "echo PTY_BUSY; sleep 20"}}, "done",
        ])
        terminal.send(b"run the tool\r")
        terminal.wait_for("PTY_BUSY")
        terminal.pump(0.3)
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_working_indicator_animates_inside_the_editor_border(self):
        terminal = self.terminal(responses=[
            {"toolCall": "bash", "args": {"command": "sleep 20"}}, "done",
        ])
        terminal.send(b"run the tool\r")
        terminal.wait_for("Working")
        terminal.pump(0.2)
        self.assertTrue(any(frame.encode() in terminal.output for frame in "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"))
        self.assertIn(b"\x1b]9;4;3\x07", terminal.output)  # Native terminal progress signal.
        since = len(terminal.output)
        terminal.send(b"/thinking\r")
        terminal.wait_for("Thinking Level", since=since)
        terminal.wait_for("Working", since=since)  # The indicator moves above the selector.
        terminal.send(b"\x1b")
        terminal.pump(0.1)
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_ctrl_c_exits_startup_login_picker(self):
        terminal = self.terminal(real_models=True, prompt="/login")
        terminal.wait_for("Select provider")
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_ctrl_c_exits_thinking_menu(self):
        terminal = self.terminal()
        terminal.send(b"/thinking\r")
        terminal.wait_for("high")
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_login_picker_filters_and_escape_restores_editor(self):
        terminal = self.terminal(real_models=True)
        terminal.send(b"/login\r")
        terminal.wait_for("Select provider")
        terminal.send(b"openai-codex")
        terminal.pump(0.1)
        terminal.send(b"\x1b")
        terminal.pump(0.1)
        terminal.send(b"/help\r")
        terminal.wait_for("Show commands")
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_menus_can_be_reopened_cancelled_and_resized_without_losing_input(self):
        terminal = self.terminal()
        for width in [120, 45, 100]:
            terminal.resize(30, width)
            for command, title in [(b"/model\r", "Only showing models"), (b"/thinking\r", "Thinking Level"), (b"/resume\r", "Resume session")]:
                since = len(terminal.output)
                terminal.send(command)
                terminal.wait_for(title, since=since)
                terminal.send(b"\x1b")
                terminal.pump(0.1)
        since = len(terminal.output)
        terminal.send(b"menu exit test\r")
        terminal.wait_for("PTY_REPLY", since=since)
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_chinese_prompt_with_workspace_files_submits_on_the_first_enter(self):
        terminal = self.terminal()
        (terminal.home / "workspace" / "llm-intro.md").write_text("fixture")
        terminal.send("请只回复完成。".encode())
        terminal.pump(0.2)
        terminal.send(b"\r")
        terminal.wait_for("PTY_REPLY")
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_tool_and_todo_folds_and_theme_selection_preserve_input(self):
        terminal = self.terminal(responses=[
            {"toolCall": "todo", "args": {"action": "create", "subject": "DISPLAY_TASK"}},
            {"toolCall": "todo", "args": {"action": "update", "id": 1, "status": "completed"}},
            {"toolCall": "bash", "args": {"command": "printf 'one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven\\n'"}},
            "DISPLAY_DONE", "INPUT_AFTER_FOLDS",
        ])
        terminal.send(b"display test\r")
        terminal.wait_for("DISPLAY_DONE")
        terminal.send(b"\x0f")  # Ctrl+O expands tool results.
        terminal.pump(0.1)
        since = len(terminal.output)
        terminal.send(b"\x1b[116;6u")  # Kitty Ctrl+Shift+T folds the todo panel.
        terminal.wait_for("ctrl+shift+t to expand", since=since)
        terminal.send(b"/theme\r")
        terminal.wait_for("Theme")
        terminal.send(b"dark\r")
        terminal.wait_for("theme: dark")
        settings = json.loads((terminal.home / "agent" / "settings.json").read_text())
        self.assertEqual(settings["theme"], "dark")
        terminal.send(b"continue after styling\r")
        terminal.wait_for("INPUT_AFTER_FOLDS")
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_new_session_rebinds_theme_and_shows_the_native_footer(self):
        terminal = self.terminal()
        terminal.send(b"/theme light\r")
        terminal.wait_for("theme: light")
        since = len(terminal.output)
        terminal.send(b"/new\r")
        terminal.wait_for("thinking off", since=since)
        terminal.pump(0.2)
        fresh = terminal.output[since:]
        self.assertIn(b"\x1b[2J", fresh)
        self.assertNotIn(b"\x1b[H", fresh, "Warp's command header can obscure content painted at absolute row zero")
        self.assertIn(b"workspace", fresh)
        self.assertIn(b"Siftory", fresh)
        self.assertNotIn(b"Ctrl+T todos", fresh)
        self.assertEqual(json.loads((terminal.home / "agent" / "settings.json").read_text())["theme"], "light")
        terminal.send(b"after new session\r")
        terminal.wait_for("PTY_REPLY", since=since)
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_session_switches_clear_the_viewport_and_resume_the_selected_storage(self):
        terminal = self.terminal()
        first = next((terminal.home / "sessions").iterdir()).name
        since = len(terminal.output)
        terminal.send(b"/new\r")
        terminal.pump(0.5)
        self.assertIn(b"\x1b[2J", terminal.output[since:])
        self.assertEqual(len(list((terminal.home / "sessions").iterdir())), 2)
        since = len(terminal.output)
        terminal.send(b"/resume\r")
        terminal.wait_for("Resume session", since=since)
        terminal.send(first.encode() + b"\r")
        terminal.pump(0.5)
        self.assertIn(b"\x1b[2J", terminal.output[since:])
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_model_search_and_thinking_selection_return_to_editor(self):
        terminal = self.terminal()
        terminal.send(b"/model\r")
        terminal.wait_for("Only showing models")
        terminal.send(b"faux-1\r")
        terminal.pump(0.1)
        terminal.send(b"/thinking\r")
        terminal.wait_for("Thinking Level")
        terminal.send(b"high\r")
        terminal.pump(0.1)
        since = len(terminal.output)
        terminal.send(b"selection confirmed\r")
        terminal.wait_for("PTY_REPLY", since=since)
        terminal.send(b"\x03")
        terminal.assert_exit()

    def test_ctrl_c_exits_provider_picker_and_login_prompt(self):
        for command, expected in [(b"/login\r", "Select provider"), (b"/login deepseek\r", "API key")]:
            with self.subTest(command=command):
                terminal = self.terminal(real_models=True)
                terminal.send(command)
                terminal.wait_for(expected)
                terminal.send(b"\x03")
                terminal.assert_exit()


if __name__ == "__main__":
    unittest.main()
