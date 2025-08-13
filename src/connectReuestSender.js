import express from "express";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import Bull from "bull";
import { handleLinkedInLogin } from "./cookie-utils.js";
import { startPageRecording } from "./screenRecord-util.js";

dotenv.config();

const connectRouter = express.Router();
connectRouter.use(express.json());

const connectionQueue = new Bull("LinkedIn Connection Queue", {
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: process.env.REDIS_PORT || 6379,
  },
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 50,
    attempts: 0,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendLinkedInConnectionRequest(profileUrl) {
  console.log(`Starting connection request to: ${profileUrl}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;
  let recorder;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const outputPath = `./recordings/connection_sender_${Date.now()}.mp4`;

    recorder = await startPageRecording(page, outputPath, {
      followNewTab: true,
      fps: 25,
      videoFrame: {
        width: 1280,
        height: 800,
      },
    });

    const loginSuccess = await handleLinkedInLogin(
      page,
      process.env.LINKEDIN_EMAIL,
      process.env.LINKEDIN_PASS
    );

    if (!loginSuccess) throw new Error("Failed to login to LinkedIn");
    console.log("✓ Logged in to LinkedIn");

    await page.goto(profileUrl);
    await delay(2000);

    await page.waitForSelector("h1", { timeout: 15000 });
    console.log("✓ Profile page loaded");

    const followSpan = await page.$('span ::-p-text("Follow")');
    const followButton = followSpan
      ? await page.evaluate((el) => el.closest("button") !== null, followSpan)
      : false;

    let followButtonExists = false;
    if (followSpan && followButton) {
      followButtonExists = true;
      const moreButtons = await page.$$('button[aria-label="More actions"]');
      console.log("✓ Found Follow - clicking More actions");
      if (moreButtons.length > 1) {
        await moreButtons[1].click();
        await delay(30000);
      }
    }

    const connectSpan = await page.$('span ::-p-text("Connect")');
    if (!connectSpan) throw new Error("Connect button not found");

    const clicked = followButtonExists
      ? await page.evaluate((el) => {
          const btn = el.closest("div");
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        }, connectSpan)
      : await page.evaluate((el) => {
          const btn = el.closest("button");
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        }, connectSpan);

    if (!clicked) throw new Error("Could not click Connect");

    await delay(2000);

    const sendButton = await page.waitForSelector(
      'button[aria-label="Send without a note"]',
      { timeout: 10000, visible: true }
    );
    if (sendButton) {
      await sendButton.click();
      console.log("✓ Connection request sent");
      await delay(2000);
    }

    return {
      success: true,
      profileUrl,
      timestamp: new Date().toISOString(),
      recordingPath: outputPath,
    };
  } catch (error) {
    console.error("Connection request error:", error);

    if (page) {
      try {
        const timestamp = Date.now();
        await page.screenshot({
          path: `connect_error_${timestamp}.png`,
          fullPage: true,
        });
        console.log(`📸 Screenshot saved: connect_error_${timestamp}.png`);
      } catch (err) {
        console.error("Failed to save screenshot:", err);
      }
    }

    throw error;
  } finally {
    if (recorder) {
      try {
        await recorder.stop();
        console.log("🛑 Recording stopped");
      } catch (err) {
        console.error("Error stopping recorder:", err);
      }
    }
    if (browser) await browser.close();
  }
}

connectionQueue.process("send-connection", 1, async (job) => {
  const { profileUrl, jobId } = job.data;
  console.log(`📦 Processing job ${jobId}: ${profileUrl}`);

  const randomDelay = Math.random() * 10000 + 15000;
  console.log(`⏳ Waiting ${Math.round(randomDelay / 1000)}s...`);
  await delay(randomDelay);

  try {
    const result = await sendLinkedInConnectionRequest(profileUrl);
    console.log(`✅ Job ${jobId} done`);
    return result;
  } catch (error) {
    console.error(`❌ Job ${jobId} failed:`, error.message);
    throw error;
  }
});

function validateConnectRequest(req, res, next) {
  const { profileUrl } = req.body;
  const errors = [];

  if (!profileUrl || typeof profileUrl !== "string") {
    errors.push("profileUrl must be a non-empty string");
  } else if (!profileUrl.includes("linkedin.com/in/")) {
    errors.push("Invalid LinkedIn profile URL");
  }

  if (errors.length > 0) {
    return res
      .status(400)
      .json({ success: false, error: "Validation failed", details: errors });
  }

  next();
}

connectRouter.post(
  "/send-connect-request",
  validateConnectRequest,
  async (req, res) => {
    const { profileUrl, priority = 0 } = req.body;

    try {
      const jobId = `connect_${Date.now()}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;
      const job = await connectionQueue.add(
        "send-connection",
        {
          profileUrl,
          jobId,
          requestedAt: new Date().toISOString(),
        },
        {
          priority,
          jobId,
        }
      );

      res.json({
        success: true,
        jobId: job.id,
        profileUrl,
        message: "Connection job queued",
        queuePosition: await connectionQueue.getWaitingCount(),
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message,
        profileUrl,
      });
    }
  }
);

connectRouter.post("/send-bulk-connect-requests", async (req, res) => {
  const { connections = [], priority = 0 } = req.body;

  if (!Array.isArray(connections) || connections.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Request body must include a non-empty 'connections' array",
    });
  }

  const queuedJobs = [];
  const skippedProfiles = [];

  for (const item of connections) {
    const profileUrl = item.profileUrl;

    if (
      !profileUrl ||
      typeof profileUrl !== "string" ||
      !profileUrl.includes("linkedin.com/in/")
    ) {
      skippedProfiles.push(profileUrl);
      continue;
    }

    const jobId = `connect_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    const job = await connectionQueue.add(
      "send-connection",
      {
        profileUrl,
        jobId,
        requestedAt: new Date().toISOString(),
      },
      {
        priority,
        jobId,
      }
    );

    queuedJobs.push({
      profileUrl,
      jobId: job.id,
    });
  }

  res.json({
    success: true,
    message: "Bulk connection jobs queued",
    totalQueued: queuedJobs.length,
    totalSkipped: skippedProfiles.length,
    jobs: queuedJobs,
    skipped: skippedProfiles,
  });
});


process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing queue...");
  await connectionQueue.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, closing queue...");
  await connectionQueue.close();
  process.exit(0);
});

export default connectRouter;
