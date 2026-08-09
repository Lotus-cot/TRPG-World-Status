const SYSTEM_PROMPT = `You are the narrator of a literary TRPG session.
Narrate only the already-adjudicated action supplied by the application.
Never change dice results, outcome, effects, state, or revealed clues. Never
reveal information absent from the visible context. Return valid JSON only.`;

function buildPrompt(context) {
  return `Write an English player-facing narration for the adjudicated solo TRPG turn below.

Requirements:
- narration must be 80-160 English words, concrete, restrained, and consistent with the literary atmosphere.
- Preserve action.outcome, action.effects, and action.roll exactly; never adjudicate again.
- Use only supplied scenes, characters, and visible_clues. Do not invent established facts.
- Failure must still move the situation through resistance, misunderstanding, cost, or pressure.
- suggested_actions must contain 2-3 short English next-step options.
- Return one JSON object containing narration and suggested_actions only.

Adjudicated turn:
${JSON.stringify(context, null, 2)}`;
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
    return jsonResponse({ detail: "Missing DEEPSEEK_API_KEY." }, 500);
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse({ detail: "Invalid JSON request body." }, 400);
  }

  if (!body?.character || !body?.scene || !body?.action) {
    return jsonResponse({ detail: "character, scene, and action are required." }, 400);
  }

  try {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(body) },
        ],
        temperature: 0.65,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return jsonResponse({ detail: `DeepSeek request failed: ${error}` }, response.status);
    }

    const payload = await response.json();
    const result = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
    const narration = typeof result.narration === "string" ? result.narration.trim() : "";
    if (!narration) {
      return jsonResponse({ detail: "DeepSeek returned an empty narration." }, 502);
    }
    return jsonResponse({
      narration,
      suggested_actions: Array.isArray(result.suggested_actions)
        ? result.suggested_actions.slice(0, 3).map(String)
        : [],
      model: payload.model || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      usage: payload.usage || {},
    });
  } catch (error) {
    return jsonResponse({ detail: error.message || "Turn narration failed." }, 500);
  }
};
