import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { handleLinkedInLogin } from "./cookie-utils.js";

dotenv.config();

async function randomDelay(min = 1000, max = 4000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanLikeLinkedInBot() {
  console.log("Starting human-like LinkedIn bot...");
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Use shared login logic
    const loginSuccess = await handleLinkedInLogin(
      page,
      process.env.LINKEDIN_EMAIL,
      process.env.LINKEDIN_PASS
    );
    if (!loginSuccess) {
      throw new Error("Login failed");
    }

    // Random actions loop
    const actions = [
      async () => {
        // Scroll feed
        console.log("Scrolling feed...");
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollBy(0, 600));
          await randomDelay();
        }
      },
      async () => {
        console.log("Liking random posts...");
        const likeButtons = await page.$$(
          'button[aria-label*="Like"][aria-pressed="false"]'
        );
        if (likeButtons.length > 0) {
          const idx = Math.floor(Math.random() * likeButtons.length);
          await likeButtons[idx].click();
          console.log("Post liked!");
        }
        await randomDelay();
      },
      async () => {
        console.log("Visiting notifications...");
        await page.click('a[data-test-global-nav-link="notifications"]');
        await page.waitForSelector("div[data-test-notification]");
        await randomDelay(2000, 4000);
        await page.goto("https://www.linkedin.com/feed/");
        await randomDelay();
      },
      async () => {
        console.log("Visiting random profile...");
        const profileLinks = await page.$$(
          'a[href*="/in/"]:not([href*="miniProfile"])'
        );
        if (profileLinks.length > 0) {
          const idx = Math.floor(Math.random() * profileLinks.length);
          const href = await profileLinks[idx].evaluate((el) => el.href);
          await page.goto(href);
          await randomDelay(2000, 5000);
          await page.goto("https://www.linkedin.com/feed/");
        }
        await randomDelay();
      },
    ];

    for (let i = 0; i < 5; i++) {
      const action = actions[Math.floor(Math.random() * actions.length)];
      await action();
    }

    console.log("Bot finished actions!");
  } catch (error) {
    console.error("Error:", error);
    if (page) {
      await page.screenshot({ path: "error_humanlike.png", fullPage: true });
    }
  } finally {
    await browser.close();
  }
}

humanLikeLinkedInBot();
