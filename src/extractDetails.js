import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { db } from "../firebase-config.js";
import { handleLinkedInLogin } from "./cookie-utils.js";

dotenv.config();

async function extractProfileDetails() {
  console.log("Starting profile details extraction...");
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;

  try {
    const docId = `${process.env.LINKEDIN_EMAIL}_${process.env.LINKEDIN_PASS}`;
    const docRef = db.collection("ProfileSearches").doc(docId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      throw new Error(`Document ${docId} not found in ProfileSearches`);
    }

    const docData = docSnap.data();
    const { profiles } = docData;

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const loginSuccess = await handleLinkedInLogin(
      page,
      process.env.LINKEDIN_EMAIL,
      process.env.LINKEDIN_PASS
    );

    if (!loginSuccess) {
      throw new Error("Failed to login to LinkedIn");
    }

    const profileDetails = [];

    console.log(
      `Starting to extract details for ${profiles.length} profiles...`
    );

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      try {
        console.log(
          `Extracting profile ${i + 1}/${profiles.length}: ${profile.link}`
        );

        await page.goto(profile.link);
        await delay(3000);

        // Wait for the page to load properly
        await page.waitForSelector("h1", { timeout: 10000 }).catch(() => {
          console.log("Profile page didn't load properly, skipping...");
        });

        let details = await page.evaluate(() => {
          const getText = (selector) => {
            const element = document.querySelector(selector);
            return element ? element.textContent.trim() : null;
          };

          // Try multiple selectors for better reliability
          const getTextMultiple = (selectors) => {
            for (const selector of selectors) {
              const text = getText(selector);
              if (text) return text;
            }
            return null;
          };

          return {
            name: getTextMultiple([
              "h1",
              ".text-heading-xlarge",
              ".pv-text-details__left-panel h1",
            ]),
            headline: getTextMultiple([
              "div.text-body-medium.break-words",
              ".text-body-medium",
              ".pv-text-details__left-panel .text-body-medium",
            ]),
            location: getTextMultiple([
              "span.text-body-small.inline.t-black--light.break-words",
              ".pv-text-details__left-panel .text-body-small",
              ".text-body-small.inline.t-black--light",
            ]),
          };
        });

        details.link = profile.link;

        // Only add if we got at least a name
        if (details.name) {
          profileDetails.push(details);
          console.log(
            `✓ Extracted: ${details.name} - ${
              details.headline || "No headline"
            }`
          );
        } else {
          console.log(`✗ Failed to extract name for profile: ${profile.link}`);
          // Still add the profile with whatever we could extract
          profileDetails.push(details);
        }

        // Random delay between 2-4 seconds to avoid being flagged
        await delay(Math.random() * 2000 + 2000);
      } catch (error) {
        console.error(
          `Error extracting details for profile ${i + 1}:`,
          error.message
        );
        // Add a placeholder entry to maintain array consistency
        profileDetails.push({
          link: profile.link,
          name: null,
          headline: null,
          location: null,
          error: error.message,
        });
      }
    }

    // Update the document with extracted profile details
    await docRef.update({
      profiles: profileDetails,
      lastExtracted: new Date(),
      extractionStatus: "completed",
    });

    console.log(
      `✓ Updated document ${docId} with ${profileDetails.length} profile details`
    );
    console.log(
      `Successfully extracted details for ${
        profileDetails.filter((p) => p.name).length
      }/${profiles.length} profiles`
    );
  } catch (error) {
    console.error("Error:", error);

    // Take error screenshot if possible
    if (page) {
      await page.screenshot({
        path: "extraction_error_screenshot.png",
        fullPage: true,
      });
      console.log("Error screenshot saved as extraction_error_screenshot.png");
    }
  } finally {
    await browser.close();
  }
}

extractProfileDetails();
