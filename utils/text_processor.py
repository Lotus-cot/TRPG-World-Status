#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from functools import lru_cache
from importlib.util import find_spec
from pathlib import Path
import json
import os
import re


BASE_DIR = Path(__file__).resolve().parents[1]
COREF_MODEL_PATH = BASE_DIR / "data" / "coref-spanbert-large-2021.03.10.tar.gz"
DEFAULT_TRANSFORMER_MODEL_PATH = BASE_DIR / "data" / "spanbert-large-cased"


def get_coref_unavailable_reason():
    """Return why SpanBERT cannot run, or ``None`` when prerequisites exist."""
    try:
        if find_spec("allennlp") is None:
            return "AllenNLP is not installed in the active Python environment."
    except (ImportError, ValueError):
        return "AllenNLP cannot be imported from the active Python environment."

    if not COREF_MODEL_PATH.exists():
        return f"Coreference model not found: {COREF_MODEL_PATH}"
    return None


@lru_cache(maxsize=1)
def get_coref_predictor():
    from allennlp.predictors import Predictor

    if not COREF_MODEL_PATH.exists():
        raise FileNotFoundError(f"Coreference model not found: {COREF_MODEL_PATH}")

    transformer_model_path = os.getenv("COREF_TRANSFORMER_MODEL_PATH")
    if not transformer_model_path and DEFAULT_TRANSFORMER_MODEL_PATH.exists():
        transformer_model_path = str(DEFAULT_TRANSFORMER_MODEL_PATH)

    overrides = None
    if transformer_model_path:
        overrides = json.dumps(
            {
                "dataset_reader.token_indexers.tokens.model_name": transformer_model_path,
                "validation_dataset_reader.token_indexers.tokens.model_name": transformer_model_path,
                "model.text_field_embedder.token_embedders.tokens.model_name": transformer_model_path,
            }
        )

    cuda_device = int(os.getenv("COREF_CUDA_DEVICE", "-1"))

    return Predictor.from_path(
        str(COREF_MODEL_PATH),
        predictor_name="coreference_resolution",
        cuda_device=cuda_device,
        overrides=overrides,
    )


def split_text(text, max_chars=1200):
    sentences = local_sentence_tokenize(text)
    chunks = []
    current = []
    current_len = 0

    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue

        if current and current_len + len(sentence) + 1 > max_chars:
            chunks.append(" ".join(current))
            current = []
            current_len = 0

        current.append(sentence)
        current_len += len(sentence) + 1

    if current:
        chunks.append(" ".join(current))

    return chunks


ABBREVIATIONS = {
    "Mr.",
    "Mrs.",
    "Ms.",
    "Dr.",
    "Prof.",
    "Sr.",
    "Jr.",
    "St.",
    "Mt.",
    "Capt.",
    "Col.",
    "Gen.",
    "Lt.",
    "Sgt.",
    "Rev.",
    "Hon.",
    "No.",
    "Fig.",
    "etc.",
    "e.g.",
    "i.e.",
    "vs.",
    "U.S.",
    "U.K.",
}

CLOSING_QUOTES = {'"', "'", "\u2019", "\u201d", ")", "]", "}"}
SENTENCE_ENDINGS = ".!?"


def local_sentence_tokenize(text):
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
    sentences = []

    for paragraph in paragraphs:
        normalized = re.sub(r"[ \t\r\f\v]+", " ", paragraph)
        sentences.extend(_split_paragraph(normalized))

    return sentences


def _split_paragraph(paragraph):
    sentences = []
    start = 0
    index = 0

    while index < len(paragraph):
        char = paragraph[index]
        if char not in SENTENCE_ENDINGS:
            index += 1
            continue

        if _is_decimal_point(paragraph, index) or _is_abbreviation(paragraph, index):
            index += 1
            continue

        end = index + 1
        while end < len(paragraph) and paragraph[end] in CLOSING_QUOTES:
            end += 1

        if _is_sentence_boundary(paragraph, end):
            sentence = paragraph[start:end].strip()
            if sentence:
                sentences.append(sentence)
            start = end

        index = end

    tail = paragraph[start:].strip()
    if tail:
        sentences.append(tail)

    return sentences


def _is_decimal_point(text, index):
    return (
        text[index] == "."
        and index > 0
        and index + 1 < len(text)
        and text[index - 1].isdigit()
        and text[index + 1].isdigit()
    )


def _is_abbreviation(text, index):
    if text[index] != ".":
        return False

    token_start = text.rfind(" ", 0, index) + 1
    token = text[token_start : index + 1]

    if token in ABBREVIATIONS:
        return True

    if re.fullmatch(r"(?:[A-Z]\.){1,}", token):
        return True

    return False


def _is_sentence_boundary(text, index):
    if index >= len(text):
        return True

    if index > 0 and text[index - 1] in SENTENCE_ENDINGS:
        return True

    next_char = text[index]
    if next_char.isspace():
        return True

    return next_char in "\n\r"


def preprocess_text(file_path):
    with open(file_path, "r", encoding="utf-8") as f:
        return split_text(f.read())


@lru_cache(maxsize=128)
def coref_resolve(text):
    unavailable_reason = get_coref_unavailable_reason()
    if unavailable_reason:
        if os.getenv("COREF_REQUIRED", "0") == "1":
            raise RuntimeError(unavailable_reason)
        return text

    try:
        predictor = get_coref_predictor()
    except (ImportError, ModuleNotFoundError):
        if os.getenv("COREF_REQUIRED", "0") == "1":
            raise
        return text
    return predictor.coref_resolved(text)


def coref_resolve_many(chunks):
    return [coref_resolve(chunk) for chunk in chunks]
