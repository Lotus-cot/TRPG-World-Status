const assert = require("node:assert/strict");

const requests = [];
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  requests.push({ url, body });
  if (url.endsWith("/api/v1/sessions")) {
    return {
      ok: true,
      status: 201,
      async json() {
        return {
          ok: true,
          data: {
            session_id: "session-test",
            selected_actor_id: "gabriel_conroy",
            version: 0,
          },
        };
      },
    };
  }
  if (url.endsWith("/inspirations")) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          data: {
            state_version: 0,
            suggestions: [
              { suggestion_id: "s1", stance: "cautious", action_type: "observe", text: "Watch the room", source: "rule_fallback" },
              { suggestion_id: "s2", stance: "exploratory", action_type: "empathize", text: "Speak to Gretta", source: "rule_fallback" },
              { suggestion_id: "s3", stance: "bold", action_type: "confront", text: "Name the tension", source: "rule_fallback" },
            ],
          },
        };
      },
    };
  }
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        ok: true,
        data: {
          event_id: "formal-event-1",
          new_version: 4,
          rng_seed: 777,
          roll: {
            die: 20,
            modifier: 4,
            total: 24,
            difficulty: 12,
            margin: 12,
            outcome: "critical_revelation",
          },
        },
      };
    },
  };
};

const {
  createSession,
  requestInspirationsThroughRuntime,
  resolveActionThroughRuntime,
} = require("./game.js");

async function run() {
  const moduleState = {
    summary: "The Dead",
    characters: [{ id: "the-dead:character:gabriel-conroy", name: "Gabriel Conroy" }],
    timeline: ["The annual dance begins."],
  };
  const session = createSession(moduleState, "Gabriel Conroy");
  const inspired = await requestInspirationsThroughRuntime(session, { use_ai: false });
  const resolved = await resolveActionThroughRuntime(inspired, {
    action_type: "observe",
    target: "the room",
    difficulty: 12,
    action_text: "Study the guests",
  });

  assert.equal(requests[0].body.selected_character_id, "the-dead:character:gabriel-conroy");
  assert.equal(requests[1].body.actor_id, "gabriel_conroy");
  assert.equal(inspired.inspiration_suggestions.length, 3);
  assert.equal(inspired.runtime_state_version, 0);
  assert.match(requests[2].url, /sessions\/session-test\/actions\/resolve$/);
  assert.equal(requests[2].body.actor_id, "gabriel_conroy");
  assert.equal(requests[2].body.trait, "insight");
  assert.equal(requests[2].body.expected_state_version, 0);
  assert.equal(resolved.runtime_state_version, 4);
  assert.equal(resolved.last_result.formal_event_id, "formal-event-1");
  assert.equal(resolved.last_result.rng_seed, 777);
  assert.equal(resolved.last_result.authority, "event_generator");
  assert.equal(resolved.logs.at(-1).formal_event_id, "formal-event-1");
}

run()
  .then(() => console.log("Authoritative runtime bridge checks passed."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
