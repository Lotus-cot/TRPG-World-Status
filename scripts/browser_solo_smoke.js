const { chromium } = require("playwright");

const baseUrl = process.argv[2] || "http://127.0.0.1:8765";
const screenshotPath = process.argv[3] || "tmp/solo-game-smoke.png";

const fixture = {
  summary: "Browser Closed-Loop Test Module",
  characters: [
    { name: "Aya", description: "A cautious literary observer", goals: ["Understand the old song"], status: "Calm" },
    { name: "Lin", description: "Listens silently to the old song", goals: [], status: "Hesitant" },
  ],
  acts: [{
    act_number: 1,
    title: "The Old Song and the Snow",
    dramatic_purpose: "Bring memory into the current scene",
    scenes: [
      {
        title: "The Old Song on the Stairs",
        location: "The old house entrance hall",
        time: "Late at night",
        participants: ["Aya", "Lin"],
        objective: "Understand the reason for Lin's silence",
        beats: ["A song sounds in the distance", "Lin stops walking"],
        conflict: "A direct question may damage fragile trust",
        discoveries: ["The old song is connected to Lin's past"],
        transition: "They walk into the snowy night",
      },
      {
        title: "A Conversation in the Snow",
        location: "Riverbank",
        time: "After midnight",
        participants: ["Aya", "Lin"],
        objective: "Decide whether to continue asking",
        beats: ["Snow covers the distant lights"],
        discoveries: ["The past has more than one version"],
      },
    ],
  }],
  items: [{ name: "The old song", importance: "Recalls an unspoken memory" }],
  quests: [{ title: "Understand the Old Song", objective: "Determine the song's meaning" }],
  open_threads: ["Who else remembers that snow?"],
  context_variables: { atmosphere: "Restrained and cold", scene_state: "The gathering is ending" },
};

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate((worldState) => window.WorldGame.setWorldState(worldState), fixture);
  await page.selectOption("#gameCharacterSelect", "Aya");
  await page.click("#gameStartButton");
  await page.uncheck("#gameAiNarration");
  await page.fill("#gameActionText", "Watch Lin's reaction to the old song");
  await page.selectOption("#gameActionType", "observe");
  await page.selectOption("#gameTargetSelect", "Lin");
  await page.selectOption("#gameDifficulty", "10");
  await page.click("#gameRollButton");
  await page.waitForSelector(".game-outcome");

  const afterRoll = await page.evaluate(() => JSON.parse(localStorage.getItem("trpg-world-status:solo-session:v1")));
  if (afterRoll.turn !== 1 || afterRoll.logs.at(-1).type !== "action") {
    throw new Error("Action did not persist as a structured turn event.");
  }

  await page.click("#gameAdvanceButton");
  await page.waitForFunction(() => document.querySelector("#gameSceneTitle")?.textContent === "A Conversation in the Snow");
  await page.fill("#gameActionText", "Ask with empathy whether she wants to continue");
  await page.selectOption("#gameActionType", "empathize");
  await page.click("#gameRollButton");
  await page.click("#gameAdvanceButton");
  await page.waitForFunction(() => document.querySelector("#gameStatus")?.textContent.includes("Completed"));

  const finalSession = await page.evaluate(() => JSON.parse(localStorage.getItem("trpg-world-status:solo-session:v1")));
  if (finalSession.status !== "completed" || !finalSession.ending || finalSession.logs.at(-1).type !== "ending") {
    throw new Error("The session did not reach and persist an ending.");
  }

  await page.locator("#soloGamePanel").screenshot({ path: screenshotPath });
  await browser.close();
  if (errors.length) throw new Error(`Browser errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({
    status: finalSession.status,
    turns: finalSession.turn,
    ending: finalSession.ending.title,
    logs: finalSession.logs.length,
    screenshot: screenshotPath,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
