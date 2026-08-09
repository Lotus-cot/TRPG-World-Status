const SYSTEM_PROMPT = `You are a digital-humanities ontology assistant and TRPG
world-state designer. Convert narrative prose into a detailed, playable JSON
world state. Return valid JSON only, without Markdown. Keep all schema keys and
all generated values in English. Preserve canonical English proper names and
use only facts supported by the supplied fragment and character registry.`;

export function buildPrompt(text, options = {}) {
  const characterRegistry = JSON.stringify(options.characterNames || []);
  if (options.cloudChunked) {
    const compactRule = options.compactRetry
      ? "Emergency compact mode: return exactly 1 scene and at most 1 short entry in every nested array."
      : "Return 1-2 scenes and at most 2 concise entries in every nested array.";
    return `The following narrative is fragment ${options.chunkIndex} of ${options.chunkCount}.
Return one compact but playable English JSON object for this fragment only.
${compactRule}

Required top-level fields:
- summary: no more than 80 English words.
- acts: exactly one act for this fragment. It contains act_number, title,
  dramatic_purpose, opening_state, scenes, character_changes, clues_revealed,
  unresolved_threads, closing_state, and next_act_hook.
- scenes: each contains title, location, time, participants,
  objective, beats, conflict, discoveries, player_choices, consequences, and
  transition. Use short phrases rather than paragraphs.
- characters, locations, factions, items, relationships, timeline, quests,
  open_threads, and context_variables with atmosphere and scene_state.

Preserve names and event order. Only include entities and facts supported by
this fragment. Use canonical names from this character registry when supplied:
${characterRegistry}
Do not repeat the schema in prose and do not return Markdown.

Narrative fragment:
${text}`;
  }

  return `Return one JSON object with these top-level fields:
- summary
- acts: an ordered array of 3-6 dramatic acts when supported. Each act contains
  act_number, title, dramatic_purpose, opening_state, scenes, character_changes,
  clues_revealed, unresolved_threads, closing_state, and next_act_hook.
  Each scene contains title, location, time, participants, objective, beats,
  conflict, discoveries, player_choices, consequences, and transition.
  Write 3-6 concrete beats for each substantial scene.
- characters: items contain name, description, goals, secrets, status
- locations: items contain name, description, hazards, clues
- factions: items contain name, agenda, resources, relationships
- items: items contain name, description, owner, importance
- relationships: items contain source, target, relation
- timeline
- quests: items contain title, hook, objective, stakes
- open_threads
- context_variables: contains atmosphere and scene_state

Separate acts at meaningful reversals, revelations, changes of goal, location,
or time. Do not invent certain facts unsupported by the source. Mark uncertain
inferences as possibilities.

Use canonical English names from this character registry when supplied:
${characterRegistry}

Narrative:
${text}`;
}

export function normalizeWorldState(worldState) {
  if (!worldState || typeof worldState !== "object" || Array.isArray(worldState)) {
    return worldState;
  }
  const context = worldState.context_variables && typeof worldState.context_variables === "object"
    ? worldState.context_variables
    : {};
  context.atmosphere ??= worldState.atmosphere || "";
  context.scene_state ??= worldState.scene_state || "";
  delete worldState.atmosphere;
  delete worldState.scene_state;
  worldState.context_variables = context;
  if (!Array.isArray(worldState.acts)) worldState.acts = [];
  ["characters", "locations", "factions", "items", "relationships", "timeline", "quests", "open_threads"]
    .forEach((field) => {
      if (!Array.isArray(worldState[field])) worldState[field] = [];
    });
  return worldState;
}

export function ensureChunkAct(worldState, chunkIndex) {
  if (worldState.acts.length) return worldState;
  const participants = worldState.characters.map((character) => character?.name).filter(Boolean);
  const timeline = worldState.timeline.map(String).filter(Boolean);
  const discoveries = [
    ...worldState.items.map((item) => item?.name || item?.description),
    ...worldState.open_threads,
  ].filter(Boolean).slice(0, 3);
  const objective = worldState.summary || timeline[0] || "Understand the current fragment and choose the next action";
  worldState.acts = [{
    act_number: chunkIndex,
    title: `Narrative Fragment ${chunkIndex}`,
    dramatic_purpose: objective,
    opening_state: worldState.context_variables.scene_state || objective,
    scenes: [{
      title: timeline[0] || `Key Scene in Fragment ${chunkIndex}`,
      location: worldState.locations[0]?.name || "Unspecified location",
      time: "Source narrative order",
      participants,
      objective,
      beats: timeline.slice(0, 3),
      conflict: worldState.open_threads[0] || "The characters must respond to the current situation",
      discoveries,
      player_choices: ["Continue investigating", "Speak with someone present"],
      consequences: worldState.open_threads.slice(0, 2),
      transition: worldState.open_threads[0] || "Continue to the next narrative fragment",
    }],
    character_changes: [],
    clues_revealed: discoveries,
    unresolved_threads: worldState.open_threads.slice(0, 3),
    closing_state: worldState.context_variables.scene_state || objective,
    next_act_hook: worldState.open_threads[0] || "The next fragment continues the event",
  }];
  return worldState;
}

function slugName(name) {
  return `character-${String(name || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function aliasesFor(name) {
  const clean = String(name || "").trim();
  const withoutTitle = clean.replace(/^(?:Mr|Mrs|Ms|Miss|Dr|Professor|Prof|Sir|Lady|Lord|Captain|Capt|Colonel|Col)\.?\s+/i, "");
  const parts = withoutTitle.split(/\s+/).filter(Boolean);
  return [...new Set([clean, withoutTitle, parts[0], parts.length > 1 ? parts.at(-1) : ""].filter(Boolean))];
}

export function buildCloudCharacterResolution(text, suppliedNames, worldState, chunkIndex = 1) {
  const generatedNames = (worldState.characters || []).map((character) => character?.name).filter(Boolean);
  const names = [...new Set([...(suppliedNames || []), ...generatedNames].map(String).map((name) => name.trim()).filter(Boolean))];
  const characters = names.map((name) => {
    const aliases = aliasesFor(name);
    const mentions = [];
    aliases.sort((left, right) => right.length - left.length).forEach((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(^|[^A-Za-z0-9'])(${escaped})(?![A-Za-z0-9'])`, "gi");
      let match;
      while ((match = pattern.exec(text))) {
        const start = match.index + match[1].length;
        mentions.push({
          start,
          end: start + match[2].length,
          text: match[2],
          character_id: slugName(name),
          kind: "explicit",
          source: "cloud_alias_match",
          confidence: 0.9,
          chunk_index: chunkIndex,
        });
      }
    });
    const uniqueMentions = [...new Map(mentions.map((mention) => [`${mention.start}:${mention.end}`, mention])).values()]
      .sort((left, right) => left.start - right.start);
    return {
      id: slugName(name),
      name,
      aliases,
      source: suppliedNames?.includes(name) ? "provided" : "generated",
      mention_count: uniqueMentions.length,
      mentions: uniqueMentions,
    };
  }).filter((character) => character.mention_count > 0);

  return {
    language: "en",
    roster_source: suppliedNames?.length ? "provided" : "generated",
    roster_size: names.length,
    window_count: 1,
    characters,
    stages: [
      { name: "character_roster", engine: "provided or generated names", status: "ready", characters: names.length },
      { name: "explicit_character_linking", engine: "cloud alias matcher", status: "fallback", mentions: characters.reduce((sum, item) => sum + item.mention_count, 0) },
      { name: "explicit_link_validation", engine: "DeepSeek chunk generation context", status: "partial", reason: "Per-mention closed-registry validation is available in the local backend." },
      { name: "window_coreference_expansion", engine: "not available in Netlify", status: "unavailable", reason: "Use the local backend with Maverick installed." },
      { name: "cross_window_merge", engine: "browser stable character id union", status: "pending" },
    ],
    annotated_text: text,
  };
}

function jsonResponse(payload, statusCode = 200) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  };
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse({ detail: "Method not allowed" }, 405);
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return jsonResponse({ detail: "Missing DEEPSEEK_API_KEY in Netlify environment variables." }, 500);
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse({ detail: "Invalid JSON request body." }, 400);
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return jsonResponse({ detail: "Text is required." }, 400);
  }
  if (text.length > 5000) {
    return jsonResponse({ detail: "Cloud input is too long for one function call. Refresh the page to use chunked generation." }, 413);
  }

  const cloudChunked = body.cloud_chunked === true;
  const compactRetry = body.compact_retry === true;
  const chunkIndex = Math.max(1, Number(body.chunk_index) || 1);
  const chunkCount = Math.max(chunkIndex, Number(body.chunk_count) || chunkIndex);
  const characterNames = Array.isArray(body.character_names) ? body.character_names.map(String).filter(Boolean) : [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 24000);
    let response;
    try {
      response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildPrompt(text, { cloudChunked, compactRetry, chunkIndex, chunkCount, characterNames }) },
          ],
          temperature: cloudChunked ? 0.1 : 0.2,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const error = await response.text();
      return jsonResponse({ detail: `DeepSeek request failed: ${error}` }, response.status);
    }

    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content || "{}";
    const worldState = normalizeWorldState(JSON.parse(content));
    if (cloudChunked) ensureChunkAct(worldState, chunkIndex);
    return jsonResponse({
      input_chunks: [text],
      resolved_chunks: [text],
      resolved_text: text,
      character_resolution: buildCloudCharacterResolution(text, characterNames, worldState, chunkIndex),
      world_state: worldState,
      model: payload.model || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      usage: payload.usage || {},
      cloud_chunked: cloudChunked,
      chunk_index: chunkIndex,
      chunk_count: chunkCount,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return jsonResponse({ detail: "DeepSeek generation timed out for this fragment. The browser will retry once." }, 504);
    }
    return jsonResponse({ detail: error.message || "World-state generation failed." }, 500);
  }
};
