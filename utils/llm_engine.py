import json
import os

import requests
from dotenv import load_dotenv


load_dotenv()

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY") or os.getenv("DEESEEK_API_KEY")
DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")


WORLD_STATE_SYSTEM_PROMPT = """
You are a digital-humanities narrative analyst and a TRPG world-state designer.
Transform English narrative prose into structured, playable World Status JSON.

Return valid JSON only, without Markdown. Keep every schema key exactly as
specified. Write every generated value in English, including names, summaries,
descriptions, titles, states, goals, clues, events, acts, and scenes. Preserve a
character's canonical English name consistently; never translate or transliterate it.

Use only facts supported by the supplied text and character registry. Do not turn
outside knowledge, guesses, or literary associations into established facts. Use
empty arrays, empty strings, or explicitly tentative language when evidence is
insufficient. Do not invent actions, dialogue, motives, or details merely to enrich
a scene. The character registry is authoritative for identity, aliases, and
coreferential mentions, but it does not add story facts.
""".strip()

TURN_NARRATION_SYSTEM_PROMPT = """
You are the narrator of a literary TRPG session.
Narrate only the already-adjudicated action supplied by the application.
Never change the dice result, outcome, effects, character state, revealed clues,
or scene facts. Never reveal information that is not present in the supplied
visible context. Return valid JSON only, without Markdown.
""".strip()


def _extract_content(payload):
    return payload["choices"][0]["message"]["content"]


def _raise_for_deepseek_error(response):
    if response.ok:
        return

    message = response.text.strip()
    try:
        payload = response.json()
        message = payload.get("error", {}).get("message") or payload.get("detail") or message
    except (ValueError, AttributeError):
        pass
    raise RuntimeError(f"DeepSeek request failed (HTTP {response.status_code}): {message}")


def _normalize_world_state(world_state):
    """Keep legacy atmosphere/scene_state usable while preferring context_variables."""
    if not isinstance(world_state, dict):
        return world_state

    context = world_state.get("context_variables")
    if not isinstance(context, dict):
        context = {}

    if "atmosphere" not in context:
        context["atmosphere"] = world_state.pop("atmosphere", "")
    else:
        world_state.pop("atmosphere", None)

    if "scene_state" not in context:
        context["scene_state"] = world_state.pop("scene_state", "")
    else:
        world_state.pop("scene_state", None)

    world_state["context_variables"] = context
    if not isinstance(world_state.get("acts"), list):
        world_state["acts"] = []
    return world_state


def build_world_state_prompt(text, character_context=None):
    """Build a detailed act-and-scene oriented world-state request."""
    character_registry = json.dumps(character_context or [], ensure_ascii=False, indent=2)
    return f"""
Extract a detailed, playable TRPG world state from the English source below and
return one JSON object.

Language and fidelity requirements:
- Keep the listed JSON keys in English and write every value in English.
- Preserve canonical English names from the character registry. Do not translate names.
- Use only facts explicitly supported by the supplied excerpt.
- Mark inferences as "possible". Use empty arrays, strings, or objects when evidence is absent.
- Treat coreference annotations as identity evidence only, not as new events or characterization.

Required top-level fields:
- summary: a concise English summary of the current narrative.
- acts: an ordered array of dramatic acts, normally 3-6 when the source is long enough. Each act contains
  act_number, title, dramatic_purpose, opening_state, scenes, character_changes,
  clues_revealed, unresolved_threads, closing_state, and next_act_hook.
- scenes: each scene contains title, location, time, participants, objective, beats, conflict,
  discoveries, player_choices, consequences, and transition. participants, beats, discoveries,
  player_choices, and consequences must be arrays. Give each substantial scene 3-6 concrete beats.
- characters: an array whose entries contain name, description, goals, secrets, and status.
- locations: an array whose entries contain name, description, hazards, and clues.
- factions: an array whose entries contain name, agenda, resources, and relationships.
- items: an array whose entries contain name, description, owner, and importance.
- relationships: an array whose entries contain source, target, and relation.
- timeline: an English array of events in source order.
- quests: an array whose entries contain title, hook, objective, and stakes.
- open_threads: an array of unresolved questions or possible follow-up actions.
- context_variables: an object containing atmosphere and scene_state.

Acts and scenes must be more detailed than the summary, but every detail must come
from the source. Split acts only when goals, location, time, revelations, or the
situation materially change. Avoid repeating the same event across multiple arrays.

Authoritative character registry:
{character_registry}

English source text:
{text}
""".strip()


def generate_world_state(text, temperature=0.2, character_context=None):
    if not DEEPSEEK_API_KEY:
        raise RuntimeError("Missing DEEPSEEK_API_KEY. Set it in .env before calling DeepSeek.")

    url = f"{DEEPSEEK_API_URL.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json",
    }
    data = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": WORLD_STATE_SYSTEM_PROMPT},
            {"role": "user", "content": build_world_state_prompt(text, character_context)},
        ],
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }

    response = requests.post(url, headers=headers, json=data, timeout=120)
    _raise_for_deepseek_error(response)

    payload = response.json()
    content = _extract_content(payload)
    try:
        world_state = _normalize_world_state(json.loads(content))
    except json.JSONDecodeError:
        world_state = {"raw": content}

    return {
        "model": DEEPSEEK_MODEL,
        "world_state": world_state,
        "usage": payload.get("usage", {}),
    }


def build_turn_narration_prompt(turn_context):
    serialized = json.dumps(turn_context, ensure_ascii=False, indent=2)
    return f"""
Write an English player-facing narration for the adjudicated solo TRPG turn below.

Requirements:
- narration must be 80-160 English words, literary but concrete and restrained.
- Preserve action.outcome, action.effects, and action.roll exactly; never adjudicate again.
- Use only supplied scene facts, characters, and visible_clues.
- A failed action must still change the pressure through resistance, misunderstanding, or cost.
- suggested_actions must contain 2-3 short English next-step options without choosing for the player.
- Return one JSON object containing narration and suggested_actions only.

Adjudicated turn:
{serialized}
""".strip()


def generate_turn_narration(turn_context, temperature=0.65):
    if not DEEPSEEK_API_KEY:
        raise RuntimeError("Missing DEEPSEEK_API_KEY. Set it in .env before calling DeepSeek.")

    url = f"{DEEPSEEK_API_URL.rstrip('/')}/chat/completions"
    response = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
        },
        json={
            "model": DEEPSEEK_MODEL,
            "messages": [
                {"role": "system", "content": TURN_NARRATION_SYSTEM_PROMPT},
                {"role": "user", "content": build_turn_narration_prompt(turn_context)},
            ],
            "temperature": temperature,
            "response_format": {"type": "json_object"},
        },
        timeout=90,
    )
    _raise_for_deepseek_error(response)
    payload = response.json()
    result = json.loads(_extract_content(payload))
    narration = str(result.get("narration") or "").strip()
    if not narration:
        raise RuntimeError("DeepSeek returned an empty turn narration.")
    suggested_actions = result.get("suggested_actions")
    if not isinstance(suggested_actions, list):
        suggested_actions = []
    return {
        "narration": narration,
        "suggested_actions": [str(item) for item in suggested_actions[:3]],
        "model": payload.get("model", DEEPSEEK_MODEL),
        "usage": payload.get("usage", {}),
    }


def generate_trpg_response(text):
    return generate_world_state(text)
