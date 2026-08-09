import { getStore } from "./_vendor/netlify-blobs.mjs";

const STORE_NAME = "world-status-generation-jobs";
const JOB_ID_PATTERN = /^[a-zA-Z0-9-]{20,80}$/;

function jsonResponse(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export default async (request) => {
  const jobId = new URL(request.url).searchParams.get("job_id") || "";
  if (!JOB_ID_PATTERN.test(jobId)) return jsonResponse({ detail: "Invalid job_id." }, 400);

  const jobs = getStore({ name: STORE_NAME, consistency: "strong" });
  if (request.method === "DELETE") {
    await jobs.delete(jobId);
    return new Response(null, { status: 204 });
  }
  if (request.method !== "GET") return jsonResponse({ detail: "Method not allowed." }, 405);

  const job = await jobs.get(jobId, { type: "json", consistency: "strong" });
  if (!job) return jsonResponse({ status: "pending" }, 202);
  if (job.status === "failed") return jsonResponse({ detail: job.error || "Background generation failed." }, 500);
  if (job.status !== "completed") return jsonResponse({ status: job.status || "processing" }, 202);
  return jsonResponse(job);
};

export const config = {
  path: "/api/world-state-result",
};
