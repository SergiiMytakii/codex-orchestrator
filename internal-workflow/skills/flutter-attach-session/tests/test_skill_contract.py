#!/usr/bin/env python3

import re
import unittest
from pathlib import Path


CODEX_HOME = Path(__file__).resolve().parents[3]
POLICY_FILES = (
    CODEX_HOME / "AGENTS.md",
    CODEX_HOME / "docs" / "agents" / "tool-usage.md",
    CODEX_HOME / "skills" / "flutter-attach-session" / "SKILL.md",
    CODEX_HOME / "skills" / "flutter-attach-session" / "agents" / "openai.yaml",
    CODEX_HOME / "skills" / "flutter-android-debug" / "SKILL.md",
    CODEX_HOME / "skills" / "flutter-ios-debug" / "SKILL.md",
)

GUI_CONTROL_PATTERN = re.compile(
    r"(?i)(?:\b(?:open|opening|activate|focus|automate)\b.{0,100}\bIDE\b|"
    r"\b(?:use|invoke|open|opening|activate|automate)\b.{0,100}"
    r"(?:Command Palette|osascript|AppleScript|System Events))"
)
# This is a bounded guard for explicit GUI directives, not a natural-language parser.
# A prohibition must govern the matched action, not just occur elsewhere in a sentence.
NEGATION_PATTERN = re.compile(
    r"(?i)(?:\bnever|\bdo not|\bmust not)\s+"
    r"(?:(?:activate|open|focus|automate|invoke|use)[,\s]+(?:or\s+)*)*$"
)


def affirmative_gui_instructions(policy: str) -> list[str]:
    violations = []
    for paragraph in re.split(r"\n\s*\n", policy):
        normalized = re.sub(r"\s*\n\s*", " ", paragraph)
        for clause in re.split(r"(?<=[.!?;])\s+|\s+but\s+", normalized):
            for match in GUI_CONTROL_PATTERN.finditer(clause):
                if not NEGATION_PATTERN.search(clause[:match.start()]):
                    violations.append(clause.strip())
                    break
    return violations


def reachable_runtime_policy(path: Path) -> str:
    policy = path.read_text()
    # The platform QA skill explicitly delegates transport to this installed owner.
    if "$flutter-attach-session" in policy:
        owner = CODEX_HOME / "skills" / "flutter-attach-session" / "SKILL.md"
        if path != owner:
            policy += "\n\n" + owner.read_text()
    return policy


class FlutterSkillContractTests(unittest.TestCase):
    def test_reload_restart_policies_forbid_ide_gui_automation(self) -> None:
        for path in POLICY_FILES:
            with self.subTest(path=path):
                policy = reachable_runtime_policy(path)
                self.assertIn("Command Palette", policy)
                self.assertRegex(policy, r"(?i)(osascript|AppleScript)")
                self.assertEqual([], affirmative_gui_instructions(path.read_text()))

    def test_contract_guard_rejects_an_affirmative_ide_fallback(self) -> None:
        policy = (
            "Never automate the IDE during hot restart. "
            "If the helper times out, open the IDE and use Command Palette."
        )

        self.assertEqual(
            ["If the helper times out, open the IDE and use Command Palette."],
            affirmative_gui_instructions(policy),
        )

    def test_unrelated_negation_cannot_hide_gui_fallback(self) -> None:
        for policy in (
            "If the helper is not ready, open the IDE and use Command Palette.",
            "Never discard logs; open the IDE and use Command Palette.",
            "Never discard logs but open the IDE and use Command Palette.",
        ):
            with self.subTest(policy=policy):
                self.assertTrue(affirmative_gui_instructions(policy))

    def test_attach_skill_declares_transport_failure_and_compile_identity_contracts(self) -> None:
        policy = reachable_runtime_policy(
            CODEX_HOME / "skills" / "flutter-attach-session" / "SKILL.md")
        normalized = re.sub(r"\s+", " ", policy)
        self.assertRegex(normalized, r"flutter_session_ctl\.py.{0,50}only allowed reload/restart")
        self.assertRegex(normalized, r"If the helper fails.{0,150}preserve the app and report")
        self.assertRegex(normalized, r"[Dd]o not fall back to the owning IDE")
        # These CLI names are a stable compile identity contract, not editorial wording.
        for flag in ("--target", "--dart-define", "--dart-define-from-file"):
            self.assertIn(flag, policy)
        self.assertRegex(normalized, r"(?:cannot reconstruct|unreconstructable) compile identity.{0,100}(?:refuse|fail closed)")
        self.assertEqual([], affirmative_gui_instructions(policy))

    def test_default_prompt_names_the_only_transport_and_forbids_ide_fallback(self) -> None:
        policy = (
            CODEX_HOME / "skills" / "flutter-attach-session" / "agents" / "openai.yaml"
        ).read_text()

        self.assertIn("flutter_session_ctl.py", policy)
        self.assertRegex(policy, r"(?i)never.{0,100}(IDE|Command Palette|AppleScript)")


if __name__ == "__main__":
    unittest.main()
