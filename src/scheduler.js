import nodeCron from "node-cron";
import runConnectionChecker from "./checkConnectionRequestStatus.js";
import processLinkedin from "./inboxChecker.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Lock variables
let isConnectionCheckerRunning = false;
let isInboxProcessingRunning = false;

// nodeCron.schedule("*/1 * * * *", async () => {
//   if (isConnectionCheckerRunning) {
//     console.log("⏳ Connection check already running. Skipping this schedule.");
//     return;
//   }

//   isConnectionCheckerRunning = true;
//   console.log("🔄 Running scheduled connection check...");
//   try {
//     await runConnectionChecker();
//   } catch (error) {
//     console.error("❌ Error during scheduled connection check:", error);
//   } finally {
//     isConnectionCheckerRunning = false;
//   }
// });

// --- Inbox Processor Job ---
nodeCron.schedule("0 */1 * * *", async () => {
  if (isInboxProcessingRunning) {
    console.log("⏳ Inbox processing already running. Skipping this schedule.");
    return;
  }

  isInboxProcessingRunning = true;
  console.log("🔄 Running scheduled inbox processing...");
  try {
    await processLinkedin();
  } catch (error) {
    console.error("❌ Error during scheduled inbox processing:", error);
  } finally {
    isInboxProcessingRunning = false;
  }
});
