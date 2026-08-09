(function initWorldStateClient(globalScope) {
  "use strict";

  const ARRAY_FIELDS = [
    "characters",
    "locations",
    "factions",
    "items",
    "relationships",
    "timeline",
    "quests",
    "open_threads",
  ];

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function textOf(value) {
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
      return String(value.name || value.title || value.description || JSON.stringify(value)).trim();
    }
    return value == null ? "" : String(value);
  }

  function splitNarrativeText(text, maxChars = 1200) {
    const limit = Math.max(500, Math.min(Number(maxChars) || 1200, 1800));
    const normalized = String(text || "").replace(/\r\n?/g, "\n").trim();
    if (!normalized) return [];

    const sentences = normalized.match(/[^.!?。！？\n]+(?:[.!?。！？]+[\"'”’』」》）)\]}]*|$)/g) || [normalized];
    const chunks = [];
    let current = "";

    function pushCurrent() {
      const value = current.trim();
      if (value) chunks.push(value);
      current = "";
    }

    sentences.forEach((sentence) => {
      let value = sentence.trim();
      if (!value) return;
      if (value.length > limit) {
        pushCurrent();
        while (value.length > limit) {
          chunks.push(value.slice(0, limit));
          value = value.slice(limit);
        }
        current = value;
        return;
      }
      if (current && current.length + value.length + 1 > limit) pushCurrent();
      current = current ? `${current} ${value}` : value;
    });
    pushCurrent();
    return chunks;
  }

  function stableKey(value) {
    if (typeof value === "string") return value.trim().toLocaleLowerCase();
    if (value && typeof value === "object") {
      const identity = value.name || value.title;
      if (identity) return String(identity).trim().toLocaleLowerCase();
    }
    return JSON.stringify(value);
  }

  function mergeValues(previous, incoming) {
    if (Array.isArray(previous) || Array.isArray(incoming)) {
      const values = [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(incoming) ? incoming : [])];
      const seen = new Set();
      return values.filter((value) => {
        const key = stableKey(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    if (previous && incoming && typeof previous === "object" && typeof incoming === "object") {
      return mergeObjects(previous, incoming);
    }
    if (typeof previous === "string" && typeof incoming === "string") {
      return incoming.length > previous.length ? incoming : previous;
    }
    return incoming ?? previous;
  }

  function mergeObjects(previous, incoming) {
    const result = clone(previous || {});
    Object.entries(incoming || {}).forEach(([key, value]) => {
      result[key] = result[key] === undefined ? clone(value) : mergeValues(result[key], value);
    });
    return result;
  }

  function mergeCollection(values) {
    const result = [];
    const indexes = new Map();
    values.forEach((value) => {
      const key = stableKey(value);
      if (!indexes.has(key)) {
        indexes.set(key, result.length);
        result.push(clone(value));
        return;
      }
      const index = indexes.get(key);
      result[index] = mergeValues(result[index], value);
    });
    return result;
  }

  function consolidateActs(sourceActs, maxActs = 6) {
    const acts = sourceActs.map(clone);
    if (acts.length <= maxActs) {
      return acts.map((act, index) => ({ ...act, act_number: index + 1 }));
    }

    const groups = Array.from({ length: maxActs }, () => []);
    acts.forEach((act, index) => {
      groups[Math.min(maxActs - 1, Math.floor(index * maxActs / acts.length))].push(act);
    });
    return groups.filter((group) => group.length).map((group, index) => {
      const first = group[0];
      const last = group[group.length - 1];
      return {
        ...first,
        act_number: index + 1,
        title: group.length === 1 ? first.title : `${textOf(first.title)} / ${textOf(last.title)}`,
        dramatic_purpose: group.map((act) => textOf(act.dramatic_purpose)).filter(Boolean).join("; "),
        opening_state: first.opening_state || "",
        scenes: group.flatMap((act) => Array.isArray(act.scenes) ? act.scenes : []),
        character_changes: mergeCollection(group.flatMap((act) => Array.isArray(act.character_changes) ? act.character_changes : [])),
        clues_revealed: mergeCollection(group.flatMap((act) => Array.isArray(act.clues_revealed) ? act.clues_revealed : [])),
        unresolved_threads: mergeCollection(group.flatMap((act) => Array.isArray(act.unresolved_threads) ? act.unresolved_threads : [])),
        closing_state: last.closing_state || "",
        next_act_hook: last.next_act_hook || "",
      };
    });
  }

  function sumUsage(payloads) {
    return payloads.reduce((total, payload) => {
      Object.entries(payload.usage || {}).forEach(([key, value]) => {
        if (typeof value === "number") total[key] = Number(total[key] || 0) + value;
      });
      return total;
    }, {});
  }

  function mergeCharacterResolutions(payloads, originalText = "") {
    const resolutions = payloads.map((payload) => payload.character_resolution).filter(Boolean);
    if (!resolutions.length) return null;
    const byId = new Map();
    resolutions.forEach((resolution, resolutionIndex) => {
      (resolution.characters || []).forEach((character) => {
        const id = character.id || stableKey(character);
        const target = byId.get(id) || { ...clone(character), aliases: [], mentions: [] };
        target.aliases = [...new Set([...(target.aliases || []), ...(character.aliases || [])])];
        (character.mentions || []).forEach((mention) => {
          target.mentions.push({ ...clone(mention), chunk_index: mention.chunk_index || resolutionIndex + 1 });
        });
        byId.set(id, target);
      });
    });
    const characters = [...byId.values()].map((character) => {
      const mentionMap = new Map();
      character.mentions.forEach((mention) => {
        const key = `${mention.chunk_index}:${mention.start}:${mention.end}:${mention.text}`;
        mentionMap.set(key, mention);
      });
      const mentions = [...mentionMap.values()];
      return { ...character, mentions, mention_count: mentions.length };
    });
    const firstStages = clone(resolutions[0].stages || []);
    const mergeStage = firstStages.find((stage) => stage.name === "cross_window_merge");
    if (mergeStage) {
      mergeStage.status = "ready";
      mergeStage.characters = characters.length;
      mergeStage.mentions = characters.reduce((sum, character) => sum + character.mention_count, 0);
    }
    return {
      language: "en",
      roster_source: resolutions.some((resolution) => resolution.roster_source === "provided") ? "provided" : "generated",
      roster_size: characters.length,
      window_count: resolutions.length,
      characters,
      stages: firstStages,
      annotated_text: originalText,
    };
  }

  function mergeWorldStatePayloads(payloads, originalText = "") {
    const valid = payloads.filter((payload) => payload?.world_state && typeof payload.world_state === "object");
    if (!valid.length) throw new Error("Cloud chunks did not return a valid World Status.");

    const states = valid.map((payload) => payload.world_state);
    const summaries = states.map((state) => textOf(state.summary)).filter(Boolean);
    const worldState = {
      summary: summaries.join(" "),
      acts: consolidateActs(states.flatMap((state) => Array.isArray(state.acts) ? state.acts : [])),
    };
    ARRAY_FIELDS.forEach((field) => {
      worldState[field] = mergeCollection(states.flatMap((state) => Array.isArray(state[field]) ? state[field] : []));
    });
    const contexts = states.map((state) => state.context_variables || {});
    worldState.context_variables = {
      atmosphere: mergeCollection(contexts.map((context) => context.atmosphere).filter(Boolean)).map(textOf).join("; "),
      scene_state: textOf([...contexts].reverse().find((context) => context.scene_state)?.scene_state),
    };

    return {
      input_chunks: valid.flatMap((payload) => payload.input_chunks || []),
      resolved_chunks: valid.flatMap((payload) => payload.resolved_chunks || []),
      resolved_text: originalText || valid.map((payload) => payload.resolved_text || "").join("\n\n"),
      character_resolution: mergeCharacterResolutions(valid, originalText),
      world_state: worldState,
      model: valid.find((payload) => payload.model)?.model || "",
      usage: sumUsage(valid),
      cloud_chunked: true,
      cloud_chunk_count: valid.length,
    };
  }

  const api = { consolidateActs, mergeCharacterResolutions, mergeWorldStatePayloads, splitNarrativeText };
  globalScope.WorldStateClient = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
