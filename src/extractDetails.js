import express from "express";
import Bull from "bull";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { db } from "../firebase-config.js";
import { handleLinkedInLogin } from "./cookie-utils.js";
import { startPageRecording } from "./screenRecord-util.js";

dotenv.config();

const extractRouter = express.Router();
extractRouter.use(express.json());

const extractQueue = new Bull("LinkedIn Profile Extractor Queue", {
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

async function extractProfileDetails() {
  const campaignId = process.env.CAMPAIGN_ID;
  const botId = `${process.env.LINKEDIN_EMAIL}_${process.env.LINKEDIN_PASS}`;

  console.log(
    `[${campaignId}/${botId}] Starting profile details extraction...`
  );

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;

  try {
    const botRef = db
      .collection("Campaigns")
      .doc(campaignId)
      .collection("bot_accounts")
      .doc(botId);

    const botSnap = await botRef.get();
    if (!botSnap.exists) {
      throw new Error(`Bot doc ${botId} not found in Campaign ${campaignId}`);
    }

    const { profiles } = botSnap.data();
    if (!profiles?.length) {
      console.log("No profiles found to extract");
      return;
    }

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const outputPath = `./recordings/extractor_${campaignId}_${botId}_${Date.now()}.mp4`;
    const recorder = await startPageRecording(page, outputPath, {
      fps: 25,
      videoFrame: { width: 1280, height: 800 },
    });

    const loginSuccess = await handleLinkedInLogin(
      page,
      process.env.LINKEDIN_EMAIL,
      process.env.LINKEDIN_PASS
    );

    if (!loginSuccess) throw new Error("Failed to login to LinkedIn");

    const profileDetails = [];

    console.log(`Extracting details for ${profiles.length} profiles...`);

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      try {
        console.log(`[${i + 1}/${profiles.length}] Visiting ${profile.link}`);
        await page.goto(profile.link, { waitUntil: "domcontentloaded" });
        await delay(3000);

        await page.waitForSelector("h1", { timeout: 10000 }).catch(() => {
          console.log("Profile page didn't load properly, skipping...");
        });

        let details = await page.evaluate(() => {
          const getText = (selector) => {
            const element = document.querySelector(selector);
            return element ? element.textContent.trim() : null;
          };
          const getTextMultiple = (selectors) => {
            for (const sel of selectors) {
              const val = getText(sel);
              if (val) return val;
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
        if (details.name) {
          console.log(
            `✓ Extracted: ${details.name} — ${
              details.headline || "No headline"
            }`
          );
        } else {
          console.log(`✗ Name not found for ${profile.link}`);
        }
        profileDetails.push(details);

        await delay(Math.random() * 2000 + 2000);
      } catch (err) {
        console.error(`Error extracting profile ${i + 1}:`, err.message);
        profileDetails.push({
          link: profile.link,
          name: null,
          headline: null,
          location: null,
          error: err.message,
        });
      }
    }

    await botRef.update({
      profiles: profileDetails,
      lastExtracted: new Date(),
      extractionStatus: "completed",
    });

    console.log(
      `✓ Updated ${campaignId}/${botId} with ${profileDetails.length} profiles extracted`
    );

    if (recorder) {
      await recorder.stop();
      console.log(`Recording saved to ${outputPath}`);
    }
  } catch (err) {
    console.error("Error:", err);
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

extractQueue.process("extract-profiles", 1, async (job) => {
  const { campaignId, botId } = job.data;
  console.log(`Processing extraction for ${campaignId}/${botId}`);

  try {
    await extractProfileDetails();
    console.log(`Extraction for ${campaignId}/${botId} completed`);
    return { success: true };
  } catch (error) {
    console.error(`Error processing ${campaignId}/${botId}:`, error);
    throw error;
  }
});

// Example endpoint to trigger extraction (customize as needed)
extractRouter.post("/extract-profiles", async (req, res) => {
  const { campaignId, botId } = req.body;
  try {
    await extractQueue.add("extract-profiles", { campaignId, botId });
    res.json({ success: true, message: "Extraction job queued" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default extractRouter;
