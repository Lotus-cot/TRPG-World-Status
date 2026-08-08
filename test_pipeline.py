from utils.llm_engine import (
    WORLD_STATE_SYSTEM_PROMPT,
    _normalize_world_state,
    build_turn_narration_prompt,
    build_world_state_prompt,
)
from utils.character_pipeline import (
    _rule_explicit_mentions,
    compact_character_context,
    load_default_character_roster,
    merge_character_clusters,
    run_character_pipeline,
    split_word_windows,
    validate_mentions,
)
from utils import text_processor
from utils.text_processor import local_sentence_tokenize
import pipeline


def test_ontology_prompt_contains_context_variables():
    prompt = build_world_state_prompt("Alice saw Bob. She waved to him.")
    assert "context_variables" in prompt
    assert "narrative objects" not in prompt.lower()
    assert "events in source order" in prompt
    assert "factions" in prompt
    assert "every generated value in English" in WORLD_STATE_SYSTEM_PROMPT


def test_legacy_context_fields_are_normalized():
    world_state = {
        "summary": "demo",
        "atmosphere": "Snow, cold, and reflection",
        "scene_state": "Gabriel is reflecting by the window",
    }

    normalized = _normalize_world_state(world_state)
    assert "atmosphere" not in normalized
    assert "scene_state" not in normalized
    assert normalized["context_variables"]["atmosphere"] == "Snow, cold, and reflection"
    assert normalized["context_variables"]["scene_state"] == "Gabriel is reflecting by the window"


def test_prompt_requests_detailed_acts_and_scenes():
    prompt = build_world_state_prompt("Alice entered the house.")
    assert "- acts:" in prompt
    assert "player_choices" in prompt
    assert "next_act_hook" in prompt
    assert "3-6 concrete beats" in prompt
    assert "write every value in English" in prompt

    normalized = _normalize_world_state({"summary": "demo"})
    assert normalized["acts"] == []


def test_generated_english_values_are_not_translated():
    normalized = _normalize_world_state({
        "summary": "After the snow, he discovers the secret.",
        "characters": [{"name": "Gabriel Conroy", "status": "Reflective"}],
    })
    assert normalized["summary"] == "After the snow, he discovers the secret."
    assert normalized["characters"][0]["name"] == "Gabriel Conroy"


def test_local_sentence_tokenizer_handles_english_quotes():
    sentences = local_sentence_tokenize('"Has the snow stopped?" she asked. Alice saw Bob. She waved.')
    assert sentences == ['"Has the snow stopped?"', "she asked.", "Alice saw Bob.", "She waved."]


def test_turn_narration_prompt_preserves_rule_authority():
    prompt = build_turn_narration_prompt({
        "scene": {"title": "The Old Song on the Stairs"},
        "action": {"outcome": "success_with_cost", "effects": ["connection -1"]},
        "visible_clues": [],
    })
    assert "never adjudicate again" in prompt
    assert "success_with_cost" in prompt
    assert "suggested_actions" in prompt


def test_character_pipeline_uses_provided_english_roster(monkeypatch):
    monkeypatch.setenv("CHARACTER_DEEPSEEK_VALIDATION_ENABLED", "0")
    monkeypatch.setenv("CHARACTER_RELIK_ENABLED", "0")
    monkeypatch.setenv("CHARACTER_MAVERICK_ENABLED", "0")
    text = (
        "Elizabeth Bennet entered the room. Mr. Darcy watched Elizabeth carefully. "
        "She greeted Mr. Darcy, and he bowed."
    )
    result = run_character_pipeline(text, ["Elizabeth Bennet", "Mr. Darcy"])

    assert result["language"] == "en"
    assert result["roster_source"] == "provided"
    assert [character["name"] for character in result["characters"]] == [
        "Elizabeth Bennet",
        "Mr. Darcy",
    ]
    assert result["stages"][1]["status"] == "fallback"
    assert result["stages"][-1]["engine"] == "stable character id union"


def test_character_context_keeps_canonical_names(monkeypatch):
    monkeypatch.setenv("CHARACTER_DEEPSEEK_VALIDATION_ENABLED", "0")
    monkeypatch.setenv("CHARACTER_RELIK_ENABLED", "0")
    monkeypatch.setenv("CHARACTER_MAVERICK_ENABLED", "0")
    result = run_character_pipeline(
        "Gabriel Conroy greeted Gretta. Gabriel looked away.",
        ["Gabriel Conroy", "Gretta Conroy"],
    )
    context = compact_character_context(result)
    assert context[0]["name"] == "Gabriel Conroy"
    assert "Gabriel" in context[0]["mention_examples"]


def test_the_dead_registry_uses_stable_character_ids(monkeypatch):
    monkeypatch.setenv("CHARACTER_DEEPSEEK_VALIDATION_ENABLED", "0")
    monkeypatch.setenv("CHARACTER_RELIK_ENABLED", "0")
    monkeypatch.setenv("CHARACTER_MAVERICK_ENABLED", "0")
    result = run_character_pipeline("Gabriel Conroy greeted Gretta Conroy.")

    assert result["roster_source"] == "the_dead_fixed_registry"
    assert result["roster_size"] == 26
    assert [character["id"] for character in result["characters"]] == [
        "the-dead:character:gabriel-conroy",
        "the-dead:character:gretta-conroy",
    ]


def test_ambiguous_title_is_resolved_inside_closed_registry(monkeypatch):
    roster = load_default_character_roster()
    text = "Kate Morkan stood by the door. A guest addressed Miss Morkan."
    mentions = _rule_explicit_mentions(text, roster)

    monkeypatch.setenv("CHARACTER_DEEPSEEK_VALIDATION_ENABLED", "1")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(
        "utils.character_pipeline._resolve_with_deepseek",
        lambda source, mention, candidates: "the-dead:character:kate-morkan",
    )
    validated, stage = validate_mentions(text, roster, mentions)

    title = next(mention for mention in validated if mention["text"] == "Miss Morkan")
    assert title["character_id"] == "the-dead:character:kate-morkan"
    assert title["validated_by"] == "deepseek-v4-flash"
    assert stage["deepseek_checked"] == 1


def test_word_windows_overlap_and_cluster_merge():
    text = " ".join(f"word{i}" for i in range(250))
    windows = split_word_windows(text, max_words=100, overlap_words=20)
    assert len(windows) == 3
    assert windows[1]["word_start"] == 80

    roster = [{"id": "character-alice", "name": "Alice", "aliases": ["Alice"], "source": "provided"}]
    explicit = [{
        "start": 0, "end": 5, "text": "Alice", "character_id": "character-alice",
        "kind": "explicit", "source": "test", "confidence": 1.0,
    }]
    expanded = [{
        "start": 20, "end": 23, "text": "she", "character_id": "character-alice",
        "kind": "pronoun", "source": "test", "confidence": 0.9,
    }]
    clusters = merge_character_clusters(roster, explicit, expanded)
    assert clusters[0]["mention_count"] == 2


def test_world_status_pipeline_returns_character_resolution(monkeypatch):
    monkeypatch.setenv("CHARACTER_RELIK_ENABLED", "0")
    monkeypatch.setenv("CHARACTER_MAVERICK_ENABLED", "0")
    monkeypatch.setenv("CHARACTER_DEEPSEEK_VALIDATION_ENABLED", "0")
    pipeline._run_pipeline_cached.cache_clear()

    captured = {}

    def fake_generate(text, temperature=0.2, character_context=None):
        captured["text"] = text
        captured["characters"] = character_context
        return {
            "model": "test-model",
            "world_state": {"summary": "Alice greets Bob.", "acts": []},
            "usage": {"total_tokens": 1},
        }

    monkeypatch.setattr(pipeline, "generate_world_state", fake_generate)
    result = pipeline.run_pipeline_from_text(
        "Alice saw Bob. Alice greeted Bob.",
        character_names=["Alice", "Bob"],
    )

    assert result["language"] == "en"
    assert result["character_resolution"]["roster_source"] == "provided"
    assert [item["name"] for item in captured["characters"]] == ["Alice", "Bob"]
    assert result["world_state"]["summary"] == "Alice greets Bob."
    pipeline._run_pipeline_cached.cache_clear()


def test_coreference_falls_back_to_source_text_when_allennlp_is_unavailable(monkeypatch):
    text_processor.coref_resolve.cache_clear()
    monkeypatch.delenv("COREF_REQUIRED", raising=False)
    monkeypatch.setattr(
        text_processor,
        "get_coref_unavailable_reason",
        lambda: "AllenNLP is unavailable for this test.",
    )

    source = "Alice saw Bob. She waved."
    assert text_processor.coref_resolve(source) == source
    text_processor.coref_resolve.cache_clear()


if __name__ == "__main__":
    test_ontology_prompt_contains_context_variables()
    test_legacy_context_fields_are_normalized()
    test_prompt_requests_detailed_acts_and_scenes()
    test_local_sentence_tokenizer_handles_english_quotes()
    test_turn_narration_prompt_preserves_rule_authority()
    print("Lightweight ontology pipeline checks passed.")
