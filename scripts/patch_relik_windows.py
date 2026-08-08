"""Apply the ReLiK CSV field-size compatibility fix for 64-bit Windows."""

from pathlib import Path
import sys


DEFAULT_RELIK_FILE = Path(
    r"D:\WorldStatusNLP\venv\Lib\site-packages\relik\retriever\indexers\document.py"
)


def patch(path: Path = DEFAULT_RELIK_FILE) -> bool:
    source = path.read_text(encoding="utf-8")
    old = "csv.field_size_limit(sys.maxsize)"
    new = "csv.field_size_limit(min(sys.maxsize, 2**31 - 1))"
    if new in source:
        return False
    if old not in source:
        raise RuntimeError(f"Expected ReLiK field-size line was not found: {path}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")
    return True


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_RELIK_FILE
    changed = patch(target)
    print("patched" if changed else "already patched")
