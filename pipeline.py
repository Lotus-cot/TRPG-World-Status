#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import json
from copy import deepcopy
from functools import lru_cache
from pathlib import Path
from typing import Optional, Sequence

from utils.llm_engine import generate_world_state
from utils.character_pipeline import compact_character_context, run_character_pipeline
from utils.text_processor import preprocess_text, split_text


BASE_DIR = Path(__file__).resolve().parent
DATA_FILE = BASE_DIR / "data" / "the_dead_first_half.txt"
OUTPUT_FILE = BASE_DIR / "data" / "trpg_output.json"


@lru_cache(maxsize=16)
def _run_pipeline_cached(text, max_chars, character_names):
    chunks = split_text(text, max_chars=max_chars)
    character_resolution = run_character_pipeline(text, character_names)
    resolved_text = character_resolution["annotated_text"]
    resolved_chunks = split_text(resolved_text, max_chars=max_chars)
    llm_result = generate_world_state(
        resolved_text,
        character_context=compact_character_context(character_resolution),
    )

    return {
        "language": "en",
        "source_text": text,
        "input_chunks": chunks,
        "resolved_chunks": resolved_chunks,
        "resolved_text": resolved_text,
        "character_resolution": character_resolution,
        "world_state": llm_result["world_state"],
        "model": llm_result["model"],
        "usage": llm_result["usage"],
    }


def run_pipeline_from_text(text, max_chars=1200, character_names: Optional[Sequence[str]] = None):
    roster = tuple(str(name).strip() for name in (character_names or []) if str(name).strip())
    return deepcopy(_run_pipeline_cached(text, max_chars, roster))


def run_pipeline(input_file=DATA_FILE, output_file=OUTPUT_FILE):
    chunks = preprocess_text(input_file)
    text = "\n\n".join(chunks)
    result = run_pipeline_from_text(text)

    output_file = Path(output_file)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"Pipeline completed. Output saved to {output_file}")
    return result


if __name__ == "__main__":
    run_pipeline()
