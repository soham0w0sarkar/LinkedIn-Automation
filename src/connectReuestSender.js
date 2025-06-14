import express from "express";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import Bull from "bull";
import { handleLinkedInLogin } from "./cookie-utils.js";
import simulateNaturalTyping from "./typing-util.js";

dotenv.config();

const app = express();
app.use(express.json());

// Create job queue
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

async function sendLinkedInConnectionRequest(profileUrl, message) {
  console.log(`Starting connection request to: ${profileUrl}`);

  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const loginSuccess = await handleLinkedInLogin(
      page,
      process.env.LINKEDIN_EMAIL,
      process.env.LINKEDIN_PASS
    );

    if (!loginSuccess) {
      throw new Error("Failed to login to LinkedIn");
    }

    console.log("✓ Successfully logged in to LinkedIn");

    await page.goto(profileUrl);
    await delay(2000);

    await page.waitForSelector("h1", { timeout: 15000 });
    console.log("✓ Profile page loaded");

    const followSpan = await page.$('span ::-p-text("Follow")');
    if (followSpan) {
      const moreButton = await page.$('button[aria-label="More actions"]');
      console.log("✓ Follow button found, clicking More actions");
      if (moreButton) {
        await moreButton.click();
        console.log("✓ More actions button clicked");
        await delay(30000);
      }
    }

    const connectSpan = await page.$('span ::-p-text("Connect")');
    if (!connectSpan) {
      throw new Error(
        "Connect button not found - user may already be connected or profile not accessible"
      );
    }

    const clicked = await page.evaluate((el) => {
      const button = el.closest("button");
      if (button) {
        button.click();
        return true;
      }
      return false;
    }, connectSpan);

    if (!clicked) {
      throw new Error("Failed to click Connect button");
    }

    await delay(2000);

    const addNoteButton = await page.waitForSelector(
      'button[aria-label="Add a note"]',
      { timeout: 10000, visible: true }
    );

    if (addNoteButton) {
      await addNoteButton.click();
      console.log("✓ Add note button clicked");
      await delay(1000);

      const messageInputSelector = "textarea#custom-message";
      await simulateNaturalTyping(
        page,
        messageInputSelector,
        message || "Hi, I'd like to connect with you!"
      );

      console.log("✓ Typed connection message naturally");

      const sendButton = await page.waitForSelector(
        'button[aria-label="Send invitation"]',
        { visible: true, timeout: 10000 }
      );

      if (sendButton) {
        const isDisabled = await page.evaluate(
          (btn) => btn.disabled,
          sendButton
        );
        if (isDisabled) {
          throw new Error("Send button is disabled - message may be empty");
        }
        await sendButton.click();
        console.log("✓ Send button clicked");
        await delay(2000); // Wait for request to process
      }
    } else {
      // Try to send without note
      const sendButton = await page.waitForSelector(
        'button[aria-label="Send invitation"]',
        { visible: true, timeout: 10000 }
      );

      if (sendButton) {
        await sendButton.click();
        console.log("✓ Send button clicked (without note)");
        await delay(2000);
      }
    }

    return {
      success: true,
      profileUrl,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Error sending LinkedIn connection request:", error);

    if (page) {
      try {
        const timestamp = Date.now();
        await page.screenshot({
          path: `connect_error_${timestamp}.png`,
          fullPage: true,
        });
        console.log(`Error screenshot saved: connect_error_${timestamp}.png`);
      } catch (screenshotError) {
        console.error("Failed to take error screenshot:", screenshotError);
      }
    }

    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

connectionQueue.process("send-connection", 1, async (job) => {
  const { profileUrl, message, jobId } = job.data;

  console.log(`Processing job ${jobId}: ${profileUrl}`);

  const randomDelay = Math.random() * (120000 - 30000) + 30000;
  console.log(
    `Waiting ${Math.round(randomDelay / 1000)}s before processing...`
  );
  await delay(randomDelay);

  try {
    const result = await sendLinkedInConnectionRequest(profileUrl, message);
    console.log(`Job ${jobId} completed successfully`);
    return result;
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error.message);
    throw error;
  }
});

function validateConnectRequest(req, res, next) {
  const { profileUrl, message } = req.body;

  const errors = [];

  if (!profileUrl || typeof profileUrl !== "string") {
    errors.push("profileUrl is required and must be a string");
  } else if (!profileUrl.includes("linkedin.com/in/")) {
    errors.push("profileUrl must be a valid LinkedIn profile URL");
  }

  if (message && typeof message !== "string") {
    errors.push("message must be a string if provided");
  } else if (message && message.length > 300) {
    errors.push("message too long (max 300 characters for LinkedIn notes)");
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: errors,
    });
  }

  next();
}

app.post("/send-connect-request", validateConnectRequest, async (req, res) => {
  const { profileUrl, message, priority = 0 } = req.body;

  try {
    console.log(`Adding connection request to queue: ${profileUrl}`);

    const jobId = `connect_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    const job = await connectionQueue.add(
      "send-connection",
      {
        profileUrl,
        message,
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
      message: "Connection request added to queue",
      profileUrl,
      estimatedDelay: "30s - 2min",
      queuePosition: await connectionQueue.getWaitingCount(),
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      profileUrl,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/job-status/:jobId", async (req, res) => {
  const { jobId } = req.params;

  try {
    const job = await connectionQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
        jobId,
      });
    }

    const state = await job.getState();
    const progress = job.progress();

    res.json({
      success: true,
      jobId,
      state,
      progress,
      data: job.data,
      createdAt: new Date(job.timestamp).toISOString(),
      processedAt: job.processedOn
        ? new Date(job.processedOn).toISOString()
        : null,
      finishedAt: job.finishedOn
        ? new Date(job.finishedOn).toISOString()
        : null,
      failedReason: job.failedReason,
      returnValue: job.returnvalue,
    });
  } catch (error) {
    console.error("Error getting job status:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      jobId,
    });
  }
});

app.get("/queue-stats", async (req, res) => {
  try {
    const waiting = await connectionQueue.getWaiting();
    const active = await connectionQueue.getActive();
    const completed = await connectionQueue.getCompleted();
    const failed = await connectionQueue.getFailed();

    res.json({
      success: true,
      stats: {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        total:
          waiting.length + active.length + completed.length + failed.length,
      },
    });
  } catch (error) {
    console.error("Error getting queue stats:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Bulk add connections endpoint
app.post("/bulk-connect-requests", async (req, res) => {
  const { connections, defaultMessage } = req.body;

  if (!Array.isArray(connections) || connections.length === 0) {
    return res.status(400).json({
      success: false,
      error: "connections must be a non-empty array",
    });
  }

  if (connections.length > 100) {
    return res.status(400).json({
      success: false,
      error: "Maximum 100 connections per bulk request",
    });
  }

  try {
    const jobs = [];
    const errors = [];

    for (let i = 0; i < connections.length; i++) {
      const { profileUrl, message } = connections[i];

      // Validate each connection
      if (!profileUrl || !profileUrl.includes("linkedin.com/in/")) {
        errors.push(`Connection ${i}: Invalid profile URL`);
        continue;
      }

      const jobId = `bulk_connect_${Date.now()}_${i}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;

      try {
        const job = await connectionQueue.add(
          "send-connection",
          {
            profileUrl,
            message: message || defaultMessage,
            jobId,
            requestedAt: new Date().toISOString(),
            bulkRequest: true,
          },
          {
            priority: -i, // Lower priority for later items
            jobId,
            delay: i * 30000, // Stagger by 30 seconds each
          }
        );

        jobs.push({
          jobId: job.id,
          profileUrl,
          position: i,
        });
      } catch (error) {
        errors.push(`Connection ${i}: ${error.message}`);
      }
    }

    res.json({
      success: true,
      message: `${jobs.length} connection requests added to queue`,
      jobs,
      errors,
      totalRequested: connections.length,
      totalQueued: jobs.length,
      estimatedDuration: `${Math.ceil(connections.length * 0.5)} - ${Math.ceil(
        connections.length * 2
      )} minutes`,
    });
  } catch (error) {
    console.error("Bulk request error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Health check endpoint
app.get("/health", async (req, res) => {
  try {
    const queueHealth = await connectionQueue.isReady();

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      service: "LinkedIn Connect Request Bot",
      queue: queueHealth ? "connected" : "disconnected",
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      service: "LinkedIn Connect Request Bot",
      error: error.message,
    });
  }
});

// Graceful shutdown
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

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    timestamp: new Date().toISOString(),
  });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`LinkedIn Connect Request Bot API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(
    `Send connect request: POST http://localhost:${PORT}/send-connect-request`
  );
  console.log(
    `Bulk connect requests: POST http://localhost:${PORT}/bulk-connect-requests`
  );
  console.log(`Job status: GET http://localhost:${PORT}/job-status/:jobId`);
  console.log(`Queue stats: GET http://localhost:${PORT}/queue-stats`);
});
