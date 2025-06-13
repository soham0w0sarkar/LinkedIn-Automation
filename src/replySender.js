import express from "express";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { handleLinkedInLogin } from "./cookie-utils.js";
import simulateNaturalTyping from "./typing-util.js";

dotenv.config();

const app = express();
app.use(express.json());

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createThreadLink(threadId) {
  return `https://www.linkedin.com/messaging/thread/${threadId}/`;
}

async function sendLinkedInReply(threadId, message) {
  console.log(`Starting reply to thread ${threadId} `);

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
  const { threadId, message, botId = "default" } = req.body;

  try {
    console.log(`Received reply request for thread: ${threadId}`);

    const result = await sendLinkedInReply(threadId, message, botId);

    res.json({
      success: true,
      data: result,
      message: "Reply sent successfully",
    });
  } catch (error) {
    console.error("API Error:", error);

    const isClientError =
      error.message.includes("not found") ||
      error.message.includes("cookies") ||
      error.message.includes("logged in");

    const statusCode = isClientError ? 400 : 500;

    res.status(statusCode).json({
      success: false,
      error: error.message,
      threadId,
      timestamp: new Date().toISOString(),
      retryable: !isClientError,
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "LinkedIn Reply Bot",
  });
});

app.post("/retry-reply", validateReplyRequest, async (req, res) => {
  const { threadId, message, botId = "default", maxRetries = 3 } = req.body;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `Retry attempt ${attempt}/${maxRetries} for thread: ${threadId}`
      );

      const result = await sendLinkedInReply(threadId, message, botId);

      return res.json({
        success: true,
        data: result,
        message: `Reply sent successfully on attempt ${attempt}`,
        attempts: attempt,
      });
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed:`, error.message);

      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.log(`Waiting ${waitTime}ms before retry...`);
        await delay(waitTime);
      }
    }
  }

  res.status(500).json({
    success: false,
    error: `All ${maxRetries} retry attempts failed`,
    lastError: lastError.message,
    threadId,
    timestamp: new Date().toISOString(),
  });
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
  console.log(`Retry reply: POST http://localhost:${PORT}/retry-reply`);
});
