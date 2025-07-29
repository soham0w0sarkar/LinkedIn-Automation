import puppeteer from "puppeteer";
import dotenv from "dotenv";
import fs from "fs/promises";

dotenv.config();

async function randomDelay(min = 1000, max = 4000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanLikeLinkedInBot() {
  console.log("Starting human-like LinkedIn bot...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    let loggedIn = false;
    try {
      const cookiesString = await fs.readFile("cookies.json", "utf8");
      const cookies = JSON.parse(cookiesString);
      await page.setCookie(...cookies);
      await page.goto("https://www.linkedin.com/feed/");
      await randomDelay();
      if (await page.$('[aria-label="Search"]')) {
        loggedIn = true;
        console.log("Logged in using cookies");
      }
    } catch {
      console.log("No valid cookies found, logging in manually...");
    }

    // Manual login if cookies failed
    if (!loggedIn) {
      await page.goto("https://www.linkedin.com/login");
      await randomDelay();
      await page.type("#username", process.env.LINKEDIN_EMAIL);
      await page.type("#password", process.env.LINKEDIN_PASS);
      await page.click('button[type="submit"]');
      await randomDelay(5000, 8000);
      if (!page.url().includes("feed")) throw new Error("Login failed");
      const cookies = await page.cookies();
      await fs.writeFile("cookies.json", JSON.stringify(cookies, null, 2));
      console.log("Logged in and cookies saved");
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
        // Like random posts
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
        // Visit notifications
        console.log("Visiting notifications...");
        await page.click('a[data-test-global-nav-link="notifications"]');
        await page.waitForSelector("div[data-test-notification]");
        await randomDelay(2000, 4000);
        await page.goto("https://www.linkedin.com/feed/");
        await randomDelay();
      },
      async () => {
        // Visit random profile from feed
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

    // Perform random actions 5 times
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
