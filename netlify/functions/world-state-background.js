import { getStore } from "./_vendor/netlify-blobs.mjs";
import { buildCloudCharacterResolution, buildPrompt, ensureChunkAct, normalizeWorldState } from "./world-state.js";

const STORE_NAME = "world-status-generation-jobs";
const JOB_ID_PATTERN = /^[a-zA-Z0-9-]{20,80}$/;

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export default async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return;
  }

  const jobId = String(body.job_id || "");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!JOB_ID_PATTERN.test(jobId) || !text || text.length > 5000) return;

  const jobs = store();
  await jobs.setJSON(jobId, {
    status: "processing",
    updated_at: new Date().toISOString(),
  });

  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY in Netlify environment variables.");

    const cloudChunked = body.cloud_chunked === true;
    const compactRetry = body.compact_retry === true;
    const chunkIndex = Math.max(1, Number(body.chunk_index) || 1);
    const chunkCount = Math.max(chunkIndex, Number(body.chunk_count) || chunkIndex);
    const characterNames = Array.isArray(body.character_names) ? body.character_names.map(String).filter(Boolean) : [];
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        messages: [
          {
            role: "system",
            content: "Convert English narrative prose into a detailed, playable TRPG world-state JSON object. Keep every key and generated value in English. Return valid JSON only, without Markdown.",
          },
          {
            role: "user",
            content: buildPrompt(text, { cloudChunked, compactRetry, chunkIndex, chunkCount, characterNames }),
          },
        ],
        temperature: cloudChunked ? 0.1 : 0.2,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepSeek request failed (${response.status}): ${await response.text()}`);
    }
    const upstream = await response.json();
    const content = upstream.choices?.[0]?.message?.content || "{}";
    const worldState = normalizeWorldState(JSON.parse(content));
    if (cloudChunked) ensureChunkAct(worldState, chunkIndex);

    await jobs.setJSON(jobId, {
      status: "completed",
      updated_at: new Date().toISOString(),
      result: {
        input_chunks: [text],
        resolved_chunks: [text],
        resolved_text: text,
        character_resolution: buildCloudCharacterResolution(text, characterNames, worldState, chunkIndex),
        world_state: worldState,
        model: upstream.model || process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
        usage: upstream.usage || {},
        cloud_chunked: cloudChunked,
        chunk_index: chunkIndex,
        chunk_count: chunkCount,
      },
    });
  } catch (error) {
    await jobs.setJSON(jobId, {
      status: "failed",
      updated_at: new Date().toISOString(),
      error: error?.message || "Background world-state generation failed.",
    });
  }
};

export const config = {
  background: true,
  path: "/api/world-state-background",
};
