export const handler = async () => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    status: "ok",
    deployment: "netlify",
    language: "en",
    character_pipeline: {
      relik: { enabled: false, installed: false, model: "cloud alias fallback" },
      deepseek_validation: { configured: false, model: "handled only inside cloud chunk generation" },
      maverick: { enabled: false, installed: false, model: "not available in Netlify", device: "none" },
    },
  }),
});
