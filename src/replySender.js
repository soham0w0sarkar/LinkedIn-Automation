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
const replyQueue = new Bull("LinkedIn Reply Queue", {
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

function createThreadLink(threadId) {
  return `https://www.linkedin.com/messaging/thread/${threadId}/`;
}

async function sendLinkedInReply(threadId, message) {
  console.log(`Starting reply to thread ${threadId}`);

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

    const threadUrl = createThreadLink(threadId);
    console.log(`Navigating to: ${threadUrl}`);

    await page.goto(threadUrl);
    await delay(2000);

    await page.waitForSelector(".msg-form__contenteditable", {
      timeout: 15000,
      visible: true,
    });

    console.log("✓ Messaging interface loaded");

    const messageInputSelector = ".msg-form__contenteditable";
    await page.waitForSelector(messageInputSelector, { visible: true });
    await page.click(messageInputSelector);
    await delay(500);

    console.log("Starting natural typing simulation...");
    await simulateNaturalTyping(page, messageInputSelector, message);

    await delay(1000 + Math.random() * 2000);

    const sendButtonSelector = ".msg-form__send-button";
    await page.waitForSelector(sendButtonSelector, { visible: true });

    const sendButton = await page.$(sendButtonSelector);
    if (!sendButton) {
      throw new Error("Send button not found");
    }

    const isDisabled = await page.evaluate((btn) => btn.disabled, sendButton);
    if (isDisabled) {
      throw new Error("Send button is disabled - message may be empty");
    }

    await sendButton.click();
    console.log("✓ Send button clicked");

    await delay(2000);

    const inputContent = await page.$eval(messageInputSelector, (el) =>
      el.textContent.trim()
    );
    const messageSent = inputContent === "" || inputContent.length === 0;

    if (!messageSent) {
      console.warn(
        "Warning: Message may not have been sent - input not cleared"
      );
    }

    console.log(`✓ Reply sent successfully to thread ${threadId}`);

    return {
      success: true,
      threadId,
      message: message.substring(0, 100) + (message.length > 100 ? "..." : ""),
      timestamp: new Date().toISOString(),
      messageSent,
    };
  } catch (error) {
    console.error("Error sending LinkedIn reply:", error);

    if (page) {
      try {
        await page.screenshot({
          path: `reply_error_${threadId}_${Date.now()}.png`,
          fullPage: true,
        });
        console.log("Error screenshot saved");
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

replyQueue.process("send-reply", 1, async (job) => {
  const { threadId, message, botId, jobId } = job.data;

  console.log(`Processing reply job ${jobId}: thread ${threadId}`);

  const randomDelay = Math.random() * (60000 - 10000) + 10000;
  console.log(
    `Waiting ${Math.round(randomDelay / 1000)}s before processing...`
  );
  await delay(randomDelay);

  try {
    const result = await sendLinkedInReply(threadId, message, botId);
    console.log(`Reply job ${jobId} completed successfully`);
    return result;
  } catch (error) {
    console.error(`Reply job ${jobId} failed:`, error.message);
    throw error;
  }
});

function validateReplyRequest(req, res, next) {
  const { threadId, message } = req.body;

  const errors = [];

  if (!threadId || typeof threadId !== "string") {
    errors.push("threadId is required and must be a string");
  }

  if (!message || typeof message !== "string") {
    errors.push("message is required and must be a string");
  } else if (message.trim().length === 0) {
    errors.push("message cannot be empty");
  } else if (message.length > 8000) {
    errors.push("message too long (max 8000 characters)");
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

app.post("/send-reply", validateReplyRequest, async (req, res) => {
  const { threadId, message, priority = 0 } = req.body;

  try {
    console.log(`Adding reply to queue for thread: ${threadId}`);

    const jobId = `reply_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    const job = await replyQueue.add(
      "send-reply",
      {
        threadId,
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
      message: "Reply added to queue",
      threadId,
      estimatedDelay: "10s - 1min",
      queuePosition: (await replyQueue.getWaiting()).length,
    });
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      threadId,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get("/job-status/:jobId", async (req, res) => {
  const { jobId } = req.params;

  try {
    const job = await replyQueue.getJob(jobId);

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
    const waiting = await replyQueue.getWaiting();
    const active = await replyQueue.getActive();
    const completed = await replyQueue.getCompleted();
    const failed = await replyQueue.getFailed();

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

app.post("/bulk-replies", async (req, res) => {
  const { replies, defaultBotId = "default" } = req.body;

  if (!Array.isArray(replies) || replies.length === 0) {
    return res.status(400).json({
      success: false,
      error: "replies must be a non-empty array",
    });
  }

  if (replies.length > 50) {
    return res.status(400).json({
      success: false,
      error: "Maximum 50 replies per bulk request",
    });
  }

  try {
    const jobs = [];
    const errors = [];

    for (let i = 0; i < replies.length; i++) {
      const { threadId, message, botId } = replies[i];

      if (!threadId || typeof threadId !== "string") {
        errors.push(`Reply ${i}: threadId is required and must be a string`);
        continue;
      }

      if (
        !message ||
        typeof message !== "string" ||
        message.trim().length === 0
      ) {
        errors.push(
          `Reply ${i}: message is required and must be a non-empty string`
        );
        continue;
      }

      if (message.length > 8000) {
        errors.push(`Reply ${i}: message too long (max 8000 characters)`);
        continue;
      }

      const jobId = `bulk_reply_${Date.now()}_${i}_${Math.random()
        .toString(36)
        .substr(2, 9)}`;

      try {
        const job = await replyQueue.add(
          "send-reply",
          {
            threadId,
            message,
            botId: botId || defaultBotId,
            jobId,
            requestedAt: new Date().toISOString(),
            bulkRequest: true,
          },
          {
            priority: -i,
            jobId,
            delay: i * 15000,
          }
        );

        jobs.push({
          jobId: job.id,
          threadId,
          position: i,
        });
      } catch (error) {
        errors.push(`Reply ${i}: ${error.message}`);
      }
    }

    res.json({
      success: true,
      message: `${jobs.length} replies added to queue`,
      jobs,
      errors,
      totalRequested: replies.length,
      totalQueued: jobs.length,
      estimatedDuration: `${Math.ceil(replies.length * 0.25)} - ${Math.ceil(
        replies.length * 1
      )} minutes`,
    });
  } catch (error) {
    console.error("Bulk reply error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/health", async (req, res) => {
  try {
    const queueHealth = await replyQueue.isReady();

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      service: "LinkedIn Reply Bot",
      queue: queueHealth ? "connected" : "disconnected",
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      service: "LinkedIn Reply Bot",
      error: error.message,
    });
  }
});

app.post("/retry-reply", validateReplyRequest, async (req, res) => {
  const { threadId, message, botId = "default", maxRetries = 3 } = req.body;

  try {
    console.log(
      `Adding high-priority retry reply to queue for thread: ${threadId}`
    );

    const jobId = `retry_reply_${Date.now()}_${Math.random()
      .toString(36)
      .substr(2, 9)}`;

    const job = await replyQueue.add(
      "send-reply",
      {
        threadId,
        message,
        botId,
        jobId,
        requestedAt: new Date().toISOString(),
        isRetry: true,
        maxRetries,
      },
      {
        priority: 10,
        jobId,
        attempts: maxRetries,
      }
    );

    res.json({
      success: true,
      jobId: job.id,
      message: "Retry reply added to queue with high priority",
      threadId,
      maxRetries,
      estimatedDelay: "10s - 1min",
    });
  } catch (error) {
    console.error("Retry API Error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      threadId,
      timestamp: new Date().toISOString(),
    });
  }
});

app.post("/clear-queue", async (req, res) => {
  const { type = "waiting" } = req.body;

  try {
    let cleared = 0;

    switch (type) {
      case "waiting":
        const waitingJobs = await replyQueue.getWaiting();
        for (const job of waitingJobs) {
          await job.remove();
          cleared++;
        }
        break;
      case "failed":
        const failedJobs = await replyQueue.getFailed();
        for (const job of failedJobs) {
          await job.remove();
          cleared++;
        }
        break;
      case "completed":
        const completedJobs = await replyQueue.getCompleted();
        for (const job of completedJobs) {
          await job.remove();
          cleared++;
        }
        break;
      case "all":
        await replyQueue.clean(0, "completed");
        await replyQueue.clean(0, "failed");
        await replyQueue.clean(0, "waiting");
        cleared = "all";
        break;
      default:
        return res.status(400).json({
          success: false,
          error: "Invalid type. Use: waiting, failed, completed, or all",
        });
    }

    res.json({
      success: true,
      message: `Cleared ${cleared} ${type} jobs from queue`,
      type,
      cleared,
    });
  } catch (error) {
    console.error("Clear queue error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing queue...");
  await replyQueue.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, closing queue...");
  await replyQueue.close();
  process.exit(0);
});

app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    success: false,
    error: "Internal server error",
    timestamp: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`LinkedIn Reply Bot API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Send reply: POST http://localhost:${PORT}/send-reply`);
  console.log(`Bulk replies: POST http://localhost:${PORT}/bulk-replies`);
  console.log(`Job status: GET http://localhost:${PORT}/job-status/:jobId`);
  console.log(`Queue stats: GET http://localhost:${PORT}/queue-stats`);
  console.log(`Clear queue: POST http://localhost:${PORT}/clear-queue`);
});
