#!/usr/bin/env python3
"""Run the balance simulator against the real shared modules.

The modules in src/shared use Roblox-style `require(script.Parent.Foo)`, which
the standalone Luau CLI does not understand. Rather than contorting the game
code to be runnable in two environments, this script copies the shared modules
to a temp directory, rewrites those requires to Luau path requires, and runs
tools/simulate.luau against the copy.

src/ is never modified.

Usage:
    python3 tools/run_simulation.py [rolls] [luck] [--luau PATH]
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHARED = ROOT / "src" / "shared"
SIMULATE = ROOT / "tools" / "simulate.luau"

# require(script.Parent.Foo) and require(script.Parent.Parent.Bar) -> require("./Foo")
REQUIRE_PATTERN = re.compile(r"require\(script(?:\.Parent)+\.([A-Za-z_][A-Za-z0-9_]*)\)")


def find_luau(explicit: str | None) -> str:
    if explicit:
        return explicit
    found = shutil.which("luau")
    if found:
        return found
    sys.exit(
        "luau CLI not found on PATH.\n"
        "Install it with `rokit add luau-lang/luau` (see rokit.toml), or download a\n"
        "release from https://github.com/luau-lang/luau/releases and pass --luau PATH."
    )


def stage(workdir: Path) -> None:
    for source in SHARED.glob("*.luau"):
        text = source.read_text(encoding="utf-8")
        text = REQUIRE_PATTERN.sub(r'require("./\1")', text)
        (workdir / source.name).write_text(text, encoding="utf-8")

    shutil.copy(SIMULATE, workdir / "simulate.luau")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("rolls", nargs="?", default="1000000", help="number of rolls to simulate")
    parser.add_argument("luck", nargs="?", default="1", help="luck multiplier to simulate at")
    parser.add_argument("--luau", default=None, help="path to the luau CLI binary")
    args = parser.parse_args()

    luau = find_luau(args.luau)

    with tempfile.TemporaryDirectory(prefix="pokerng-sim-") as tmp:
        workdir = Path(tmp)
        stage(workdir)

        result = subprocess.run(
            [luau, "simulate.luau", "--program-args", args.rolls, args.luck],
            cwd=workdir,
        )
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
