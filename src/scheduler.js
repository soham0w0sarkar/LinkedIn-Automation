import nodeCron from "node-cron";
import runConnectionChecker from "./checkConnectionRequestStatus.js";
import processLinkedin from "./inboxChecker.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

nodeCron.schedule("*/27 * * * *", async () => {
  const jitterMinutes = Math.floor(Math.random() * 9); // 0–8
  console.log(`🕒 Delaying connection check by ${jitterMinutes} minutes...`);
  await delay(jitterMinutes * 60 * 1000);

  console.log("🔄 Running scheduled connection check...");
  try {
    await runConnectionChecker();
  } catch (error) {
    console.error("❌ Error during scheduled connection check:", error);
  }
});

nodeCron.schedule("*/52 * * * *", async () => {
  const jitterMinutes = Math.floor(Math.random() * 13); // 0–12
  console.log(`🕒 Delaying inbox processing by ${jitterMinutes} minutes...`);
  await delay(jitterMinutes * 60 * 1000);

  console.log("🔄 Running scheduled inbox processing...");
  try {
    await processLinkedin();
  } catch (error) {
    console.error("❌ Error during scheduled inbox processing:", error);
  }
});
