const assert = require("node:assert/strict");
const {
  advanceScene,
  createSession,
  determineOutcome,
  normalizeScenes,
  resolveAction,
} = require("./game.js");

const moduleState = {
  summary: "Literary Test Module",
  characters: [
    { name: "Aya", description: "A cautious observer", goals: ["Understand the past"], status: "Calm" },
    { name: "Lin", description: "Hides a memory", goals: [], status: "Silent" },
  ],
  acts: [
    {
      act_number: 1,
      title: "The Old Song",
      dramatic_purpose: "Bring memory into the present",
      scenes: [
        {
          title: "The Song on the Stairs",
          participants: ["Aya", "Lin"],
          objective: "Understand the reason for the silence",
          discoveries: ["The old song is connected to Lin's past"],
          transition: "Everyone leaves the sitting room",
        },
        {
          title: "A Conversation in the Snow",
          participants: ["Aya", "Lin"],
          objective: "Decide whether to continue asking",
          discoveries: ["The past has more than one version"],
        },
      ],
    },
  ],
  quests: [{ title: "Understand the Past", objective: "Determine the old song's meaning" }],
  open_threads: ["Who else remembers that snow?"],
  context_variables: { atmosphere: "Restrained and cold", scene_state: "The gathering is ending" },
};

function run() {
  assert.equal(normalizeScenes(moduleState).length, 2);
  assert.equal(determineOutcome(20, 20, 20), "critical_revelation");
  assert.equal(determineOutcome(10, 15, 10), "full_success");
  assert.equal(determineOutcome(8, 11, 12), "partial_information");
  assert.equal(determineOutcome(1, 99, 6), "obstacle");

const created = createSession(moduleState, "Aya");
  assert.equal(created.status, "active");
assert.equal(created.character.name, "Aya");
  assert.equal(created.logs[0].type, "session_start");

  const resolved = resolveAction(created, {
    action_type: "observe",
  target: "Lin",
    difficulty: 12,
  action_text: "Watch her reaction when she hears the old song",
  }, () => 20);
  assert.equal(resolved.turn, 1);
  assert.equal(resolved.last_result.outcome, "critical_revelation");
  assert.equal(resolved.discovered_clues.length, 1);
  assert.equal(resolved.logs.at(-1).roll.die, 20);
  assert.equal(resolved.ending_progress.understanding, 2);

  const nextScene = advanceScene(resolved);
  assert.equal(nextScene.scene_cursor, 1);
  assert.equal(nextScene.logs.at(-1).type, "scene_change");

  const ending = advanceScene(nextScene);
  assert.equal(ending.status, "completed");
assert.equal(ending.ending.title, "A Belated Insight");
  assert.equal(ending.logs.at(-1).type, "ending");
}

run();
console.log("Solo game engine checks passed.");
