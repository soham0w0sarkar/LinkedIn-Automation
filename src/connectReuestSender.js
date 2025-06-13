import express from "express";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { handleLinkedInLogin } from "./cookie-utils.js";
import simulateNaturalTyping from "./typing-util.js";

dotenv.config();

const app = express();
app.use(express.json());

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

    // Set user agent to appear more legitimate
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Login to LinkedIn using the helper function
    const loginSuccess = await handleLinkedInLogin(
      page,
      process.env.LINKEDIN_EMAIL,
      process.env.LINKEDIN_PASS
    );

    if (!loginSuccess) {
      throw new Error("Failed to login to LinkedIn");
    }

    console.log("✓ Successfully logged in to LinkedIn");

    // Navigate to the target profile
    await page.goto(profileUrl, { waitUntil: "networkidle0", timeout: 30000 });
    await delay(2000);

    // Wait for profile page to load
    await page.waitForSelector("h1", { timeout: 15000 });
    console.log("✓ Profile page loaded");

    // Extract profile name for logging
    const profileName = await page
      .$eval("h1", (el) => el.textContent.trim())
      .catch(() => "Unknown");
    console.log(`Profile: ${profileName}`);

    // Look for Connect button with various possible selectors
    const connectButtonSelectors = [
      'button[aria-label^="Connect"]',
      'button[aria-label^="Invite"]',
      'button:has-text("Connect")',
      'button[data-control-name="connect"]',
      '.pvs-profile-actions button:has-text("Connect")',
      'button[data-ember-action*="connect"]',
    ];

    let connectButton = null;
    let connectButtonSelector = null;

    // Try to find the connect button using different selectors
    for (const selector of connectButtonSelectors) {
      try {
        connectButton = await page.$(selector);
        if (connectButton) {
          connectButtonSelector = selector;
          break;
        }
      } catch (error) {
        // Continue trying other selectors
      }
    }

    if (!connectButton) {
      // Check if already connected
      const followButton = await page.$('button[aria-label^="Follow"]');
      const messageButton = await page.$('button[aria-label^="Message"]');
      const pendingButton = await page.$('button[aria-label^="Pending"]');

      if (messageButton) {
        throw new Error("Already connected - Message button found");
      } else if (pendingButton) {
        throw new Error("Connection request already pending");
      } else if (followButton) {
        throw new Error(
          "Cannot connect - only Follow option available (likely not 1st/2nd degree connection)"
        );
      } else {
        throw new Error(
          "Connect button not found - profile may not be available for connection"
        );
      }
    }

    console.log(
      `✓ Found Connect button using selector: ${connectButtonSelector}`
    );

    // Click the Connect button
    await connectButton.click();
    console.log("✓ Clicked Connect button");

    // Wait for modal to appear
    await delay(1500);

    // Look for "Add a note" button or text area
    let addNoteButton = null;
    let noteTextArea = null;

    try {
      // Try to find "Add a note" button first
      const addNoteSelectors = [
        'button[aria-label^="Add a note"]',
        'button:has-text("Add a note")',
        'button[data-control-name="add_note"]',
        ".send-invite__add-note-button",
      ];

      for (const selector of addNoteSelectors) {
        try {
          addNoteButton = await page.$(selector);
          if (addNoteButton) break;
        } catch (error) {
          // Continue trying
        }
      }

      if (addNoteButton) {
        console.log("✓ Found 'Add a note' button");
        await addNoteButton.click();
        await delay(1000);
      }

      // Look for note text area
      const noteTextAreaSelectors = [
        'textarea[name="message"]',
        'textarea[aria-label^="Add a note"]',
        ".send-invite__custom-message textarea",
        'textarea[data-control-name="custom_message"]',
        'textarea[placeholder*="note"]',
      ];

      for (const selector of noteTextAreaSelectors) {
        try {
          noteTextArea = await page.$(selector);
          if (noteTextArea) break;
        } catch (error) {
          // Continue trying
        }
      }

      if (!noteTextArea) {
        console.log("No note text area found - sending without custom message");
      }
    } catch (error) {
      console.log(
        "Could not find note options - proceeding with default connection request"
      );
    }

    // If we have a text area and a message, type the custom message
    if (noteTextArea && message && message.trim().length > 0) {
      console.log("✓ Found note text area - adding custom message");
      await noteTextArea.click();
      await delay(500);

      // Type the custom message naturally
      await simulateNaturalTyping(
        page,
        'textarea[name="message"], textarea[aria-label^="Add a note"], .send-invite__custom-message textarea, textarea[data-control-name="custom_message"], textarea[placeholder*="note"]',
        message
      );
      console.log("✓ Custom message typed");
    }

    // Wait before sending
    await delay(1000 + Math.random() * 2000);

    // Look for Send button
    const sendButtonSelectors = [
      'button[aria-label^="Send"]',
      'button[data-control-name="send"]',
      'button:has-text("Send")',
      '.send-invite__actions button[type="submit"]',
      'button[data-ember-action*="send"]',
    ];

    let sendButton = null;
    for (const selector of sendButtonSelectors) {
      try {
        sendButton = await page.$(selector);
        if (sendButton) break;
      } catch (error) {
        // Continue trying
      }
    }

    if (!sendButton) {
      throw new Error("Send button not found in connection modal");
    }

    // Check if send button is enabled
    const isDisabled = await page.evaluate((btn) => btn.disabled, sendButton);
    if (isDisabled) {
      throw new Error("Send button is disabled");
    }

    // Click Send button
    await sendButton.click();
    console.log("✓ Clicked Send button");

    // Wait for the modal to close and check for success
    await delay(3000);

    // Check if modal closed (indicating success) or if there's an error
    const modalStillOpen = (await page.$(".send-invite")) !== null;

    // Check for success indicators
    const successIndicators = [
      ".artdeco-toast-message--success",
      ".artdeco-toast-item--success",
      'div[data-test-artdeco-toast-message-type="success"]',
    ];

    let successFound = false;
    for (const selector of successIndicators) {
      try {
        const successElement = await page.$(selector);
        if (successElement) {
          successFound = true;
          break;
        }
      } catch (error) {
        // Continue checking
      }
    }

    // Check for error indicators
    const errorIndicators = [
      ".artdeco-toast-message--error",
      ".artdeco-toast-item--error",
      'div[data-test-artdeco-toast-message-type="error"]',
      ".send-invite__error-message",
    ];

    let errorFound = false;
    let errorMessage = "";
    for (const selector of errorIndicators) {
      try {
        const errorElement = await page.$(selector);
        if (errorElement) {
          errorFound = true;
          errorMessage = await page.evaluate(
            (el) => el.textContent.trim(),
            errorElement
          );
          break;
        }
      } catch (error) {
        // Continue checking
      }
    }

    if (errorFound) {
      throw new Error(
        `LinkedIn error: ${errorMessage || "Connection request failed"}`
      );
    }

    console.log(`✓ Connection request sent successfully to ${profileName}`);

    return {
      success: true,
      profileUrl,
      profileName,
      message: message
        ? message.substring(0, 100) + (message.length > 100 ? "..." : "")
        : "No custom message",
      timestamp: new Date().toISOString(),
      hasCustomMessage: !!(message && message.trim().length > 0),
    };
  } catch (error) {
    console.error("Error sending LinkedIn connection request:", error);

    // Take screenshot for debugging
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

// Input validation middleware
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

// API endpoint to send connection request
app.post("/send-connect-request", validateConnectRequest, async (req, res) => {
  const { profileUrl, message } = req.body;

  try {
    console.log(`Received connection request for profile: ${profileUrl}`);

    const result = await sendLinkedInConnectionRequest(profileUrl, message);

    res.json({
      success: true,
      data: result,
      message: "Connection request sent successfully",
    });
  } catch (error) {
    console.error("API Error:", error);

    // Determine error type for appropriate status code
    const isClientError =
      error.message.includes("Already connected") ||
      error.message.includes("already pending") ||
      error.message.includes("not available for connection") ||
      error.message.includes("only Follow option") ||
      error.message.includes("not found") ||
      error.message.includes("login");

    const statusCode = isClientError ? 400 : 500;

    res.status(statusCode).json({
      success: false,
      error: error.message,
      profileUrl,
      timestamp: new Date().toISOString(),
      retryable: !isClientError,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "LinkedIn Connect Request Bot",
  });
});

// Retry endpoint for failed connection requests
app.post("/retry-connect-request", validateConnectRequest, async (req, res) => {
  const { profileUrl, message, maxRetries = 3 } = req.body;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `Retry attempt ${attempt}/${maxRetries} for profile: ${profileUrl}`
      );

      const result = await sendLinkedInConnectionRequest(profileUrl, message);

      return res.json({
        success: true,
        data: result,
        message: `Connection request sent successfully on attempt ${attempt}`,
        attempts: attempt,
      });
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt} failed:`, error.message);

      // Don't retry if it's a client error (already connected, etc.)
      if (
        error.message.includes("Already connected") ||
        error.message.includes("already pending") ||
        error.message.includes("only Follow option")
      ) {
        break;
      }

      if (attempt < maxRetries) {
        const waitTime = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        console.log(`Waiting ${waitTime}ms before retry...`);
        await delay(waitTime);
      }
    }
  }

  // All retries failed
  res.status(500).json({
    success: false,
    error: `All ${maxRetries} retry attempts failed`,
    lastError: lastError.message,
    profileUrl,
    timestamp: new Date().toISOString(),
  });
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
    `Retry connect request: POST http://localhost:${PORT}/retry-connect-request`
  );
});
