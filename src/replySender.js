import express from "express";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import Queue from "bull";
import fs from "fs";
import path from "path";
import { handleLinkedInLogin } from "./cookie-utils.js";
import simulateNaturalTyping from "./typing-util.js";
import { startPageRecording } from "./screenRecord-util.js";

dotenv.config();

const replyRouter = express.Router();
replyRouter.use(express.json());

const redisOptions = {
  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
  },
};

const replyQueue = new Queue("linkedin-replies", redisOptions);

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function createThreadLink(threadId) {
  return `https://www.linkedin.com/messaging/thread/${threadId}/`;
}

if (!fs.existsSync("recordings")) {
  fs.mkdirSync("recordings");
}

async function sendLinkedInReply(threadId, message) {
  console.log(`Starting reply to thread ${threadId}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;
  let recorder;
  const recordingPath = path.resolve(
    "recordings",
    `reply_thread_${threadId}_${Date.now()}.mp4`
  );

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    recorder = await startPageRecording(page, recordingPath);

    const loginSuccess = await handleLinkedInLogin(
      page,
      process.env.LINKEDIN_EMAIL,
      process.env.LINKEDIN_PASS
    );

    if (!loginSuccess) {
      throw new Error("Failed to login to LinkedIn");
    }

    const threadUrl = createThreadLink(threadId);
    await page.goto(threadUrl);
    await delay(2000);

    await page.waitForSelector(".msg-form__contenteditable", {
      timeout: 15000,
      visible: true,
    });

    const messageInputSelector = ".msg-form__contenteditable";
    await page.click(messageInputSelector);
    await delay(500);

    await simulateNaturalTyping(page, messageInputSelector, message);

    await delay(1000 + Math.random() * 2000);

    const sendButtonSelector = ".msg-form__send-button";
    const sendButton = await page.$(sendButtonSelector);
    if (!sendButton) throw new Error("Send button not found");

    const isDisabled = await page.evaluate((btn) => btn.disabled, sendButton);
    if (isDisabled) throw new Error("Send button is disabled");

    await sendButton.click();

    await delay(2000);

    const inputContent = await page.$eval(messageInputSelector, (el) =>
      el.textContent.trim()
    );
    const messageSent = inputContent === "" || inputContent.length === 0;

    return {
      success: true,
      threadId,
      message: message.substring(0, 100) + (message.length > 100 ? "..." : ""),
      timestamp: new Date().toISOString(),
      messageSent,
      recording: recordingPath,
    };
  } catch (error) {
    console.error("Error sending LinkedIn reply:", error);
    if (page) {
      try {
        const screenshotPath = `reply_error_${threadId}_${Date.now()}.png`;
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch (err) {
        console.error("Screenshot error:", err);
      }
    }
    throw error;
  } finally {
    if (recorder) {
      try {
        await recorder.stop();
      } catch (stopErr) {
        console.error("Error stopping recording:", stopErr);
      }
    }

    if (browser) {
      await browser.close();
    }
  }
}

replyQueue.process(async (job) => {
  const { threadId, message } = job.data;
  return await sendLinkedInReply(threadId, message);
});

replyRouter.post("/send-reply", async (req, res) => {
  const { threadId, message } = req.body;
  if (!threadId || !message) {
    return res.status(400).json({ error: "Missing threadId or message" });
  }

  const job = await replyQueue.add({ threadId, message });
  res.json({ jobId: job.id });
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

export default replyRouter;
