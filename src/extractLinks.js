import puppeteer from "puppeteer";
import dotenv from "dotenv";
import fs from "fs/promises";
import { db, Timestamp } from "../firebase-config.js";

dotenv.config();

async function linkedInLoginAndSearch() {
  console.log("Starting LinkedIn automation...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Check for saved cookies
    let loggedIn = false;
    try {
      const cookiesString = await fs.readFile("cookies.json", "utf8");
      const cookies = JSON.parse(cookiesString);
      await page.setCookie(...cookies);
      console.log("Loaded cookies from file");

      // Navigate to LinkedIn feed
      await page.goto("https://www.linkedin.com/feed/");
      await delay(5000);

      const searchBar = await page.$('[aria-label="Search"]');
      if (searchBar) {
        console.log("Successfully logged in using cookies");
        loggedIn = true;
      } else {
        console.log("Cookies didn't work, proceeding with login");
      }
    } catch (error) {
      console.log("No valid cookies found or error loading cookies");
    }

    // If not logged in with cookies, do manual login
    if (!loggedIn) {
      console.log("Navigating to login page...");
      await page.goto("https://www.linkedin.com/login");
      await delay(3000);

      console.log("Entering credentials...");
      await page.type("#username", process.env.LINKEDIN_EMAIL);
      await page.type("#password", process.env.LINKEDIN_PASS);

      console.log("Submitting login form...");
      await page.click('button[type="submit"]');

      // Wait for navigation to complete
      await delay(8000);

      // Check if login was successful
      const url = page.url();
      if (!url.includes("feed")) {
        console.log("Login might have failed, current URL:", url);
        throw new Error("Login failed");
      }

      console.log("Login successful!");

      // Save cookies for future use
      const cookies = await page.cookies();
      await fs.writeFile("cookies.json", JSON.stringify(cookies, null, 2));
      console.log("Saved cookies for future use");
    }

    // Now search for a random company name
    const companyNames = ["indie builders"];
    const randomCompany =
      companyNames[Math.floor(Math.random() * companyNames.length)];
    console.log(`Searching for company '${randomCompany}'...`);

    // Click on search bar and type search query
    await page.click('[aria-label="Search"]');
    await delay(1000);
    await page.type('input[aria-label="Search"]', randomCompany);
    await page.keyboard.press("Enter");

    // Wait for search results to load and click on People button
    console.log("Waiting for People button...");

    await page.waitForSelector(
      `#search-reusables__filters-bar > ul > li:nth-child(1) > button`
    );
    let i = 1;
    while (true) {
      const button = await page.$(
        `#search-reusables__filters-bar > ul > li:nth-child(${i}) > button`
      );
      if (!button) {
        console.log(`No button found at position ${i}, stopping search`);
        break;
      }

      const text = await button.evaluate((el) => el.textContent.trim());
      console.log(`Button ${i} text:`, text);
      if (text === "People") {
        await button.click();
        break;
      }
      i++;
    }

    console.log("Waiting for profile links...");
    await page.waitForSelector('a[href*="/in/"]');

    const profileLinks = await page.$$('a[href*="/in/"]');

    const links = [];
    const seenHrefs = new Set();

    for (const link of profileLinks) {
      const href = await link.evaluate((el) => el.href);
      const text = await link.evaluate((el) => el.textContent.trim());

      if (!seenHrefs.has(href)) {
        console.log(`Found new profile: ${text}`);

        const cleanHref = href.replace(/[#?].*$/, "");

        links.push(cleanHref);
        seenHrefs.add(href);
      } else {
        console.log(`Skipping duplicate profile: ${text}`);
      }
    }

    if (links.length > 0) {
      await db
        .collection("ProfileSearches")
        .doc(`${process.env.LINKEDIN_EMAIL}_${process.env.LINKEDIN_PASS}`)
        .set({
          company: randomCompany,
          profileCount: 10,
          profiles: links,
          date: Timestamp.now(),
        });
    }

    console.log(`Found ${links.length} unique profile links`);

    await page.screenshot({ path: "search_results.png", fullPage: true });
    console.log("Screenshot saved as search_results.png");

    console.log("Search and message sent successfully!");
  } catch (error) {
    console.error("Error:", error);

    if (page) {
      await page.screenshot({ path: "error_screenshot.png", fullPage: true });
      console.log("Error screenshot saved as error_screenshot.png");
    }
  } finally {
    await browser.close();
  }
}

linkedInLoginAndSearch();
