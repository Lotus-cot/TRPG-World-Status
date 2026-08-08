const assert = require("node:assert/strict");
const { mergeWorldStatePayloads, splitNarrativeText } = require("./world-state-client.js");

const source = Array.from({ length: 60 }, (_, index) => `Sentence ${index + 1} contains a small event.`).join(" ");
const chunks = splitNarrativeText(source, 500);
assert.ok(chunks.length >= 2);
assert.equal(chunks.join(" ").replace(/\s+/g, " "), source);

const payload = (index, name) => ({
  input_chunks: [`chunk-${index}`],
  resolved_chunks: [`chunk-${index}`],
  resolved_text: `chunk-${index}`,
  model: "deepseek-v4-flash",
  usage: { total_tokens: 10 },
  world_state: {
    summary: `Summary ${index}`,
    acts: [{ title: `Act ${index}`, scenes: [{ title: `Scene ${index}` }] }],
    characters: [{ name, goals: [`Goal ${index}`] }],
    locations: [], factions: [], items: [], relationships: [], timeline: [], quests: [], open_threads: [],
    context_variables: { atmosphere: "Cold", scene_state: `State ${index}` },
  },
  character_resolution: {
    language: "en",
    roster_source: "provided",
    characters: [{
      id: `character-${name.toLowerCase()}`,
      name,
      aliases: [name],
      mentions: [{ start: index, end: index + name.length, text: name, chunk_index: index }],
    }],
    stages: [
      { name: "character_roster", status: "ready" },
      { name: "cross_window_merge", status: "pending" },
    ],
  },
});

const merged = mergeWorldStatePayloads([payload(1, "Alice"), payload(2, "Alice")], "full text");
assert.equal(merged.cloud_chunk_count, 2);
assert.equal(merged.world_state.characters.length, 1);
assert.deepEqual(merged.world_state.characters[0].goals, ["Goal 1", "Goal 2"]);
assert.equal(merged.world_state.acts.length, 2);
assert.equal(merged.world_state.acts[1].act_number, 2);
assert.equal(merged.world_state.context_variables.scene_state, "State 2");
assert.equal(merged.usage.total_tokens, 20);
assert.equal(merged.resolved_text, "full text");
assert.equal(merged.character_resolution.characters.length, 1);
assert.equal(merged.character_resolution.characters[0].mention_count, 2);
assert.equal(merged.character_resolution.stages.at(-1).status, "ready");

console.log("World-state cloud client checks passed.");
