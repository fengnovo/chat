#!/usr/bin/env python3
"""Run Android UI checks through ADB against the installed app and real API."""

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent
PACKAGE = "ai.keen.mobile"


class AndroidUI:
    def __init__(self, output):
        sdk = Path(os.environ.get("ANDROID_HOME", Path.home() / "Library/Android/sdk"))
        self.adb = os.environ.get("ADB") or shutil.which("adb") or str(sdk / "platform-tools/adb")
        devices = self.command("devices").splitlines()[1:]
        online = [line.split()[0] for line in devices if "\tdevice" in line]
        self.serial = os.environ.get("ANDROID_SERIAL")
        if not self.serial:
            if len(online) != 1:
                raise RuntimeError("Set ANDROID_SERIAL when there is not exactly one online device")
            self.serial = online[0]
        self.output = output
        self.output.mkdir(parents=True, exist_ok=True)
        self.results = []

    def command(self, *args, binary=False):
        prefix = [self.adb]
        if getattr(self, "serial", None):
            prefix += ["-s", self.serial]
        try:
            result = subprocess.run(prefix + list(args), capture_output=True, timeout=30, check=True)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            # 输入命令可能包含凭据；不要把命令参数写入日志或测试产物。
            raise RuntimeError(f"ADB operation failed ({type(error).__name__})") from None
        return result.stdout if binary else result.stdout.decode()

    def shell(self, *args):
        return self.command("shell", *args)

    def nodes(self):
        self.shell("uiautomator", "dump", "/sdcard/keen-ui-e2e.xml")
        self.xml = self.shell("cat", "/sdcard/keen-ui-e2e.xml")
        return [node.attrib for node in ET.fromstring(self.xml).iter("node")]

    @staticmethod
    def bounds(node):
        return tuple(map(int, re.findall(r"-?\d+", node["bounds"])))

    def tap(self, node):
        left, top, right, bottom = self.bounds(node)
        assert right > left and bottom > top, f"Control has no visible area: {node}"
        self.shell("input", "tap", str((left + right) // 2), str((top + bottom) // 2))

    def focus(self, node):
        hint = node["hint"]
        for _ in range(3):
            current = next(n for n in self.nodes() if n.get("class") == "android.widget.EditText" and n.get("hint") == hint)
            self.tap(current)
            focused = next((n for n in self.nodes() if n.get("class") == "android.widget.EditText" and n.get("focused") == "true"), None)
            if focused and focused.get("hint") == hint:
                return focused
        raise AssertionError(f"Could not focus input: {hint}")

    def wait(self, predicate, description, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate(self.nodes())
            if result:
                return result
            time.sleep(0.2)
        raise AssertionError(f"Timed out: {description}")

    def find(self, label, nodes=None):
        nodes = self.nodes() if nodes is None else nodes
        matches = [node for node in nodes if node.get("package") == PACKAGE
                   and (node.get("content-desc") == label or node.get("text") == label)]
        assert matches, f"Control not found: {label}"
        return next((node for node in matches if node.get("clickable") == "true"), matches[0])

    def hide_keyboard(self):
        if "mInputShown=true" in self.shell("dumpsys", "input_method"):
            self.shell("input", "keyevent", "4")
            deadline = time.monotonic() + 5
            while "mInputShown=true" in self.shell("dumpsys", "input_method"):
                assert time.monotonic() < deadline, "Keyboard did not close"
                time.sleep(0.2)
            self.nodes()  # 等待界面稳定后再读取元素边界。

    def evidence(self, name):
        self.nodes()
        (self.output / f"{name}.xml").write_text(self.xml)
        (self.output / f"{name}.png").write_bytes(self.command("exec-out", "screencap", "-p", binary=True))
        (self.output / f"{name}-window.txt").write_text(self.shell("dumpsys", "window"))

    def passed(self, name, **details):
        self.evidence(name)
        self.results.append({"name": name, "status": "passed", **details})
        print(f"PASS {name}: {json.dumps(details, ensure_ascii=False)}", flush=True)

    def login_screen(self):
        self.shell("am", "force-stop", PACKAGE)
        self.shell("am", "start", "-n", f"{PACKAGE}/.MainActivity")
        self.wait(lambda nodes: any(node.get("class") == "android.widget.EditText"
                                   or node.get("text") == "新建会话" for node in nodes), "app launch")
        for _ in range(4):
            nodes = self.nodes()
            if any(node.get("hint") == "admin" for node in nodes):
                return
            if any(node.get("text") == "退出登录" for node in nodes):
                self.tap(self.find("退出登录", nodes))
                self.wait(lambda ns: any(n.get("hint") == "admin" for n in ns), "logout")
                return
            self.hide_keyboard()
            self.shell("input", "keyevent", "4")
        raise AssertionError("Could not reach login screen without clearing app data")

    def check_focus(self, name, hint=None, anchored=False):
        nodes = self.wait(lambda ns: ns if any(n.get("focused") == "true"
                                             and n.get("class") == "android.widget.EditText" for n in ns) else None,
                          "focused input")
        focused = next(n for n in nodes if n.get("focused") == "true"
                       and n.get("class") == "android.widget.EditText")
        assert hint is None or focused.get("hint") == hint, f"{name}: wrong input received focus"
        window = self.shell("dumpsys", "window")
        frames = re.findall(r"type=ime frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\].*?visible=true", window)
        assert frames, "No visible IME; expand Gboard's screen keyboard before running this test"
        _, keyboard_top, _, keyboard_bottom = map(int, frames[0])
        assert keyboard_bottom > keyboard_top, "IME is collapsed; choose Gboard's 显示屏幕键盘"
        left, top, right, bottom = self.bounds(focused)
        self.evidence(name)
        assert 0 <= top < bottom <= keyboard_top, (
            f"{name}: focused input {focused['bounds']} is covered by keyboard (top={keyboard_top})")
        if anchored:
            density = int(re.findall(r"\d+", self.shell("wm", "density"))[-1])
            assert keyboard_top - bottom <= 32 * density / 160, (
                f"{name}: input is too far above the keyboard (gap={keyboard_top - bottom}px)")
        self.results.append({"name": name, "status": "passed", "inputBounds": focused["bounds"], "keyboardTop": keyboard_top})
        print(f"PASS {name}: input bottom={bottom}, keyboard top={keyboard_top}", flush=True)

    def keyboard_checks(self):
        for index, name in enumerate(["server-keyboard", "username-keyboard", "password-keyboard"]):
            self.hide_keyboard()
            fields = [n for n in self.nodes() if n.get("class") == "android.widget.EditText"]
            assert len(fields) == 3, "Expected three login fields"
            self.focus(fields[index])
            self.check_focus(name, fields[index]["hint"])
        # 按用户填写表单时的操作方式，在键盘仍打开时切换输入框。
        username = next(n for n in self.nodes() if n.get("hint") == "admin")
        self.focus(username)
        self.check_focus("switch-to-username", "admin")
        self.shell("input", "keyevent", "61")
        self.check_focus("switch-to-password", "••••••••")
        focused = next(n for n in self.nodes() if n.get("focused") == "true")
        assert focused.get("password") == "true", "TAB did not focus the password field"
        self.hide_keyboard()

    def enter(self, node, text):
        self.focus(node)
        self.shell("input", "keycombination", "113", "29")  # CTRL+A
        self.shell("input", "keyevent", "67")
        self.shell("input", "text", shlex.quote(text.replace(" ", "%s")))
        if node.get("password") != "true":
            self.wait(lambda ns: any(n.get("hint") == node["hint"] and n.get("text") == text for n in ns), "text input (use an English keyboard)")

    def chat_checks(self):
        username = os.environ.get("MOBILE_E2E_USERNAME", "admin")
        password = os.environ.get("MOBILE_E2E_PASSWORD", "admin123")
        fields = [n for n in self.nodes() if n.get("class") == "android.widget.EditText"]
        self.enter(fields[1], username)
        self.hide_keyboard()
        fields = [n for n in self.nodes() if n.get("class") == "android.widget.EditText"]
        self.enter(fields[2], password)
        self.hide_keyboard()
        self.tap(self.find("登录"))
        self.wait(lambda ns: any(n.get("text") == "新建会话" for n in ns), "real API login")
        self.passed("login")
        self.tap(self.find("新建会话"))
        composer = self.wait(lambda ns: next((n for n in ns if n.get("hint") == "输入消息"), None), "new conversation")
        self.passed("new-session")
        marker = f"ANDROID-E2E-{int(time.time())}-OK"
        prompt = f"Reply only {marker}. Do not use tools."
        self.enter(composer, prompt)
        self.check_focus("chat-composer-keyboard", anchored=True)
        self.tap(self.find("发送"))
        self.wait(lambda ns: any(n.get("text") == marker and n.get("class") == "android.widget.TextView" for n in ns), "real model answer", timeout=180)
        self.wait(lambda ns: any(n.get("text") == "发送" for n in ns), "run completion", timeout=30)
        self.hide_keyboard()
        self.assert_answer(marker)
        self.passed("real-model-answer", marker=marker)

        # 只读取真实 API，以核对由界面创建的会话和已完成的运行。
        base = os.environ.get("MOBILE_E2E_API", "http://127.0.0.1:8002").rstrip("/")
        request = urllib.request.Request(base + "/api/auth/login", data=json.dumps({"username": username, "password": password}).encode(), headers={"Content-Type": "application/json"})
        token = json.load(urllib.request.urlopen(request, timeout=15))["token"]
        def api(path):
            request = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.load(response)
        session = next(s for s in api("/api/agent/sessions")["data"] if marker in s["title"])
        history = api(f"/api/agent/sessions/{session['id']}/history?includeLatestEvents=1")
        assert history["latestRun"]["status"] == "completed", "UI answer appeared before the server completed"
        assert any(m["role"] == "assistant" and m["text"].strip() == marker for m in history["messages"]), "Answer was not persisted"
        self.results[-1].update(sessionId=session["id"], runId=history["latestRun"]["id"])

        self.shell("input", "keyevent", "4")
        self.wait(lambda ns: any(n.get("text") == "新建会话" for n in ns), "return to sessions")
        self.tap(self.find(session["title"]))
        self.wait(lambda ns: any(n.get("text") == marker for n in ns), "reopened answer")
        self.assert_answer(marker)
        self.passed("reopen-history")
        self.shell("input", "keyevent", "3")
        self.shell("am", "start", "-n", f"{PACKAGE}/.MainActivity")
        self.wait(lambda ns: any(n.get("text") == marker for n in ns), "foreground answer")
        self.assert_answer(marker)
        self.passed("foreground-history")
        self.shell("am", "force-stop", PACKAGE)
        self.shell("am", "start", "-n", f"{PACKAGE}/.MainActivity")
        self.wait(lambda ns: any(n.get("text") == marker for n in ns), "cold-start answer")
        self.assert_answer(marker)
        self.passed("cold-start-history")

    def assert_answer(self, marker):
        answers = [n for n in self.nodes() if n.get("text") == marker and n.get("class") == "android.widget.TextView"]
        assert len(answers) == 1, f"Expected one rendered answer, found {len(answers)}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keyboard-only", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "node_modules/.cache/mobile" / f"ui-e2e-{time.strftime('%Y%m%d-%H%M%S')}")
    args = parser.parse_args()
    ui = AndroidUI(args.output)
    try:
        ui.login_screen()
        ui.keyboard_checks()
        if not args.keyboard_only:
            ui.chat_checks()
    except Exception as error:
        ui.evidence("failure")
        ui.results.append({"status": "failed", "error": str(error)})
        raise
    finally:
        (ui.output / "results.json").write_text(json.dumps(ui.results, ensure_ascii=False, indent=2))
        print(f"Evidence: {ui.output}", flush=True)


if __name__ == "__main__":
    main()
