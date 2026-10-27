"""Daily copies of the database. SQLite's online backup copies a consistent snapshot while the server keeps
running; each copy is checked before it replaces anything, and only the newest few are kept."""
import sqlite3
from pathlib import Path


def make_backup(db_path: Path, folder: Path, stamp: str, keep: int) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"msu-{stamp}.sqlite3"
    part = folder / f"msu-{stamp}.part"
    src, dst = sqlite3.connect(db_path), sqlite3.connect(part)
    try:
        src.backup(dst)
        verdict = dst.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        dst.close()
        src.close()
    if verdict != "ok":
        part.unlink(missing_ok=True)
        raise RuntimeError(f"the copy failed its integrity check: {verdict}")
    part.replace(target)
    for old in sorted(folder.glob("msu-*.sqlite3"))[:-keep]:
        old.unlink()
    return target
