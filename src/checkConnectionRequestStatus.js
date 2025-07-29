import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { db } from "../firebase-config.js";
import { handleLinkedInLogin } from "./cookie-utils.js";
import { startPageRecording } from "./screenRecord-util.js";
import simulateNaturalTyping from "./typing-util.js";

dotenv.config();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getProfilesFromFirebase() {
  try {
    const docId = `${process.env.LINKEDIN_EMAIL}_${process.env.LINKEDIN_PASS}`;
    const docRef = db.collection("ProfileSearches").doc(docId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      console.log(`Document ${docId} not found`);
      return [];
    }

    const docData = docSnap.data();
    if (!docData.profiles || !Array.isArray(docData.profiles)) {
      console.log("No profiles array in document");
      return [];
    }

    console.log(`Fetched ${docData.profiles.length} profiles`);
    return docData.profiles;
  } catch (error) {
    console.error("Error fetching profiles:", error);
    return [];
  }
}

export async function checkConnectionStatus(profile) {
  const profileUrl = profile.link;
  console.log(`Checking: ${profileUrl}`);

  if (profile.messageSent) {
    console.log(`✓ Already marked messageSent for ${profileUrl}, skipping.`);
    return {
      profileUrl,
      connectionStatus: "already_marked",
      messageSent: true,
      skipped: true,
    };
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;
  let recorder;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const outputPath = `./recordings/connection_check_${Date.now()}.mp4`;

    recorder = await startPageRecording(page, outputPath, {
      followNewTab: true,
      fps: 25,
      videoFrame: {
        width: 1280,
        height: 800,
      },
    });

    const loginSuccess = await handleLinkedInLogin(
      page,
      process.env.LINKEDIN_EMAIL,
      process.env.LINKEDIN_PASS
    );

    if (!loginSuccess) throw new Error("LinkedIn login failed");

    await page.goto(profileUrl);
    await delay(10000);

    const isPending = await page.$('span ::-p-text("Pending")');
    const message = await page.$$("span.artdeco-button__text");

    let canMessage = [];

    for (const el of message) {
      const text = await el.evaluate((node) => node.textContent.trim());
      if (text === "Message") {
        console.log(el);
        canMessage.push(el);
      }
    }

    if (!isPending && canMessage[1]) {
      console.log(`✓ Connected: ${profileUrl}`);

      await canMessage[1].click();

      await page.waitForSelector('div[role="textbox"]', { timeout: 5000 });

      await simulateNaturalTyping(
        page,
        'div[role="textbox"]',
        profile.generatedMessage
      );

      const button = await page.$('button[type="submit"]');

      if (button) {
        await button.click();
        console.log("✅ Message sent successfully");
      }

      return {
        profileUrl,
        connectionStatus: "connected",
        isPending: false,
        messageSent: true,
        recordingPath: outputPath,
      };
    }

    if (isPending) {
      console.log(`⏳ Pending: ${profileUrl}`);
      return {
        profileUrl,
        connectionStatus: "pending",
        isPending: true,
        messageSent: false,
        recordingPath: outputPath,
      };
    }

    console.log(`❓ Unknown status: ${profileUrl}`);
    return {
      profileUrl,
      connectionStatus: "unknown",
      isPending: false,
      messageSent: false,
      recordingPath: outputPath,
    };
  } catch (error) {
    console.error(`✗ Error checking ${profileUrl}:`, error.message);

    if (page) {
      try {
        const timestamp = Date.now();
        await page.screenshot({
          path: `error_check_${timestamp}.png`,
          fullPage: true,
        });
        console.log(`📸 Screenshot saved: error_check_${timestamp}.png`);
      } catch (screenshotError) {
        console.error("Failed to take screenshot:", screenshotError);
      }
    }

    return {
      profileUrl,
      connectionStatus: "error",
      error: error.message,
      messageSent: false,
    };
  } finally {
    if (recorder) {
      try {
        await recorder.stop();
        console.log("🛑 Recording stopped");
      } catch (err) {
        console.error("Failed to stop recorder:", err);
      }
    }

    if (browser) await browser.close();
  }
}

export async function checkMultipleConnections(profiles) {
  console.log(`Checking ${profiles.length} profiles...\n`);
  const results = [];

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    console.log(`--- Profile ${i + 1}/${profiles.length} ---`);

    try {
      const result = await checkConnectionStatus(profile);
      results.push(result);

      if (i < profiles.length - 1) {
        const wait = Math.random() * 5000 + 3000;
        console.log(`Waiting ${Math.round(wait / 1000)}s...\n`);
        await delay(wait);
      }
    } catch (error) {
      console.error(`Error checking ${profile.link}:`, error);
      results.push({
        profileUrl: profile.link,
        connectionStatus: "error",
        messageSent: false,
        error: error.message,
      });
    }
  }

  const summary = {
    total: results.length,
    connected: results.filter((r) => r.connectionStatus === "connected").length,
    pending: results.filter((r) => r.connectionStatus === "pending").length,
    unknown: results.filter((r) => r.connectionStatus === "unknown").length,
    errors: results.filter((r) => r.connectionStatus === "error").length,
    alreadyMarked: results.filter((r) => r.skipped).length,
    messageSent: results.filter((r) => r.messageSent).length,
  };

  console.log("\n=== SUMMARY ===");
  console.log(summary);

  return { results, summary };
}

async function updateFirebaseWithResults(results) {
  try {
    const docId = `${process.env.LINKEDIN_EMAIL}_${process.env.LINKEDIN_PASS}`;
    const docRef = db.collection("ProfileSearches").doc(docId);

    const docSnap = await docRef.get();
    if (!docSnap.exists) {
      console.log("Document not found for update");
      return;
    }

    const docData = docSnap.data();
    const resultMap = {};
    results.results.forEach((r) => {
      resultMap[r.profileUrl] = {
        messageSent: r.messageSent || false,
      };
    });

    const updatedProfiles = docData.profiles.map((profile) => {
      const result = resultMap[profile.link];
      if (result) {
        return {
          ...profile,
          messageSent: result.messageSent,
        };
      }
      return profile;
    });

    await docRef.update({ profiles: updatedProfiles });
    console.log("✓ Firebase updated with messageSent status.");
  } catch (error) {
    console.error("Error updating Firebase:", error);
  }
}

export async function startConnectionCheck() {
  console.log("Starting simplified LinkedIn connection check...");

  try {
    const profiles = await getProfilesFromFirebase();
    if (profiles.length === 0) {
      console.log("No profiles to check.");
      return { success: false };
    }

    const results = await checkMultipleConnections(profiles);
    await updateFirebaseWithResults(results);
    return { success: true, ...results };
  } catch (error) {
    console.error("Connection check failed:", error);
    return { success: false, error: error.message };
  }
}

export default async function runConnectionChecker() {
  const result = await startConnectionCheck();

  if (result.success) {
    console.log("\n=== CHECK COMPLETE ===");
    console.log(`Total: ${result.summary.total}`);
    console.log(`Connected: ${result.summary.connected}`);
    console.log(`Pending: ${result.summary.pending}`);
    console.log(`Errors: ${result.summary.errors}`);
    console.log(`Already marked: ${result.summary.alreadyMarked}`);
  } else {
    console.error("❌ Failed to complete check");
  }
}
