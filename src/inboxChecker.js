import puppeteer from "puppeteer";
import dotenv from "dotenv";
import fs from "fs/promises";
import { db, Timestamp } from "../firebase-config.js";
import { handleLinkedInLogin } from "./cookie-utils.js";

dotenv.config();

async function preprocessing(browser, page) {
  console.log("Starting LinkedIn message scraping...");

  try {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const botId = `${process.env.LINKEDIN_EMAIL}_${process.env.LINKEDIN_PASS}`;

    const loginSuccess = await handleLinkedInLogin(
      page,
      process.env.LINKEDIN_EMAIL,
      process.env.LINKEDIN_PASS
    );

    if (!loginSuccess) {
      throw new Error("Failed to login to LinkedIn");
    }

    await page.goto("https://www.linkedin.com/messaging/");
    await delay(5000);

    console.log("fetching all the threads.....");

    let i = 1;
    const threads = [];
    while (true) {
      const selector = `#main > div > div.scaffold-layout__list-detail-inner.scaffold-layout__list-detail-inner--grow > div.scaffold-layout__list.msg__list > div.relative.display-flex.justify-center.flex-column.overflow-hidden.msg-conversations-container--inbox-shortcuts > ul > li:nth-child(${i})`;

      const messageLi = await page.$(selector);

      if (!messageLi) {
        console.log(`No thread found at position ${i}`);
        break;
      }

      const clickableEle = await messageLi.$(
        "div.entry-point > div.msg-conversation-listitem__link.msg-conversations-container__convo-item-link.pl3"
      );

      if (!clickableEle) {
        console.log(`No clicakable element found at position ${i}`);
        i++;
        continue;
      }

      await clickableEle.click();

      await page.waitForFunction(() =>
        window.location.href.includes("/messaging/thread/")
      );

      const threadUrl = page.url();
      const Id = threadUrl.match(/messaging\/thread\/([^/]+)/)?.[1] || "N/A";
      const name = await page.$("h2#thread-detail-jump-target");
      let threadName;
      if (name) {
        threadName = await page.evaluate((el) => el.innerText, name);
      }
      console.log(`Thread ${i} ID: ${Id}, and name: ${threadName}`);
      threads.push({ Id, name: threadName || "" });
      i++;
    }

    console.log("Fetching existing threads from Firestore...");
    const existingThreadsSnapshot = await db
      .collection("MessageThreads")
      .where("__name__", ">=", `${botId}_`)
      .where("__name__", "<", `${botId}_\uf8ff`)
      .get();

    const existingThreadIds = new Set();
    existingThreadsSnapshot.forEach((doc) => {
      const threadId = doc.id.replace(`${botId}_`, "");
      existingThreadIds.add(threadId);
    });

    console.log(
      `Found ${existingThreadIds.size} existing threads in Firestore`
    );

    const newThreads = threads.filter(
      (thread) => !existingThreadIds.has(thread.Id)
    );

    console.log(`Found ${newThreads.length} new threads to process`);

    console.log("Fetching known profiles for matching...");
    const profileSearchesSnapshot = await db
      .collection("ProfileSearches")
      .doc(botId)
      .get();

    let knownProfiles = [];
    if (profileSearchesSnapshot.exists) {
      const data = profileSearchesSnapshot.data();
      knownProfiles = data.profiles || [];
    }

    for (const thread of newThreads) {
      try {
        console.log(`Processing new thread: ${thread.name}`);

        let matchedProfileId = null;
        const matchedProfile = knownProfiles.find((profile) => {
          return (
            thread.name
              .toLowerCase()
              .includes(profile.name?.toLowerCase() || "") &&
            profile.name?.toLowerCase().includes(thread.name.toLowerCase())
          );
        });

        if (matchedProfile) {
          matchedProfileId = matchedProfile.link;
          console.log(`Matched thread to profile: ${matchedProfileId}`);

          await db
            .collection("MessageThreads")
            .doc(`${botId}_${thread.Id}`)
            .set({
              name: thread.name,
              Id: thread.Id,
              matchedProfileId,
              createdAt: Timestamp.now(),
            });
          console.log(`Saved thread to Firestore: ${thread.name}`);
        }
        console.log(`profile not matched: ${thread.name}`);
      } catch (error) {
        console.error(`Error processing thread ${thread.name}:`, error);
      }
    }

    return { botId, threads };
  } catch (error) {
    console.error("Error in preprocessing:", error);
    throw error;
  }
}

async function processLinkedin() {
  console.log("Starting LinkedIn message processing...");

  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Run preprocessing to get bot ID and threads
    const { botId, threads } = await preprocessing(browser, page);

    console.log("Fetching all message threads from Firestore...");

    // Get all message threads for this bot from Firestore
    const messageThreadsSnapshot = await db
      .collection("MessageThreads")
      .where("__name__", ">=", `${botId}_`)
      .where("__name__", "<", `${botId}_\uf8ff`)
      .get();

    const messageThreads = [];
    messageThreadsSnapshot.forEach((doc) => {
      const data = doc.data();
      messageThreads.push({
        docId: doc.id,
        threadId: data.Id,
        name: data.name,
        matchedProfileId: data.matchedProfileId,
        lastMessages: data.lastMessages || [],
        lastChecked: data.lastChecked ? data.lastChecked.toDate() : new Date(0),
      });
    });

    console.log(
      `Found ${messageThreads.length} threads to check for new messages`
    );

    // Navigate back to messaging page
    await page.goto("https://www.linkedin.com/messaging/");
    await delay(3000);

    for (const thread of messageThreads) {
      try {
        console.log(`Checking thread: ${thread.name}`);

        // Navigate to the specific thread
        const threadUrl = `https://www.linkedin.com/messaging/thread/${thread.threadId}/`;
        await page.goto(threadUrl);
        await delay(3000);

        await page.waitForSelector(".msg-s-message-list", { timeout: 10000 });
        await delay(2000);

        const currentMessages = await page.$$(".msg-s-message-list__event");
        const messages = [];
        for (const message of currentMessages) {
          try {
            // Get the sender name - fix the missing return statement
            const name = await message
              .$eval(".msg-s-message-group__name", (node) => node.innerText)
              .catch(() => null);

            console.log("Message sender:", name);

            if (name === thread.name) {
              const messageContent = await message
                .$eval(".msg-s-event-listitem__body", (node) => node.innerText)
                .catch(() => null);

              if (messageContent) {
                const timestamp = await message
                  .$eval(".msg-s-message-list__time-heading time", (el) =>
                    el.getAttribute("datetime")
                  )
                  .catch(() => new Date().toISOString());

                messages.push({
                  content: messageContent,
                  timestamp: timestamp,
                });
              }
            }
          } catch (msgError) {
            console.error("Error processing individual message:", msgError);
          }
        }

        const lastMessages = messages.filter(
          (message) => new Date(message.timestamp) > thread.lastChecked
        );

        if (lastMessages.length > 0) {
          await db.collection("MessageThreads").doc(thread.docId).update({
            lastMessages,
            lastChecked: Timestamp.now(),
            process: true,
          });
        }
        await delay(2000);
      } catch (error) {
        console.error(`Error processing thread ${thread.name}:`, error);
      }
    }

    console.log("✅ Finished processing all message threads");
  } catch (error) {
    console.error("Error in processLinkedin:", error);

    if (page) {
      await page.screenshot({ path: "error_screenshot.png", fullPage: true });
      console.log("Error screenshot saved as error_screenshot.png");
    }
  } finally {
    await browser.close();
    console.log("Browser closed");
  }
}

processLinkedin();
