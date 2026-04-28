#!/usr/bin/env python3
# @atlas: Generates LLM context bundles (frontend & backend) by concatenating source files, ignoring blacklisted dirs/extensions. Also regenerates the code_atlas.md preamble.

"""
bundle.py
─────────
Concatenates source files into per-root bundle files for LLM context windows.

code_atlas.md is prepended into the output directory so you can grab
everything from one place.

Usage
─────
    # Regenerate all bundles into outputs/markdowns/
    python3 bundle.py
"""

import argparse
import shutil
from datetime import datetime, timezone
from pathlib import Path
import re

REPO_ROOT = Path(__file__).resolve().parent

PREAMBLE_FILE = "code_atlas.md"
OUTPUT_DIR = REPO_ROOT / "outputs" / "markdowns"

# ── Blacklist ────────────────────────────────────────────────────────────────
# Directories and extensions we DO NOT want to bundle
BLACKLIST_DIRS = {
    ".git",
    ".pixi",
    ".agent",
    "node_modules",
    "__pycache__",
    "outputs",
    "dist",
    "aerial_tifs",
    "baked_sectors",
    "stubai",
    "aerial_downloader",
    "winter_reality_aerial_downloader",
    "hive_assets"  # Usually skip context docs if not needed in code bundles
}

BLACKLIST_EXTS = {
    ".tif", ".pdf", ".json", ".png", ".jpg", ".jpeg", ".lock", ".out", ".log", ".DS_Store",
    ".bin", ".webp", ".ktx2", ".geojson", ".bak"
}

def is_blacklisted(path: Path) -> bool:
    if path.suffix in BLACKLIST_EXTS or path.name in BLACKLIST_EXTS:
        return True
    for part in path.parts:
        if part in BLACKLIST_DIRS:
            return True
        if part.startswith('.') and part not in {'.', '..', '.gitignore'}:
            return True
    return False

# ── Bundles ──────────────────────────────────────────────────────────────────

def gather_files(base_dir: str) -> list[str]:
    files = []
    base_path = REPO_ROOT / base_dir
    if not base_path.exists():
        return files
    for p in base_path.rglob("*"):
        if p.is_file() and not is_blacklisted(p):
            files.append(str(p.relative_to(REPO_ROOT)))
    files.sort()
    return files

BUNDLES = {
    "backend": gather_files("hex_backend"),
    "frontend": gather_files("frontend"),
}

SEP = "=" * 80

def file_banner(rel_path: str, idx: int, total: int) -> str:
    lines = [
        "",
        f"# {SEP}",
        f"# FILE {idx}/{total}",
        f"# Path: {rel_path}",
        f"# {SEP}",
        "",
    ]
    return "\n".join(lines)

def rough_token_estimate(text: str) -> int:
    return len(text) // 4

def build_bundle(name: str, paths: list[str]) -> None:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    chunks = []
    
    total = len(paths)
    for i, rel in enumerate(paths, start=1):
        fpath = REPO_ROOT / rel
        try:
            text = fpath.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            print(f"  ⚠️  SKIP (binary/decode error): {rel}")
            continue
            
        line_count = text.count("\n")
        print(f"  + ({i}/{total}) {rel}  [{line_count} lines]")

        chunks.append(file_banner(rel, i, total))
        chunks.append(text)
        if not text.endswith("\n"):
            chunks.append("\n")

    full_text = "\n".join(chunks)
    tokens = rough_token_estimate(full_text)

    header = (
        f"# Hexagons — Code Bundle: {name}\n"
        f"#\n"
        f"# Generated : {now}\n"
        f"# Repo root : {REPO_ROOT}\n"
        f"# Files     : {total} included\n"
        f"# Est tokens: ~{tokens:,}\n"
        f"#\n"
        f"# File list:\n"
    )
    for rel in paths:
        header += f"#   {rel}\n"
    header += f"#\n# {SEP}\n\n"

    full_text = header + full_text

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"{name}_bundle.md"
    out_path.write_text(full_text, encoding="utf-8")

    size_kb = out_path.stat().st_size / 1024
    print(f"\n  ✅  {name} → {out_path.name}  ({size_kb:.1f} KB, ~{tokens:,} tokens)\n")

def main() -> None:
    print("Building code atlas...")
    atlas_lines = [
        "# Hexagons — Code Atlas",
        "",
        "Ski terrain hexagon visualization and preprocessing pipeline.",
        "",
        "> **Atlas freshness:** Updated automatically.",
        "",
        "---",
        ""
    ]
    
    # Matches `@atlas: description` in python, js, html, css, shell
    atlas_pattern = re.compile(r"^(?://|#|/\*|<!--)\s*@atlas:\s*(.+?)(?:\*/|-->)?$", re.MULTILINE)
    
    entries = []
    
    for path in REPO_ROOT.rglob("*"):
        if not path.is_file() or is_blacklisted(path):
            continue
            
        try:
            content = path.read_text(encoding="utf-8")
            m = atlas_pattern.search(content)
            if m:
                rel_path = path.relative_to(REPO_ROOT)
                entries.append((str(rel_path), m.group(1).strip()))
        except Exception:
            pass
            
    entries.sort(key=lambda x: x[0])
    
    for rel_path, desc in entries:
        atlas_lines.append(f"- **`{rel_path}`** — {desc}")
        
    atlas_file = REPO_ROOT / PREAMBLE_FILE
    atlas_file.write_text("\n".join(atlas_lines) + "\n", encoding="utf-8")
    print(f"  ✅  Wrote {len(entries)} entries to {PREAMBLE_FILE}")

    for name, paths in BUNDLES.items():
        print(f"\n── Building bundle: {name} {'─' * (50 - len(name))}")
        if paths:
            build_bundle(name, paths)
        else:
            print("  ⚠️  No files found for bundle.")

    preamble_src = REPO_ROOT / PREAMBLE_FILE
    if preamble_src.exists():
        preamble_dst = OUTPUT_DIR / PREAMBLE_FILE
        shutil.copy2(preamble_src, preamble_dst)
        print(f"  📄  Copied {PREAMBLE_FILE} → {preamble_dst.relative_to(REPO_ROOT)}")

    print("Done.")

if __name__ == "__main__":
    main()
