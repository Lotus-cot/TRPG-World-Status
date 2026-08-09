(function initWorldGame(globalScope) {
  "use strict";

  const STORAGE_KEY = "trpg-world-status:solo-session:v1";
  const SESSION_VERSION = "1.0";
  const API_BASE = globalScope.location?.protocol === "file:" ? "http://127.0.0.1:8000" : "";
  const RUNTIME_API_BASE = globalScope.WORLD_STATUS_RUNTIME_API || "http://127.0.0.1:8080";

  const ACTION_PROFILES = {
    observe: { label: "Observe", trait: "insight", focus: "clue", progress: "understanding" },
    investigate: { label: "Investigate", trait: "insight", focus: "clue", progress: "understanding" },
    empathize: { label: "Empathize", trait: "empathy", focus: "relationship", progress: "connection" },
    persuade: { label: "Persuade", trait: "empathy", focus: "quest", progress: "connection" },
    recall: { label: "Recall", trait: "insight", focus: "open thread", progress: "understanding" },
    confront: { label: "Confront", trait: "resolve", focus: "conflict", progress: "agency" },
    conceal: { label: "Conceal", trait: "resolve", focus: "risk", progress: "agency" },
  };

  const OUTCOMES = {
    critical_revelation: { label: "Critical Revelation", tone: "critical" },
    full_success: { label: "Full Success", tone: "success" },
    success_with_cost: { label: "Success with a Cost", tone: "cost" },
    partial_information: { label: "Partial Information", tone: "partial" },
    obstacle: { label: "Obstacle; the Situation Advances", tone: "failure" },
  };

  let worldState = null;
  let session = null;
  let refs = {};
  let mounted = false;
  let narrationRequest = 0;
  let qqAdapterStatus = null;
  let qqStatusTimer = null;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function list(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === "") return [];
    return [value];
  }

  function textOf(value) {
    if (typeof value === "string") return value.trim();
    if (value && typeof value === "object") {
      return String(value.title || value.name || value.description || JSON.stringify(value));
    }
    return value == null ? "" : String(value);
  }

  function uid(prefix = "event") {
    if (globalScope.crypto?.randomUUID) return `${prefix}-${globalScope.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function now() {
    return new Date().toISOString();
  }

  function bounded(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function randomInt(min, max) {
    const range = max - min + 1;
    if (globalScope.crypto?.getRandomValues) {
      const ceiling = Math.floor(0x100000000 / range) * range;
      const values = new Uint32Array(1);
      do {
        globalScope.crypto.getRandomValues(values);
      } while (values[0] >= ceiling);
      return min + (values[0] % range);
    }
    return min + Math.floor(Math.random() * range);
  }

  function stableTraits(name, characterIndex = 0) {
    const seed = Array.from(name || "character").reduce((sum, char) => sum + char.codePointAt(0), characterIndex + 11);
    return {
      insight: 2 + (seed % 3),
      empathy: 2 + (Math.floor(seed / 3) % 3),
      resolve: 2 + (Math.floor(seed / 7) % 3),
    };
  }

  function normalizeScenes(moduleState) {
    const scenes = [];
    list(moduleState?.acts).forEach((act, actIndex) => {
      const actScenes = list(act?.scenes);
      if (!actScenes.length) {
        actScenes.push({
          title: act?.title || `Act ${actIndex + 1}`,
          objective: act?.dramatic_purpose || act?.opening_state || "Advance the current event",
          beats: list(act?.character_changes),
          discoveries: list(act?.clues_revealed),
          consequences: list(act?.unresolved_threads),
          transition: act?.next_act_hook || act?.closing_state || "Enter the next act",
        });
      }

      actScenes.forEach((scene, sceneIndex) => {
        scenes.push({
          ...clone(scene),
          id: scene?.id || `act-${actIndex + 1}-scene-${sceneIndex + 1}`,
          act_index: actIndex,
          scene_index: sceneIndex,
          act_number: act?.act_number || actIndex + 1,
          act_title: act?.title || `Act ${actIndex + 1}`,
          act_purpose: act?.dramatic_purpose || "",
        });
      });
    });

    if (!scenes.length) {
      list(moduleState?.timeline).forEach((entry, index) => {
        scenes.push({
          id: `timeline-scene-${index + 1}`,
          act_index: index,
          scene_index: 0,
          act_number: index + 1,
        act_title: `Event ${index + 1}`,
        title: textOf(entry) || `Event ${index + 1}`,
        objective: "Investigate and respond to the current event",
          beats: [textOf(entry)],
          discoveries: [],
          participants: [],
          consequences: [],
        });
      });
    }

    if (!scenes.length) {
      scenes.push({
        id: "opening-scene",
        act_index: 0,
        scene_index: 0,
        act_number: 1,
        act_title: "Act 1",
        title: "Where the Story Begins",
        objective: moduleState?.summary || "Explore the current world state",
        beats: [],
        discoveries: list(moduleState?.open_threads),
        participants: list(moduleState?.characters).map((character) => character?.name).filter(Boolean),
        consequences: [],
      });
    }
    return scenes;
  }

  function createSession(moduleState, characterName) {
    if (!moduleState || typeof moduleState !== "object") {
      throw new Error("Generate or import valid World Status JSON first.");
    }
    const characters = list(moduleState.characters);
    const selectedIndex = Math.max(0, characters.findIndex((character) => character?.name === characterName));
    const selected = clone(characters[selectedIndex] || {
      name: characterName || "Unnamed Traveler",
      description: "A person who enters the story and accepts the burden of choice.",
      goals: [],
      secrets: [],
      status: "Ready to enter the scene",
    });
    const scenes = normalizeScenes(moduleState);
    const createdAt = now();
    const initial = {
      schema_version: SESSION_VERSION,
      id: uid("solo"),
      status: "active",
      created_at: createdAt,
      updated_at: createdAt,
      module_summary: moduleState.summary || "Untitled Literary Module",
      module_snapshot: clone(moduleState),
      scenes,
      scene_cursor: 0,
      turn: 0,
      character: {
        ...selected,
        name: selected.name || characterName || "Unnamed Traveler",
        traits: stableTraits(selected.name || characterName || "Unnamed Traveler", selectedIndex),
        stress: 0,
        relationship: 0,
      },
      scene_pressure: 0,
      discovered_clues: [],
      opened_threads: [],
      completed_quests: [],
      quest_progress: {},
      ending_progress: { understanding: 0, connection: 0, agency: 0 },
      ending: null,
      last_result: null,
      runtime_session_id: null,
      runtime_actor_id: null,
      runtime_state_version: null,
      runtime_pairing_code: null,
      runtime_channel_bindings: [],
      runtime_participants: [],
      inspiration_suggestions: [],
      logs: [],
    };
    initial.logs.push({
      id: uid("log"),
      type: "session_start",
      timestamp: createdAt,
      scene_id: scenes[0].id,
      title: "Solo Session Begins",
      narration: `${initial.character.name} enters "${scenes[0].title}."`,
    });
    return initial;
  }

  function currentScene(targetSession) {
    return targetSession?.scenes?.[targetSession.scene_cursor] || null;
  }

  function characterNames(moduleState) {
    return list(moduleState?.characters).map((character) => character?.name).filter(Boolean);
  }

  function sceneTargets(targetSession) {
    const scene = currentScene(targetSession);
    const names = list(scene?.participants).map(textOf).filter(Boolean);
    const characterName = targetSession?.character?.name;
    const fallback = characterNames(targetSession?.module_snapshot);
    return Array.from(new Set([...names, ...fallback])).filter((name) => name !== characterName);
  }

  function cluePool(targetSession) {
    const moduleState = targetSession.module_snapshot || {};
    const scene = currentScene(targetSession) || {};
    const sceneLocation = textOf(scene.location).toLowerCase();
    const locationClues = list(moduleState.locations)
      .filter((location) => !sceneLocation || textOf(location?.name).toLowerCase().includes(sceneLocation) || sceneLocation.includes(textOf(location?.name).toLowerCase()))
      .flatMap((location) => list(location?.clues));
    const itemClues = list(moduleState.items).map((item) => {
      const name = textOf(item?.name);
      const importance = textOf(item?.importance || item?.description);
      return [name, importance].filter(Boolean).join(": ");
    });
    return Array.from(new Set([
      ...list(scene.discoveries).map(textOf),
      ...locationClues.map(textOf),
      ...itemClues.map(textOf),
      ...list(moduleState.open_threads).map(textOf),
      ...list(scene.consequences).map(textOf),
    ].filter(Boolean)));
  }

  function nextClue(targetSession) {
    const known = new Set(targetSession.discovered_clues.map((clue) => clue.text));
    return cluePool(targetSession).find((clue) => !known.has(clue)) || "The scene's silences and anomalies deserve further inquiry";
  }

  function determineOutcome(die, total, difficulty) {
    if (die === 20) return "critical_revelation";
    if (die === 1) return "obstacle";
    const margin = total - difficulty;
    if (margin >= 5) return "full_success";
    if (margin >= 0) return "success_with_cost";
    if (margin >= -4) return "partial_information";
    return "obstacle";
  }

  function localNarration(scene, actor, profile, actionText, target, outcome, effects) {
    const action = actionText || `${profile.label}${target ? ` ${target}` : ""}`;
    const opening = {
      critical_revelation: "A previously obscured detail suddenly comes into full view.",
      full_success: `The scene responds clearly to ${actor}'s action.`,
      success_with_cost: `${actor} gets the desired response, but the atmosphere tightens.`,
      partial_information: "The answer remains incomplete, leaving only a trace to pursue.",
      obstacle: "The action does not unfold as expected, but resistance moves the story elsewhere.",
    }[outcome];
    return `${opening} In "${scene.title}," ${actor} attempts to ${action}. ${effects.join("; ")}.`;
  }

  function resolveAction(sourceSession, input, rollProvider = randomInt) {
    if (!sourceSession || sourceSession.status !== "active") {
      throw new Error("There is no active game session.");
    }
    const next = clone(sourceSession);
    const scene = currentScene(next);
    const profile = ACTION_PROFILES[input.action_type] || ACTION_PROFILES.observe;
    const difficulty = bounded(Number(input.difficulty || 12), 6, 24);
    const die = bounded(Number(rollProvider(1, 20)), 1, 20);
    const traitValue = Number(next.character.traits?.[profile.trait] || 0);
    const relationshipModifier = bounded(Math.trunc(next.character.relationship / 2), -2, 2);
    const pressureModifier = -Math.floor(next.scene_pressure / 3);
    const situationalModifier = profile.focus === "relationship" ? relationshipModifier : 0;
    const modifier = traitValue + situationalModifier + pressureModifier;
    const total = die + modifier;
    const outcome = determineOutcome(die, total, difficulty);
    const clue = nextClue(next);
    const effects = [];
    let progressGain = 0;

    if (["critical_revelation", "full_success", "success_with_cost", "partial_information"].includes(outcome)) {
      const clarity = outcome === "partial_information" ? "uncertain" : outcome === "critical_revelation" ? "critical" : "clear";
      next.discovered_clues.push({
        id: uid("clue"),
        text: clue,
        clarity,
        scene_id: scene.id,
        discovered_at: now(),
      });
      effects.push(`${clarity} clue: ${clue}`);
      progressGain = outcome === "critical_revelation" ? 2 : 1;
    }

    if (profile.focus === "relationship") {
      const relationDelta = outcome === "critical_revelation" || outcome === "full_success" ? 2
        : outcome === "success_with_cost" ? 1
          : outcome === "obstacle" ? -1 : 0;
      const previousRelationship = next.character.relationship;
      next.character.relationship = bounded(previousRelationship + relationDelta, -6, 6);
      const appliedRelationDelta = next.character.relationship - previousRelationship;
      if (appliedRelationDelta) effects.push(`connection ${appliedRelationDelta > 0 ? "+" : ""}${appliedRelationDelta}`);
    }

    if (profile.focus === "quest") {
      const quest = list(next.module_snapshot?.quests)[0];
      if (quest) {
        const questName = textOf(quest.title || quest.objective);
        const gain = ["critical_revelation", "full_success", "success_with_cost"].includes(outcome) ? 1 : 0;
        next.quest_progress[questName] = Number(next.quest_progress[questName] || 0) + gain;
        if (gain) effects.push(`quest progress: ${questName}`);
        if (next.quest_progress[questName] >= 3 && !next.completed_quests.includes(questName)) {
          next.completed_quests.push(questName);
          effects.push(`quest completed: ${questName}`);
        }
      }
    }

    if (profile.focus === "open thread" && !next.opened_threads.includes(clue)) {
      next.opened_threads.push(clue);
      effects.push(`open thread: ${clue}`);
    }

    const pressureDelta = {
      critical_revelation: -1,
      full_success: 0,
      success_with_cost: 1,
      partial_information: 1,
      obstacle: 2,
    }[outcome];
    const previousScenePressure = next.scene_pressure;
    next.scene_pressure = bounded(previousScenePressure + pressureDelta, 0, 9);
    const appliedPressureDelta = next.scene_pressure - previousScenePressure;
    if (appliedPressureDelta) effects.push(`scene pressure ${appliedPressureDelta > 0 ? "+" : ""}${appliedPressureDelta}`);

    const stressDelta = outcome === "obstacle" ? 2 : outcome === "success_with_cost" ? 1 : 0;
    const previousStress = next.character.stress;
    next.character.stress = bounded(previousStress + stressDelta, 0, 9);
    const appliedStressDelta = next.character.stress - previousStress;
    if (appliedStressDelta) effects.push(`stress ${appliedStressDelta > 0 ? "+" : ""}${appliedStressDelta}`);

    next.ending_progress[profile.progress] = Number(next.ending_progress[profile.progress] || 0) + progressGain;
    if (!effects.length) effects.push("The situation changes without producing a definite answer");

    const eventId = uid("turn");
    const narration = localNarration(
      scene,
      next.character.name,
      profile,
      input.action_text,
      input.target,
      outcome,
      effects
    );
    const event = {
      id: eventId,
      type: "action",
      timestamp: now(),
      turn: next.turn + 1,
      scene_id: scene.id,
      scene_title: scene.title,
      actor: next.character.name,
      action_type: input.action_type,
      action_label: profile.label,
      action_text: input.action_text || "",
      target: input.target || "",
      roll: {
        formula: `1d20 + ${profile.trait}${situationalModifier ? " + connection modifier" : ""}${pressureModifier ? " - scene pressure" : ""}`,
        die,
        trait: profile.trait,
        trait_value: traitValue,
        relationship_modifier: situationalModifier,
        pressure_modifier: pressureModifier,
        modifier,
        total,
        difficulty,
      },
      outcome,
      outcome_label: OUTCOMES[outcome].label,
      effects,
      narration,
      narration_source: "local",
    };
    next.turn += 1;
    next.updated_at = event.timestamp;
    next.last_result = clone(event);
    next.logs.push(event);
    return next;
  }

  function runtimeActorId(character) {
    const externalId = String(character?.id || character?.external_id || "");
    const source = externalId.includes(":character:")
      ? externalId.split(":character:").at(-1)
      : externalId || character?.name || "";
    return source
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  async function runtimeRequest(path, options = {}) {
    let response;
    try {
      response = await fetch(`${RUNTIME_API_BASE}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      });
    } catch (error) {
      throw new Error(`The session runtime is unavailable at ${RUNTIME_API_BASE}. Start world-status-server first. (${error.message})`);
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new Error(`The session runtime returned an unreadable response (HTTP ${response.status}).`);
    }
    if (!response.ok || !envelope?.ok) {
      throw new Error(envelope?.error?.message || `Runtime request failed (HTTP ${response.status}).`);
    }
    return envelope.data;
  }

  async function attachRuntimeSession(sourceSession) {
    if (sourceSession?.runtime_session_id && sourceSession?.runtime_actor_id) return sourceSession;
    if (!sourceSession?.module_snapshot) throw new Error("The local session has no module snapshot.");
    const data = await runtimeRequest("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        module: sourceSession.module_snapshot,
        selected_character_id: sourceSession.character?.id
          || sourceSession.character?.external_id
          || sourceSession.character?.name,
        platform: "web",
        channel_id: "local-browser",
        user_id: "local-player",
      }),
    });
    const next = clone(sourceSession);
    next.runtime_session_id = data.session_id;
    next.runtime_actor_id = data.selected_actor_id;
    next.runtime_state_version = data.version;
    next.runtime_pairing_code = data.pairing_code;
    next.runtime_channel_bindings = list(data.channel_bindings);
    next.runtime_participants = list(data.participants);
    next.updated_at = now();
    return next;
  }

  async function refreshRuntimeMetadata() {
    if (!session?.runtime_session_id) return;
    const data = await runtimeRequest(
      `/api/v1/sessions/${encodeURIComponent(session.runtime_session_id)}`
    );
    session.runtime_actor_id = data.selected_actor_id || session.runtime_actor_id;
    session.runtime_state_version = data.version;
    session.runtime_pairing_code = data.pairing_code;
    session.runtime_channel_bindings = list(data.channel_bindings);
    session.runtime_participants = list(data.participants);
    saveSession();
    renderQQPanel();
  }

  async function refreshQQStatus() {
    try {
      qqAdapterStatus = await runtimeRequest("/api/v1/qq/status");
    } catch (error) {
      qqAdapterStatus = { connected: false, error: error.message };
    }
    renderQQPanel();
  }

  async function requestInspirationsThroughRuntime(sourceSession, options = {}) {
    const attached = await attachRuntimeSession(sourceSession);
    const data = await runtimeRequest(
      `/api/v1/sessions/${encodeURIComponent(attached.runtime_session_id)}/inspirations`,
      {
        method: "POST",
        body: JSON.stringify({
          actor_id: attached.runtime_actor_id,
          mode: options.mode || "general",
          target: options.target || "",
          use_ai: options.use_ai !== false,
        }),
      }
    );
    const next = clone(attached);
    next.runtime_state_version = data.state_version;
    next.inspiration_suggestions = list(data.suggestions).slice(0, 3);
    next.updated_at = now();
    return next;
  }

  async function resolveActionThroughRuntime(sourceSession, input) {
    if (!sourceSession || sourceSession.status !== "active") {
      throw new Error("There is no active game session.");
    }
    const attached = await attachRuntimeSession(sourceSession);
    const profile = ACTION_PROFILES[input.action_type] || ACTION_PROFILES.observe;
    const relationshipModifier = bounded(Math.trunc(attached.character.relationship / 2), -2, 2);
    const situationalModifier = profile.focus === "relationship" ? relationshipModifier : 0;
    const pressureModifier = Math.floor(attached.scene_pressure / 3);
    const actorId = attached.runtime_actor_id || runtimeActorId(attached.character);
    if (!actorId) throw new Error("The selected character has no runtime-compatible identity.");

    const authoritative = await runtimeRequest(
      `/api/v1/sessions/${encodeURIComponent(attached.runtime_session_id)}/actions/resolve`,
      {
        method: "POST",
        body: JSON.stringify({
          actor_id: actorId,
          action_type: input.action_type,
          description: input.action_text || `${profile.label}${input.target ? ` ${input.target}` : ""}`,
          target: input.target || "",
          trait: profile.trait,
          trait_value: Number(attached.character.traits?.[profile.trait] || 0),
          situational_modifier: situationalModifier,
          pressure_modifier: pressureModifier,
          difficulty: bounded(Number(input.difficulty || 12), 6, 24),
          ...(Number.isInteger(attached.runtime_state_version)
            ? { expected_state_version: attached.runtime_state_version }
            : {}),
        }),
      }
    );
    const next = resolveAction(attached, input, () => authoritative.roll.die);
    if (next.last_result.outcome !== authoritative.roll.outcome) {
      throw new Error("The browser projection disagrees with the authoritative rules result.");
    }
    next.runtime_state_version = authoritative.new_version;
    next.last_result.formal_event_id = authoritative.event_id;
    next.last_result.rng_seed = authoritative.rng_seed;
    next.last_result.authority = "event_generator";
    next.logs[next.logs.length - 1] = clone(next.last_result);
    return next;
  }

  function endingFor(progress) {
    const entries = Object.entries(progress || {}).sort((a, b) => b[1] - a[1]);
    const [leading, score] = entries[0] || ["understanding", 0];
    const endings = {
      understanding: { title: "A Belated Insight", description: "You do not find a single answer, but you recognize the links among memory, symbol, and silence." },
      connection: { title: "Someone Still Reachable", description: "The story does not erase the distance, but the characters may continue trying to understand one another." },
      agency: { title: "An Altered Aftermath", description: "Your choices change the direction of the event's aftermath, producing a new resonance beyond the source." },
    };
    if (score < 2) return { title: "The Snow Keeps Falling", description: "Many questions remain unresolved, and the world pauses in an open state." };
    return endings[leading];
  }

  function advanceScene(sourceSession) {
    if (!sourceSession || sourceSession.status !== "active") return sourceSession;
    const next = clone(sourceSession);
    const leaving = currentScene(next);
    const timestamp = now();
    if (next.scene_cursor >= next.scenes.length - 1) {
      next.status = "completed";
      next.ending = endingFor(next.ending_progress);
      next.logs.push({
        id: uid("ending"),
        type: "ending",
        timestamp,
        scene_id: leaving?.id,
        title: next.ending.title,
        narration: next.ending.description,
      });
    } else {
      next.scene_cursor += 1;
      next.scene_pressure = Math.max(0, next.scene_pressure - 1);
      const entering = currentScene(next);
      next.logs.push({
        id: uid("scene"),
        type: "scene_change",
        timestamp,
        scene_id: entering.id,
        title: `Enter Act ${entering.act_number} · ${entering.title}`,
        narration: leaving?.transition || entering.objective || "The story enters the next scene.",
      });
    }
    next.updated_at = timestamp;
    next.last_result = null;
    return next;
  }

  function buildNarrationPayload(targetSession, event) {
    const scene = currentScene(targetSession);
    return {
      module_summary: targetSession.module_summary,
      character: {
        name: targetSession.character.name,
        description: targetSession.character.description || "",
        goals: list(targetSession.character.goals),
        status: targetSession.character.status || "",
      },
      scene: {
        title: scene?.title || "",
        location: textOf(scene?.location),
        time: textOf(scene?.time),
        objective: textOf(scene?.objective),
        conflict: textOf(scene?.conflict),
        atmosphere: textOf(targetSession.module_snapshot?.context_variables?.atmosphere),
      },
      action: {
        text: event.action_text || event.action_label,
        target: event.target,
        outcome: event.outcome,
        effects: event.effects,
        roll: event.roll,
      },
      visible_clues: targetSession.discovered_clues.slice(-6),
      recent_narration: targetSession.logs.slice(-3).map((log) => log.narration).filter(Boolean),
    };
  }

  function updateNarration(sourceSession, eventId, narration, suggestedActions = []) {
    const next = clone(sourceSession);
    const event = next.logs.find((entry) => entry.id === eventId);
    if (!event) return sourceSession;
    event.narration = narration;
    event.narration_source = "deepseek";
    event.suggested_actions = list(suggestedActions).map(textOf).filter(Boolean).slice(0, 3);
    if (next.last_result?.id === eventId) next.last_result = clone(event);
    next.updated_at = now();
    return next;
  }

  function exportMarkdown(targetSession) {
    const lines = [
      `# ${targetSession.module_summary} - Solo Session Log`,
      "",
      `- Character: ${targetSession.character.name}`,
      `- Status: ${targetSession.status === "completed" ? "Completed" : "Active"}`,
      `- Created: ${targetSession.created_at}`,
      `- Turns: ${targetSession.turn}`,
      "",
    ];
    targetSession.logs.forEach((entry) => {
      lines.push(`## ${entry.turn ? `Turn ${entry.turn} · ` : ""}${entry.title || entry.scene_title || entry.type}`);
      lines.push("");
      if (entry.actor) lines.push(`**Action:** ${entry.actor} ${entry.action_text || entry.action_label}${entry.target ? ` → ${entry.target}` : ""}`);
      if (entry.roll) lines.push(`**Check:** d20=${entry.roll.die}, modifier=${entry.roll.modifier}, total=${entry.roll.total} / difficulty=${entry.roll.difficulty}`);
      if (entry.outcome_label) lines.push(`**Outcome:** ${entry.outcome_label}`);
      if (entry.effects?.length) lines.push(`**Changes:** ${entry.effects.join("; ")}`);
      if (entry.narration) lines.push("", entry.narration);
      lines.push("");
    });
    return lines.join("\n");
  }

  function saveSession() {
    if (!session || !globalScope.localStorage) return;
    globalScope.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }

  function loadSession() {
    try {
      const raw = globalScope.localStorage?.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed?.schema_version === SESSION_VERSION && parsed?.module_snapshot) return parsed;
    } catch {
      return null;
    }
    return null;
  }

  function removeSession() {
    try {
      globalScope.localStorage?.removeItem(STORAGE_KEY);
    } catch {
      // The in-memory session can still be cleared when browser storage is unavailable.
    }
  }

  function formatDate(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("en", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function setNotice(message, tone = "info") {
    if (!refs.notice) return;
    refs.notice.textContent = message;
    refs.notice.dataset.tone = tone;
    refs.notice.hidden = !message;
  }

  function fillSelect(select, values, placeholder) {
    if (!select) return;
    const previous = select.value;
    select.replaceChildren();
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    select.appendChild(empty);
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    });
    if (values.includes(previous)) select.value = previous;
  }

  function appendTextList(container, values, emptyText) {
    container.replaceChildren();
    const normalized = list(values).map(textOf).filter(Boolean);
    if (!normalized.length) {
      const empty = document.createElement("span");
      empty.className = "game-muted";
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }
    normalized.forEach((value) => {
      const chip = document.createElement("span");
      chip.className = "game-chip";
      chip.textContent = value;
      container.appendChild(chip);
    });
  }

  function renderSetup() {
    const moduleNames = characterNames(worldState);
    const names = worldState && !moduleNames.length ? ["Narrative Observer"] : moduleNames;
    fillSelect(refs.characterSelect, names, names.length ? "Select a player character" : "Waiting for module");
    refs.startButton.disabled = !worldState;
    refs.importInput.disabled = false;
    refs.moduleHint.textContent = worldState
      ? `Current module: ${worldState.summary || "Untitled Module"} · ${normalizeScenes(worldState).length} scenes`
      : "Generate or import World Status JSON before starting a solo session.";
  }

  function renderMeters(targetSession) {
    const meters = [
      ["Understanding", targetSession.ending_progress.understanding, "understanding"],
      ["Connection", targetSession.ending_progress.connection, "connection"],
      ["Agency", targetSession.ending_progress.agency, "agency"],
      ["Scene Pressure", targetSession.scene_pressure, "pressure"],
    ];
    refs.meters.replaceChildren();
    meters.forEach(([label, value, kind]) => {
      const row = document.createElement("div");
      row.className = "game-meter";
      const header = document.createElement("div");
      const name = document.createElement("span");
      name.textContent = label;
      const score = document.createElement("strong");
      score.textContent = String(value);
      header.append(name, score);
      const track = document.createElement("div");
      track.className = "game-meter-track";
      const bar = document.createElement("i");
      bar.dataset.kind = kind;
      bar.style.width = `${bounded(Number(value) / 9 * 100, 0, 100)}%`;
      track.appendChild(bar);
      row.append(header, track);
      refs.meters.appendChild(row);
    });
  }

  function renderResult(result) {
    refs.result.replaceChildren();
    if (!result) {
      const empty = document.createElement("p");
      empty.className = "game-result-empty";
      empty.textContent = "Submit an action to see the roll, ruling, state changes, and narration.";
      refs.result.appendChild(empty);
      return;
    }
    const badge = document.createElement("span");
    badge.className = `game-outcome ${OUTCOMES[result.outcome]?.tone || "partial"}`;
    badge.textContent = result.outcome_label;
    const roll = document.createElement("div");
    roll.className = "game-roll-total";
    roll.innerHTML = `<span>d20 <b>${result.roll.die}</b></span><span>Modifier <b>${result.roll.modifier >= 0 ? "+" : ""}${result.roll.modifier}</b></span><span>Total <b>${result.roll.total}</b></span><span>Difficulty <b>${result.roll.difficulty}</b></span>`;
    const narration = document.createElement("p");
    narration.className = "game-narration";
    narration.textContent = result.narration;
    const source = document.createElement("small");
    source.textContent = result.narration_source === "deepseek" ? "DeepSeek narration · adjudicated by the local rules engine" : "Local narration · AI polish pending or unavailable";
    const effects = document.createElement("div");
    effects.className = "game-effects";
    appendTextList(effects, result.effects, "No state changes");
    refs.result.append(badge, roll, narration, source, effects);
    if (result.suggested_actions?.length) {
      const suggestions = document.createElement("div");
      suggestions.className = "game-suggestions";
      result.suggested_actions.forEach((action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action;
        button.addEventListener("click", () => {
          refs.actionText.value = action;
          refs.actionText.focus();
        });
        suggestions.appendChild(button);
      });
      refs.result.appendChild(suggestions);
    }
  }

  function renderLogs(targetSession) {
    refs.log.replaceChildren();
    targetSession.logs.slice(-12).reverse().forEach((entry) => {
      const article = document.createElement("article");
      article.className = `game-log-entry ${entry.type}`;
      const header = document.createElement("header");
      const title = document.createElement("strong");
      title.textContent = entry.turn ? `Turn ${entry.turn} · ${entry.action_label}` : entry.title || entry.type;
      const time = document.createElement("time");
      time.textContent = formatDate(entry.timestamp);
      header.append(title, time);
      const body = document.createElement("p");
      body.textContent = entry.narration || "";
      article.append(header, body);
      if (entry.roll) {
        const meta = document.createElement("small");
        meta.textContent = `d20 ${entry.roll.die} ${entry.roll.modifier >= 0 ? "+" : ""}${entry.roll.modifier} = ${entry.roll.total} / ${entry.roll.difficulty} · ${entry.outcome_label}`;
        article.appendChild(meta);
      }
      refs.log.appendChild(article);
    });
  }

  function renderInspirations(targetSession) {
    refs.inspirationCards.replaceChildren();
    const suggestions = list(targetSession?.inspiration_suggestions);
    if (!suggestions.length) {
      const empty = document.createElement("p");
      empty.className = "game-muted";
      empty.textContent = "Ideas will appear here and can be adopted into the action form.";
      refs.inspirationCards.appendChild(empty);
      return;
    }
    suggestions.forEach((suggestion) => {
      const card = document.createElement("article");
      card.className = "game-inspiration-card";
      card.dataset.stance = suggestion.stance || "exploratory";
      const label = document.createElement("small");
      label.textContent = `${suggestion.stance || "idea"} · ${suggestion.action_type || "action"}`;
      const copy = document.createElement("p");
      copy.textContent = suggestion.text || "";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Adopt This Action";
      button.addEventListener("click", () => {
        if (ACTION_PROFILES[suggestion.action_type]) refs.actionType.value = suggestion.action_type;
        if (suggestion.target) {
          const options = Array.from(refs.targetSelect.options);
          if (!options.some((option) => option.value === suggestion.target)) {
            const option = document.createElement("option");
            option.value = suggestion.target;
            option.textContent = suggestion.target;
            refs.targetSelect.appendChild(option);
          }
          refs.targetSelect.value = suggestion.target;
        }
        refs.actionText.value = suggestion.text || "";
        refs.actionText.focus();
        setNotice("The idea was copied into the action form. Edit it freely before rolling.", "info");
      });
      card.append(label, copy, button);
      refs.inspirationCards.appendChild(card);
    });
  }

  function renderQQPanel() {
    if (!refs.qqStatus) return;
    const connected = Boolean(qqAdapterStatus?.connected);
    refs.qqStatus.dataset.connected = String(connected);
    refs.qqStatus.textContent = connected
      ? `QQ adapter connected${qqAdapterStatus.bot_id ? ` · bot ${qqAdapterStatus.bot_id}` : ""}.`
      : `QQ adapter offline${qqAdapterStatus?.error ? ` · ${qqAdapterStatus.error}` : "."}`;
    const code = session?.runtime_pairing_code || "------";
    refs.pairingCode.textContent = code;
    refs.copyPairingButton.disabled = code === "------";
    refs.refreshPairingButton.disabled = !session?.runtime_session_id;
    const qqBindings = list(session?.runtime_channel_bindings)
      .filter((binding) => binding?.platform === "qq");
    refs.qqBinding.textContent = qqBindings.length
      ? `Linked QQ chats: ${qqBindings.map((binding) => binding.channel_id).join(", ")}`
      : "No QQ chat is linked.";
  }

  function renderSession() {
    const hasSession = Boolean(session);
    refs.empty.hidden = hasSession;
    refs.workspace.hidden = !hasSession;
    refs.exportButton.disabled = !hasSession;
    refs.exportJsonButton.disabled = !hasSession;
    refs.clearButton.disabled = !hasSession;
    if (!hasSession) return;

    const scene = currentScene(session);
    refs.status.textContent = session.status === "completed"
      ? `Completed · ${session.ending?.title || "Ending"}`
      : `Active · Turn ${session.turn}`;
    refs.actLabel.textContent = session.status === "completed"
      ? "Finale"
      : `Act ${scene.act_number} · Scene ${scene.scene_index + 1}/${session.scenes.filter((item) => item.act_index === scene.act_index).length}`;
    refs.sceneTitle.textContent = session.status === "completed" ? session.ending.title : scene.title || "Untitled Scene";
    refs.sceneMeta.textContent = session.status === "completed"
      ? session.ending.description
      : [textOf(scene.location), textOf(scene.time), scene.act_title].filter(Boolean).join(" · ");
    refs.sceneObjective.textContent = session.status === "completed"
      ? "This solo session has reached an ending. The complete session and log remain exportable."
      : textOf(scene.objective || scene.act_purpose || "Explore and respond to the current situation");
    refs.sceneConflict.textContent = session.status === "completed"
      ? ""
      : textOf(scene.conflict || scene.opening_state || "The scene does not reveal all of its information to the character.");
    appendTextList(refs.participants, scene?.participants, "No participants specified for this scene");
    appendTextList(refs.beats, scene?.beats, "Player actions will create the next beats");
    appendTextList(refs.clues, session.discovered_clues.slice(-8).map((clue) => `${clue.clarity} · ${clue.text}`), "No clues discovered yet");

    refs.characterName.textContent = session.character.name;
    refs.characterDescription.textContent = session.character.description || "A character defined through player choices and actions.";
    refs.characterState.textContent = `Status: ${textOf(session.character.status) || "Normal"} · Stress ${session.character.stress} · Connection ${session.character.relationship >= 0 ? "+" : ""}${session.character.relationship}`;
    refs.traits.replaceChildren();
    [["Insight", "insight"], ["Empathy", "empathy"], ["Resolve", "resolve"]].forEach(([label, key]) => {
      const item = document.createElement("div");
      item.innerHTML = `<span>${label}</span><strong>${session.character.traits[key]}</strong>`;
      refs.traits.appendChild(item);
    });
    renderMeters(session);
    renderResult(session.last_result);
    renderLogs(session);
    renderInspirations(session);
    fillSelect(refs.targetSelect, sceneTargets(session), "Select a target (optional)");

    const disabled = session.status !== "active";
    refs.actionType.disabled = disabled;
    refs.targetSelect.disabled = disabled;
    refs.difficulty.disabled = disabled;
    refs.actionText.disabled = disabled;
    refs.rollButton.disabled = disabled;
    refs.advanceButton.disabled = disabled;
    refs.inspirationMode.disabled = disabled;
    refs.inspirationButton.disabled = disabled;
    refs.advanceButton.textContent = session.scene_cursor >= session.scenes.length - 1 ? "Form an Ending" : "Advance to Next Scene";
  }

  function render() {
    if (!mounted) return;
    renderSetup();
    renderSession();
    renderQQPanel();
  }

  async function requestNarration(eventId) {
    const requestId = ++narrationRequest;
    const event = session?.logs.find((entry) => entry.id === eventId);
    if (!event || !refs.aiToggle.checked) return;
    try {
      const response = await fetch(`${API_BASE}/api/narrate-turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildNarrationPayload(session, event)),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || "AI narration failed");
      if (requestId !== narrationRequest || !session) return;
      session = updateNarration(session, eventId, payload.narration, payload.suggested_actions);
      saveSession();
      renderSession();
      setNotice("AI polished this turn without changing the adjudicated result.", "success");
    } catch (error) {
      setNotice(`The local ruling was saved; AI narration is unavailable: ${error.message}`, "warning");
    }
  }

  async function handleStart() {
    if (!worldState) return;
    const characterName = refs.characterSelect.value;
    if (!characterName) {
      setNotice("Select a player character.", "warning");
      return;
    }
    if (session && !globalScope.confirm("Starting a new game will replace the solo session in this browser. Continue?")) return;
    refs.startButton.disabled = true;
    setNotice("Creating the authoritative session...", "info");
    try {
      session = await attachRuntimeSession(createSession(worldState, characterName));
      saveSession();
      setNotice("The session is ready. Ask for inspiration or declare the first action.", "success");
      render();
    } catch (error) {
      session = null;
      setNotice(error.message, "warning");
      render();
    } finally {
      refs.startButton.disabled = !worldState;
    }
  }

  async function handleInspiration() {
    if (!session || session.status !== "active") return;
    refs.inspirationButton.disabled = true;
    refs.inspirationButton.textContent = "Thinking...";
    try {
      session = await requestInspirationsThroughRuntime(session, {
        mode: refs.inspirationMode.value,
        target: refs.targetSelect.value,
        use_ai: true,
      });
      saveSession();
      renderInspirations(session);
      const source = session.inspiration_suggestions[0]?.source === "deepseek"
        ? "DeepSeek"
        : "the local fallback";
      setNotice(`Three read-only ideas were prepared by ${source}.`, "success");
    } catch (error) {
      setNotice(error.message, "warning");
    } finally {
      refs.inspirationButton.textContent = "Give Me 3 Ideas";
      refs.inspirationButton.disabled = session?.status !== "active";
    }
  }

  async function handleAction(event) {
    event.preventDefault();
    refs.rollButton.disabled = true;
    try {
      session = await resolveActionThroughRuntime(session, {
        action_type: refs.actionType.value,
        target: refs.targetSelect.value,
        difficulty: Number(refs.difficulty.value),
        action_text: refs.actionText.value.trim(),
      });
      const eventId = session.last_result.id;
      saveSession();
      refs.actionText.value = "";
      setNotice("The authoritative ruling is committed and mirrored in the local session log.", "success");
      renderSession();
      requestNarration(eventId);
    } catch (error) {
      setNotice(error.message, "warning");
    } finally {
      refs.rollButton.disabled = false;
    }
  }

  function handleAdvance() {
    session = advanceScene(session);
    saveSession();
    setNotice(session.status === "completed" ? `Ending: ${session.ending.title}` : "Entered the next scene.", "success");
    renderSession();
  }

  async function handleImport(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const imported = payload.session || payload;
      if (imported?.schema_version !== SESSION_VERSION || !imported?.module_snapshot || !Array.isArray(imported?.logs)) {
        throw new Error("The file is not a valid World Status solo session.");
      }
      session = imported;
      session.runtime_session_id = null;
      session.runtime_actor_id = null;
      session.runtime_state_version = null;
      session.inspiration_suggestions = list(session.inspiration_suggestions);
      session.runtime_pairing_code = null;
      session.runtime_channel_bindings = [];
      session.runtime_participants = [];
      saveSession();
      setNotice("The solo session was imported and restored.", "success");
      render();
    } catch (error) {
      setNotice(`Import failed: ${error.message}`, "warning");
    } finally {
      refs.importInput.value = "";
    }
  }

  function mount() {
    if (typeof document === "undefined") return;
    refs = {
      moduleHint: document.querySelector("#gameModuleHint"),
      characterSelect: document.querySelector("#gameCharacterSelect"),
      startButton: document.querySelector("#gameStartButton"),
      importInput: document.querySelector("#gameImportInput"),
      exportButton: document.querySelector("#gameExportLogButton"),
      exportJsonButton: document.querySelector("#gameExportSessionButton"),
      clearButton: document.querySelector("#gameClearButton"),
      notice: document.querySelector("#gameNotice"),
      status: document.querySelector("#gameStatus"),
      empty: document.querySelector("#gameEmpty"),
      workspace: document.querySelector("#gameWorkspace"),
      actLabel: document.querySelector("#gameActLabel"),
      sceneTitle: document.querySelector("#gameSceneTitle"),
      sceneMeta: document.querySelector("#gameSceneMeta"),
      sceneObjective: document.querySelector("#gameSceneObjective"),
      sceneConflict: document.querySelector("#gameSceneConflict"),
      participants: document.querySelector("#gameParticipants"),
      beats: document.querySelector("#gameBeats"),
      clues: document.querySelector("#gameClues"),
      characterName: document.querySelector("#gameCharacterName"),
      characterDescription: document.querySelector("#gameCharacterDescription"),
      characterState: document.querySelector("#gameCharacterState"),
      traits: document.querySelector("#gameTraits"),
      meters: document.querySelector("#gameMeters"),
      actionForm: document.querySelector("#gameActionForm"),
      actionType: document.querySelector("#gameActionType"),
      targetSelect: document.querySelector("#gameTargetSelect"),
      difficulty: document.querySelector("#gameDifficulty"),
      actionText: document.querySelector("#gameActionText"),
      aiToggle: document.querySelector("#gameAiNarration"),
      inspirationMode: document.querySelector("#gameInspirationMode"),
      inspirationButton: document.querySelector("#gameInspirationButton"),
      inspirationCards: document.querySelector("#gameInspirationCards"),
      rollButton: document.querySelector("#gameRollButton"),
      advanceButton: document.querySelector("#gameAdvanceButton"),
      result: document.querySelector("#gameResult"),
      log: document.querySelector("#gameLog"),
      qqStatus: document.querySelector("#gameQQStatus"),
      pairingCode: document.querySelector("#gamePairingCode"),
      copyPairingButton: document.querySelector("#gameCopyPairingButton"),
      refreshPairingButton: document.querySelector("#gameRefreshPairingButton"),
      qqBinding: document.querySelector("#gameQQBinding"),
    };
    if (!refs.startButton) return;
    mounted = true;
    session = loadSession();
    refs.startButton.addEventListener("click", handleStart);
    refs.actionForm.addEventListener("submit", handleAction);
    refs.inspirationButton.addEventListener("click", handleInspiration);
    refs.copyPairingButton.addEventListener("click", async () => {
      const code = session?.runtime_pairing_code;
      if (!code) return;
      try {
        await globalScope.navigator.clipboard.writeText(code);
        setNotice(`Pairing code ${code} copied. Send .ws bind ${code} in QQ.`, "success");
      } catch {
        setNotice(`Pairing code: ${code}`, "info");
      }
    });
    refs.refreshPairingButton.addEventListener("click", async () => {
      if (!session?.runtime_session_id) return;
      refs.refreshPairingButton.disabled = true;
      try {
        const data = await runtimeRequest(
          `/api/v1/sessions/${encodeURIComponent(session.runtime_session_id)}/pairing-code`,
          { method: "POST", body: "{}" }
        );
        session.runtime_pairing_code = data.pairing_code;
        saveSession();
        renderQQPanel();
        setNotice("A new QQ pairing code was created.", "success");
      } catch (error) {
        setNotice(error.message, "warning");
      } finally {
        refs.refreshPairingButton.disabled = !session?.runtime_session_id;
      }
    });
    refs.advanceButton.addEventListener("click", handleAdvance);
    refs.importInput.addEventListener("change", () => handleImport(refs.importInput.files?.[0]));
    refs.exportButton.addEventListener("click", () => download(
      `world-status-log-${session.id}.md`,
      exportMarkdown(session),
      "text/markdown;charset=utf-8"
    ));
    refs.exportJsonButton.addEventListener("click", () => download(
      `world-status-session-${session.id}.json`,
      JSON.stringify(session, null, 2),
      "application/json;charset=utf-8"
    ));
    refs.clearButton.addEventListener("click", () => {
      if (!globalScope.confirm("Clear the current solo session? Export any log you want to keep first.")) return;
      session = null;
      removeSession();
      setNotice("The solo session was cleared; the World Status module remains available.", "info");
      render();
    });
    render();
    refreshQQStatus();
    if (session?.runtime_session_id) refreshRuntimeMetadata().catch(() => {});
    if (qqStatusTimer) globalScope.clearInterval(qqStatusTimer);
    qqStatusTimer = globalScope.setInterval(() => {
      refreshQQStatus();
      if (session?.runtime_session_id) refreshRuntimeMetadata().catch(() => {});
    }, 5000);
  }

  function setWorldState(nextWorldState) {
    worldState = nextWorldState && typeof nextWorldState === "object" ? nextWorldState : null;
    render();
  }

  const api = {
    ACTION_PROFILES,
    OUTCOMES,
    advanceScene,
    buildNarrationPayload,
    createSession,
    attachRuntimeSession,
    currentScene,
    determineOutcome,
    endingFor,
    exportMarkdown,
    mount,
    normalizeScenes,
    requestInspirationsThroughRuntime,
    resolveAction,
    resolveActionThroughRuntime,
    setWorldState,
    updateNarration,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  globalScope.WorldGame = api;
})(typeof window !== "undefined" ? window : globalThis);
