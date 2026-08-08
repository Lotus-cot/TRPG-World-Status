"""English literary character linking and book-scale coreference orchestration.

The pipeline follows the BOOKCOREF ordering while keeping every heavyweight
component optional:

1. Build or accept a book-specific character roster.
2. Link explicit mentions to that roster (ReLiK when configured).
3. Validate uncertain links with the configured DeepSeek endpoint.
4. Expand clusters in word-bounded windows with Maverick.
5. Merge local clusters by stable character id.

When an optional model is unavailable, the stage reports a transparent
fallback instead of preventing World Status generation.
"""

from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from importlib.util import find_spec
import json
import os
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests
from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR / ".env.character", override=False)
DEFAULT_ROSTER_PATH = BASE_DIR / "data" / "the_dead_characters.json"


TITLE_PATTERN = r"(?:Mr|Mrs|Ms|Miss|Dr|Professor|Prof|Sir|Lady|Lord|Captain|Capt|Colonel|Col|Father|Mother)\."
TITLE_OPTIONAL_PERIOD_PATTERN = r"(?:Mr|Mrs|Ms|Miss|Dr|Professor|Prof|Sir|Lady|Lord|Captain|Capt|Colonel|Col|Father|Mother)\.?"
NAME_TOKEN_PATTERN = r"[A-Z][A-Za-z]*(?:['-][A-Z]?[A-Za-z]+)?"
TITLED_NAME_RE = re.compile(
    rf"\b(?P<name>{TITLE_OPTIONAL_PERIOD_PATTERN}\s+{NAME_TOKEN_PATTERN}(?:\s+{NAME_TOKEN_PATTERN}){{0,2}})\b"
)
MULTI_NAME_RE = re.compile(rf"\b(?P<name>{NAME_TOKEN_PATTERN}(?:\s+{NAME_TOKEN_PATTERN}){{1,2}})\b")
SINGLE_NAME_RE = re.compile(rf"\b(?P<name>{NAME_TOKEN_PATTERN})\b")
WORD_RE = re.compile(r"\S+")

NON_CHARACTER_TERMS = {
    "A", "An", "And", "As", "At", "Book", "Chapter", "Christmas", "Day",
    "English", "For", "From", "God", "He", "Her", "Here", "Him", "His",
    "I", "If", "In", "Ireland", "Irish", "It", "Its", "January", "Monday",
    "No", "Now", "Of", "On", "One", "Or", "She", "Sunday", "The", "Their",
    "Them", "Then", "There", "They", "This", "Those", "To", "We", "When",
    "Where", "Who", "Why", "With", "Yes", "You",
}
PRONOUNS = {
    "he", "him", "his", "himself", "she", "her", "hers", "herself",
    "they", "them", "their", "theirs", "themselves",
}


def _normalize_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9' -]+", " ", str(value or ""))
    return re.sub(r"\s+", " ", value).strip().casefold()


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", _normalize_name(value)).strip("-")
    return f"character-{slug or 'unknown'}"


def _dedupe_strings(values: Iterable[str]) -> List[str]:
    seen = set()
    result = []
    for value in values:
        clean = re.sub(r"\s+", " ", str(value or "")).strip()
        key = _normalize_name(clean)
        if clean and key and key not in seen:
            seen.add(key)
            result.append(clean)
    return result


def _aliases_for_name(name: str) -> List[str]:
    clean = re.sub(r"\s+", " ", name).strip()
    without_title = re.sub(rf"^{TITLE_OPTIONAL_PERIOD_PATTERN}\s+", "", clean)
    parts = without_title.split()
    aliases = [clean, without_title]
    if len(parts) >= 2:
        aliases.extend([parts[0], parts[-1]])
        title_match = re.match(rf"^(?P<title>{TITLE_OPTIONAL_PERIOD_PATTERN})\s+", clean)
        if title_match:
            aliases.append(f"{title_match.group('title')} {parts[-1]}")
    return _dedupe_strings(aliases)


def _coerce_roster(character_names: Optional[Sequence[Any]]) -> List[Dict[str, Any]]:
    roster = []
    used_ids = Counter()
    for item in character_names or []:
        if isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            aliases = list(item.get("aliases") or [])
            contextual_aliases = list(item.get("contextual_aliases") or [])
            requested_id = str(item.get("id") or "").strip()
            metadata = {
                key: value
                for key, value in item.items()
                if key not in {"id", "name", "aliases", "contextual_aliases", "source"}
            }
        else:
            name = str(item or "").strip()
            aliases = []
            contextual_aliases = []
            requested_id = ""
            metadata = {}
        if not name:
            continue
        base_id = requested_id or _slug(name)
        used_ids[base_id] += 1
        character_id = base_id if used_ids[base_id] == 1 else f"{base_id}-{used_ids[base_id]}"
        roster.append({
            **metadata,
            "id": character_id,
            "name": name,
            "aliases": _dedupe_strings([name, *aliases, *_aliases_for_name(name)]),
            "contextual_aliases": _dedupe_strings(contextual_aliases),
            "source": str(item.get("source") or "provided") if isinstance(item, dict) else "provided",
        })
    return roster


@lru_cache(maxsize=4)
def load_character_registry(path: str) -> List[Dict[str, Any]]:
    registry_path = Path(path)
    with registry_path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    entries = payload.get("characters", []) if isinstance(payload, dict) else payload
    if not isinstance(entries, list):
        raise ValueError(f"Character registry must contain a character list: {registry_path}")
    roster = _coerce_roster(entries)
    for character in roster:
        character["source"] = "the_dead_fixed_registry"
    return roster


def load_default_character_roster() -> List[Dict[str, Any]]:
    configured = os.getenv("CHARACTER_ROSTER_PATH", "").strip()
    path = Path(configured) if configured else DEFAULT_ROSTER_PATH
    return [dict(character) for character in load_character_registry(str(path.resolve()))]


def infer_character_roster(text: str, max_characters: int = 80) -> List[Dict[str, Any]]:
    """Infer a conservative English roster when the user did not provide one."""
    candidates: Counter[str] = Counter()
    titled = [match.group("name") for match in TITLED_NAME_RE.finditer(text)]
    candidates.update(titled)

    for match in MULTI_NAME_RE.finditer(text):
        name = match.group("name")
        if any(token in NON_CHARACTER_TERMS for token in name.split()):
            continue
        candidates[name] += 1

    single_counts = Counter(match.group("name") for match in SINGLE_NAME_RE.finditer(text))
    known_parts = {
        part
        for name in candidates
        for part in re.sub(rf"^{TITLE_OPTIONAL_PERIOD_PATTERN}\s+", "", name).split()
    }
    for name, count in single_counts.items():
        if name in NON_CHARACTER_TERMS:
            continue
        if count >= 2 or name in known_parts:
            candidates[name] += count

    selected: List[str] = []
    covered_aliases = set()
    for name, count in sorted(candidates.items(), key=lambda item: (-item[1], -len(item[0]), item[0])):
        normalized = _normalize_name(name)
        if not normalized or normalized in covered_aliases:
            continue
        selected.append(name)
        covered_aliases.update(_normalize_name(alias) for alias in _aliases_for_name(name))
        if len(selected) >= max_characters:
            break

    roster = _coerce_roster(selected)
    for character in roster:
        character["source"] = "inferred"
    return roster


def _alias_index(roster: Sequence[Dict[str, Any]], include_contextual: bool = False) -> Dict[str, List[str]]:
    index: Dict[str, List[str]] = {}
    for character in roster:
        aliases = list(character.get("aliases", []))
        if include_contextual:
            aliases.extend(character.get("contextual_aliases", []))
        for alias in aliases:
            index.setdefault(_normalize_name(alias), []).append(character["id"])
    return index


def _character_by_id(roster: Sequence[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {character["id"]: character for character in roster}


def _assign_alias(text: str, alias_index: Dict[str, List[str]]) -> Optional[str]:
    candidates = alias_index.get(_normalize_name(text), [])
    return candidates[0] if len(candidates) == 1 else None


def _mention(start: int, end: int, text: str, character_id: str, kind: str, source: str, confidence: float) -> Dict[str, Any]:
    return {
        "start": int(start),
        "end": int(end),
        "text": text,
        "character_id": character_id,
        "kind": kind,
        "source": source,
        "confidence": round(float(confidence), 3),
    }


def _rule_explicit_mentions(text: str, roster: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    matches: Dict[Tuple[int, int], Dict[str, Any]] = {}
    characters = _character_by_id(roster)
    all_index = _alias_index(roster, include_contextual=True)
    contextual_keys = {
        _normalize_name(alias)
        for character in roster
        for alias in character.get("contextual_aliases", [])
    }

    display_aliases: Dict[str, str] = {}
    for character in roster:
        for alias in [*character.get("aliases", []), *character.get("contextual_aliases", [])]:
            display_aliases.setdefault(_normalize_name(alias), alias)

    for alias_key, candidate_ids in sorted(all_index.items(), key=lambda item: len(item[0]), reverse=True):
        alias = display_aliases.get(alias_key, alias_key)
        if len(alias) < 2:
            continue
        pattern = re.compile(rf"(?<![A-Za-z0-9']){re.escape(alias)}(?![A-Za-z0-9'])", re.IGNORECASE)
        for found in pattern.finditer(text):
            key = (found.start(), found.end())
            existing = matches.get(key)
            unique_ids = list(dict.fromkeys(candidate_ids))
            character_id = unique_ids[0] if len(unique_ids) == 1 else ""
            canonical = bool(
                character_id
                and _normalize_name(found.group(0)) == _normalize_name(characters[character_id]["name"])
            )
            contextual = alias_key in contextual_keys or len(unique_ids) > 1
            confidence = 1.0 if canonical else 0.55 if contextual else 0.98
            candidate = _mention(
                found.start(), found.end(), found.group(0), character_id,
                "nominal" if contextual else "explicit",
                "contextual_alias" if contextual else "alias_match",
                confidence,
            )
            candidate["candidate_character_ids"] = unique_ids
            candidate["requires_validation"] = contextual
            if not existing or len(candidate["text"]) > len(existing["text"]):
                matches[key] = candidate

    ordered = sorted(matches.values(), key=lambda item: (item["start"], -(item["end"] - item["start"])))
    kept = []
    last_end = -1
    for item in ordered:
        if item["start"] < last_end:
            continue
        kept.append(item)
        last_end = item["end"]
    return kept


@lru_cache(maxsize=1)
def _load_relik():
    from relik import Relik

    model_name = os.getenv("CHARACTER_RELIK_MODEL", "sapienzanlp/relik-entity-linking-small")
    return Relik.from_pretrained(
        model_name,
        retriever=None,
        device=os.getenv("CHARACTER_RELIK_DEVICE", "cpu"),
    )


def _relik_mentions(text: str, roster: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    candidates = [character["name"] for character in roster]
    output = _load_relik()(text, candidates=candidates)
    alias_index = _alias_index(roster)
    mentions = []
    for span in getattr(output, "spans", []) or []:
        span_text = str(getattr(span, "text", "") or "")
        label = str(getattr(span, "label", "") or "")
        character_id = _assign_alias(label, alias_index) or _assign_alias(span_text, alias_index)
        if not character_id:
            continue
        start = int(getattr(span, "start", -1))
        end = int(getattr(span, "end", -1))
        if start >= 0 and end > start:
            mention = _mention(start, end, span_text, character_id, "explicit", "relik_reader", 0.9)
            mention["candidate_character_ids"] = [character_id]
            mention["requires_validation"] = True
            mentions.append(mention)
    return mentions


def detect_explicit_mentions(text: str, roster: Sequence[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    registry_mentions = _rule_explicit_mentions(text, roster)
    enabled = os.getenv("CHARACTER_RELIK_ENABLED", "0") == "1"
    if enabled and find_spec("relik") is not None:
        try:
            relik_mentions = _relik_mentions(text, roster)
            merged = {}
            for mention in [*relik_mentions, *registry_mentions]:
                key = (mention["start"], mention["end"], mention.get("character_id", ""))
                previous = merged.get(key)
                if previous is None or mention.get("confidence", 0) > previous.get("confidence", 0):
                    merged[key] = mention
            mentions = sorted(merged.values(), key=lambda item: (item["start"], item["end"]))
            return mentions, {
                "name": "explicit_character_linking",
                "engine": f"The Dead registry + {os.getenv('CHARACTER_RELIK_MODEL', 'ReLiK')} reader",
                "status": "ready",
                "mentions": len(mentions),
                "registry_mentions": len(registry_mentions),
                "relik_mentions": len(relik_mentions),
            }
        except Exception as exc:
            reason = f"ReLiK failed: {exc}"
    elif enabled:
        reason = "The relik package is not installed."
    else:
        reason = "ReLiK is disabled; set CHARACTER_RELIK_ENABLED=1 to enable it."

    return registry_mentions, {
        "name": "explicit_character_linking",
        "engine": "English alias matcher",
        "status": "fallback",
        "mentions": len(registry_mentions),
        "reason": reason,
    }


def _deepseek_endpoint() -> str:
    base = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com").rstrip("/")
    return base if base.endswith("/chat/completions") else f"{base}/chat/completions"


def _deepseek_api_key() -> str:
    return os.getenv("DEEPSEEK_API_KEY") or os.getenv("DEESEEK_API_KEY") or ""


def _context_around(text: str, start: int, end: int, radius_words: int = 200) -> str:
    words = list(WORD_RE.finditer(text))
    if not words:
        return text[max(0, start - 1000):min(len(text), end + 1000)]
    containing = next((i for i, word in enumerate(words) if word.start() <= start < word.end()), 0)
    left = words[max(0, containing - radius_words)].start()
    right = words[min(len(words) - 1, containing + radius_words)].end()
    local_start = start - left
    local_end = end - left
    excerpt = text[left:right]
    return f"{excerpt[:local_start]}[{excerpt[local_start:local_end]}]{excerpt[local_end:]}"


def _resolve_with_deepseek(
    text: str,
    mention: Dict[str, Any],
    candidates: Sequence[Dict[str, Any]],
) -> Optional[str]:
    endpoint = _deepseek_endpoint()
    api_key = _deepseek_api_key()
    candidate_payload = [
        {
            "id": character["id"],
            "name": character["name"],
            "aliases": character.get("aliases", []),
            "description": character.get("description", ""),
        }
        for character in candidates
    ]
    prompt = (
        "Resolve the highlighted character mention in this excerpt from James Joyce's The Dead. "
        "Choose exactly one candidate only when the context supports it; otherwise choose NONE. "
        "Return JSON only as {\"character_id\": \"candidate id or NONE\"}.\n\n"
        f"Candidates:\n{json.dumps(candidate_payload, ensure_ascii=False)}\n\n"
        f"Excerpt:\n{_context_around(text, mention['start'], mention['end'])}"
    )
    response = requests.post(
        endpoint,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
            "messages": [
                {
                    "role": "system",
                    "content": "You resolve ambiguous character mentions against a closed literary character registry.",
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": 0,
            "thinking": {"type": "disabled"},
            "response_format": {"type": "json_object"},
            "max_tokens": 80,
        },
        timeout=float(os.getenv("CHARACTER_DEEPSEEK_TIMEOUT_SECONDS", "45")),
    )
    response.raise_for_status()
    content = response.json()["choices"][0]["message"]["content"]
    selected = str(json.loads(content).get("character_id") or "NONE").strip()
    allowed = {character["id"] for character in candidates}
    return selected if selected in allowed else None


def validate_mentions(text: str, roster: Sequence[Dict[str, Any]], mentions: Sequence[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    enabled = os.getenv("CHARACTER_DEEPSEEK_VALIDATION_ENABLED", "1") == "1"
    api_key = _deepseek_api_key()
    characters = _character_by_id(roster)
    trusted = [
        mention
        for mention in mentions
        if mention.get("character_id")
        and not mention.get("requires_validation")
        and mention.get("confidence", 0) >= 0.98
    ]
    uncertain = [mention for mention in mentions if mention not in trusted]

    if not enabled or not api_key:
        deterministic = [
            mention
            for mention in uncertain
            if mention.get("character_id") and len(mention.get("candidate_character_ids", [])) <= 1
        ]
        kept = [
            dict(mention, validated_by="deterministic_registry")
            for mention in [*trusted, *deterministic]
        ]
        return kept, {
            "name": "explicit_link_validation",
            "engine": "deterministic The Dead registry",
            "status": "fallback",
            "validated": len(kept),
            "rejected": len(mentions) - len(kept),
            "reason": (
                "DeepSeek character validation is disabled."
                if not enabled else
                "DEEPSEEK_API_KEY is not configured."
            ),
        }

    kept = [
        dict(mention, validated_by="exact_canonical_match")
        for mention in trusted
    ]
    rejected = 0
    errors = 0
    workers = max(1, min(int(os.getenv("CHARACTER_DEEPSEEK_MAX_CONCURRENCY", "2")), 8))

    def check(mention):
        candidate_ids = list(dict.fromkeys(mention.get("candidate_character_ids", [])))
        if not candidate_ids and mention.get("character_id"):
            candidate_ids = [mention["character_id"]]
        candidates = [characters[item] for item in candidate_ids if item in characters]
        if not candidates:
            return mention, None, "missing_candidates"
        try:
            return mention, _resolve_with_deepseek(text, mention, candidates), None
        except Exception as exc:
            return mention, None, str(exc)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(check, mention) for mention in uncertain]
        for future in as_completed(futures):
            mention, selected_id, error = future.result()
            if error:
                errors += 1
                if mention.get("character_id") and len(mention.get("candidate_character_ids", [])) <= 1:
                    kept.append(dict(mention, validated_by="deterministic_error_fallback"))
                    continue
            if selected_id:
                kept.append(dict(
                    mention,
                    character_id=selected_id,
                    validated_by=os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
                ))
            else:
                rejected += 1
    kept.sort(key=lambda mention: (mention["start"], mention["end"]))
    return kept, {
        "name": "explicit_link_validation",
        "engine": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        "status": "ready" if errors == 0 else "partial",
        "validated": len(kept),
        "deepseek_checked": len(uncertain),
        "rejected": rejected,
        "errors": errors,
    }


def split_word_windows(text: str, max_words: int = 1500, overlap_words: int = 150) -> List[Dict[str, Any]]:
    words = list(WORD_RE.finditer(text))
    if not words:
        return []
    max_words = max(100, int(max_words))
    overlap_words = max(0, min(int(overlap_words), max_words // 3))
    step = max_words - overlap_words
    windows = []
    for word_start in range(0, len(words), step):
        word_end = min(len(words), word_start + max_words)
        start = words[word_start].start()
        end = words[word_end - 1].end()
        windows.append({
            "index": len(windows),
            "start": start,
            "end": end,
            "word_start": word_start,
            "word_end": word_end,
            "text": text[start:end],
        })
        if word_end == len(words):
            break
    return windows


@lru_cache(maxsize=1)
def _load_maverick():
    from maverick import Maverick
    import torch

    checkpoint = os.getenv("CHARACTER_MAVERICK_CHECKPOINT", "").strip()
    model_source = checkpoint if checkpoint and Path(checkpoint).is_file() else os.getenv(
        "CHARACTER_MAVERICK_MODEL", "sapienzanlp/maverick-mes-litbank"
    )
    if checkpoint and model_source == checkpoint:
        # Maverick's official Lightning checkpoint predates PyTorch 2.6's
        # weights_only default. Limit the compatibility override to this
        # configured, local checkpoint and restore torch.load immediately.
        original_torch_load = torch.load

        def trusted_checkpoint_load(*args, **kwargs):
            kwargs.setdefault("weights_only", False)
            return original_torch_load(*args, **kwargs)

        torch.load = trusted_checkpoint_load
        try:
            return Maverick(
                hf_name_or_path=model_source,
                device=os.getenv("CHARACTER_MAVERICK_DEVICE", "cpu"),
            )
        finally:
            torch.load = original_torch_load

    return Maverick(
        hf_name_or_path=model_source,
        device=os.getenv("CHARACTER_MAVERICK_DEVICE", "cpu"),
    )


def _cluster_offsets(prediction: Dict[str, Any]) -> List[List[Tuple[int, int]]]:
    clusters = prediction.get("clusters_char_offsets") or []
    result = []
    for cluster in clusters:
        parsed = []
        for pair in cluster:
            if isinstance(pair, (list, tuple)) and len(pair) == 2:
                parsed.append((int(pair[0]), int(pair[1])))
        if parsed:
            result.append(parsed)
    return result


def _maverick_expand_window(
    window: Dict[str, Any],
    explicit_mentions: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    prediction = _load_maverick().predict(window["text"])
    expanded = []
    for cluster in _cluster_offsets(prediction):
        global_spans = []
        for local_start, local_end in cluster:
            # Maverick reports inclusive character ends in its public examples.
            global_start = window["start"] + local_start
            global_end = window["start"] + local_end + 1
            global_spans.append((global_start, global_end))
        anchors = {
            mention["character_id"]
            for mention in explicit_mentions
            if any(
                mention["start"] < span_end and mention["end"] > span_start
                for span_start, span_end in global_spans
            )
        }
        if len(anchors) != 1:
            continue
        character_id = next(iter(anchors))
        for start, end in global_spans:
            mention_text = window["text"][start - window["start"]:end - window["start"]]
            kind = "pronoun" if _normalize_name(mention_text) in PRONOUNS else "nominal"
            expanded.append(_mention(start, end, mention_text, character_id, kind, "maverick", 0.9))
    return expanded


def expand_with_maverick(
    text: str,
    explicit_mentions: Sequence[Dict[str, Any]],
    windows: Sequence[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    enabled = os.getenv("CHARACTER_MAVERICK_ENABLED", "0") == "1"
    if enabled and find_spec("maverick") is not None:
        expanded = []
        errors = []
        for window in windows:
            local_anchors = [
                mention for mention in explicit_mentions
                if mention["start"] < window["end"] and mention["end"] > window["start"]
            ]
            if not local_anchors:
                continue
            try:
                expanded.extend(_maverick_expand_window(window, local_anchors))
            except Exception as exc:
                errors.append(f"window {window['index']}: {exc}")
        return expanded, {
            "name": "window_coreference_expansion",
            "engine": os.getenv("CHARACTER_MAVERICK_MODEL", "sapienzanlp/maverick-mes-litbank"),
            "status": "ready" if not errors else "partial",
            "windows": len(windows),
            "mentions": len(expanded),
            "errors": errors[:3],
        }

    reason = (
        "The maverick-coref package is not installed."
        if enabled else
        "Maverick is disabled; set CHARACTER_MAVERICK_ENABLED=1 to enable it."
    )
    return [], {
        "name": "window_coreference_expansion",
        "engine": "none",
        "status": "unavailable",
        "windows": len(windows),
        "mentions": 0,
        "reason": reason,
    }


def merge_character_clusters(
    roster: Sequence[Dict[str, Any]],
    explicit_mentions: Sequence[Dict[str, Any]],
    expanded_mentions: Sequence[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    by_character: Dict[str, Dict[Tuple[int, int], Dict[str, Any]]] = {
        character["id"]: {} for character in roster
    }
    for mention in [*explicit_mentions, *expanded_mentions]:
        character_mentions = by_character.get(mention.get("character_id"))
        if character_mentions is None:
            continue
        key = (mention["start"], mention["end"])
        existing = character_mentions.get(key)
        if not existing or mention.get("confidence", 0) > existing.get("confidence", 0):
            character_mentions[key] = mention

    result = []
    for character in roster:
        mentions = sorted(by_character[character["id"]].values(), key=lambda item: (item["start"], item["end"]))
        if not mentions:
            continue
        result.append({
            **character,
            "mention_count": len(mentions),
            "mentions": mentions,
        })
    return result


def annotate_coreferences(text: str, clusters: Sequence[Dict[str, Any]]) -> str:
    additions = []
    for cluster in clusters:
        for mention in cluster.get("mentions", []):
            if mention.get("kind") not in {"pronoun", "nominal"}:
                continue
            additions.append((mention["end"], f" [{cluster['name']}]"))
    resolved = text
    seen = set()
    for position, annotation in sorted(additions, reverse=True):
        key = (position, annotation)
        if key in seen:
            continue
        seen.add(key)
        resolved = f"{resolved[:position]}{annotation}{resolved[position:]}"
    return resolved


def compact_character_context(result: Dict[str, Any], mention_sample_size: int = 8) -> List[Dict[str, Any]]:
    context = []
    for character in result.get("characters", []):
        mentions = character.get("mentions", [])
        context.append({
            "id": character["id"],
            "name": character["name"],
            "aliases": character.get("aliases", []),
            "mention_examples": _dedupe_strings(item.get("text", "") for item in mentions)[:mention_sample_size],
            "mention_count": character.get("mention_count", len(mentions)),
        })
    return context


def character_pipeline_status() -> Dict[str, Any]:
    roster_path = Path(os.getenv("CHARACTER_ROSTER_PATH", str(DEFAULT_ROSTER_PATH)))
    return {
        "language": "en",
        "roster": {
            "profile": os.getenv("CHARACTER_DEFAULT_ROSTER", "the_dead"),
            "path": str(roster_path),
            "available": roster_path.exists(),
        },
        "relik": {
            "enabled": os.getenv("CHARACTER_RELIK_ENABLED", "0") == "1",
            "installed": find_spec("relik") is not None,
            "model": os.getenv("CHARACTER_RELIK_MODEL", "sapienzanlp/relik-entity-linking-small"),
            "knowledge_base": "The Dead fixed character registry",
            "device": os.getenv("CHARACTER_RELIK_DEVICE", "cpu"),
        },
        "deepseek_validation": {
            "enabled": os.getenv("CHARACTER_DEEPSEEK_VALIDATION_ENABLED", "1") == "1",
            "configured": bool(_deepseek_api_key()),
            "model": os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        },
        "maverick": {
            "enabled": os.getenv("CHARACTER_MAVERICK_ENABLED", "0") == "1",
            "installed": find_spec("maverick") is not None,
            "model": os.getenv("CHARACTER_MAVERICK_MODEL", "sapienzanlp/maverick-mes-litbank"),
            "device": os.getenv("CHARACTER_MAVERICK_DEVICE", "cpu"),
        },
    }


def run_character_pipeline(text: str, character_names: Optional[Sequence[Any]] = None) -> Dict[str, Any]:
    roster = _coerce_roster(character_names)
    roster_source = "provided"
    if not roster:
        if os.getenv("CHARACTER_DEFAULT_ROSTER", "the_dead") == "the_dead":
            roster = load_default_character_roster()
            roster_source = "the_dead_fixed_registry"
        else:
            roster = infer_character_roster(text)
            roster_source = "inferred"

    explicit, relik_stage = detect_explicit_mentions(text, roster)
    validated, deepseek_stage = validate_mentions(text, roster, explicit)
    windows = split_word_windows(
        text,
        max_words=int(os.getenv("CHARACTER_WINDOW_WORDS", "1500")),
        overlap_words=int(os.getenv("CHARACTER_WINDOW_OVERLAP_WORDS", "150")),
    )
    expanded, maverick_stage = expand_with_maverick(text, validated, windows)
    characters = merge_character_clusters(roster, validated, expanded)

    return {
        "language": "en",
        "roster_source": roster_source,
        "roster_size": len(roster),
        "window_count": len(windows),
        "characters": characters,
        "stages": [
            {
                "name": "character_roster",
                "engine": {
                    "provided": "provided roster",
                    "the_dead_fixed_registry": "The Dead fixed character registry",
                    "inferred": "English name inference",
                }[roster_source],
                "status": "ready",
                "characters": len(roster),
            },
            relik_stage,
            deepseek_stage,
            maverick_stage,
            {
                "name": "cross_window_merge",
                "engine": "stable character id union",
                "status": "ready",
                "characters": len(characters),
                "mentions": sum(character["mention_count"] for character in characters),
            },
        ],
        "annotated_text": annotate_coreferences(text, characters),
    }
