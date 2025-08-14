import puppeteer from "puppeteer";
import dotenv from "dotenv";
import { db, Timestamp } from "../firebase-config.js";
import { handleLinkedInLogin } from "./cookie-utils.js";
import { startPageRecording } from "./screenRecord-util.js";

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
      const name = await messageLi.$(
        "h3.msg-conversation-listitem__participant-names"
      );
      let threadName;
      if (name) {
        threadName = await page.evaluate((el) => el.innerText, name);
        console.log(`Thread name: ${threadName}`);
      }
      console.log(`Thread ${i} ID: ${Id}, and name: ${threadName}`);
      threads.push({ Id, name: threadName || "" });
      i++;
    }

    console.log("Fetching existing threads from Firestore...");
    const existingThreadsSnapshot = await db
      .collection("MessageThreads")
      .where("__name__", ">=", `${botId}_`)
      .where("__name__", "<", `${botId}_`)
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

          const campaignRef = await db
            .collection("Campaigns")
            .doc(process.env.CAMPAIGN_ID)
            .get();
          if (!campaignRef.exists) {
            console.error(`Campaign ${process.env.CAMPAIGN_ID} not found`);
            continue;
          }

          const campaignData = campaignRef.data();

          await db
            .collection("MessageThreads")
            .doc(`${botId}_${thread.Id}`)
            .set({
              conversationPrompt: campaignData.conversationPrompt || "",
              campaignId: process.env.CAMPAIGN_ID,
              name: thread.name,
              Id: thread.Id,
              matchedProfileId,
              createdAt: Timestamp.now(),
              process: false,
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

async function checkForNewMessages(page, messageThreads, botId) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let newMessagesFound = false;

  console.log("Checking for new messages in all threads...");

  await page.goto("https://www.linkedin.com/messaging/");
  await delay(3000);

  for (const thread of messageThreads) {
    try {
      console.log(`Checking thread: ${thread.name}`);

      const threadUrl = `https://www.linkedin.com/messaging/thread/${thread.threadId}/`;
      await page.goto(threadUrl, { waitUntil: "networkidle2" });
      await delay(3000);

      await page.waitForSelector(".msg-s-message-list", { timeout: 10000 });
      await delay(2000);

      const currentMessages = await page.$$(".msg-s-message-list__event");
      const messages = [];

      for (const message of currentMessages) {
        try {
          const name = await message
            .$eval(".msg-s-message-group__name", (node) => node.innerText)
            .catch(() => null);

          if (name === thread.name) {
            const messageContent = await message
              .$eval(".msg-s-event-listitem__body", (node) => node.innerText)
              .catch(() => null);

            if (messageContent) {
              let timestampText = await message
                .$eval(".msg-s-message-group__timestamp", (el) =>
                  el.innerText.trim()
                )
                .catch(() => null);

              let timestamp;
              if (timestampText) {
                try {
                  const todayStr = new Date().toDateString();
                  const fullDate = new Date(`${todayStr} ${timestampText}`);
                  timestamp = !isNaN(fullDate)
                    ? fullDate.toISOString()
                    : new Date().toISOString();
                } catch {
                  timestamp = new Date().toISOString();
                }
              } else {
                timestamp = new Date().toISOString();
              }

              console.log(`Message found: ${messageContent} at ${timestamp}`);

              console.log(thread.lastChecked);
              console.log(new Date(thread.lastChecked));
              console.log(new Date(timestamp));
              console.log(new Date(timestamp) > thread.lastChecked);

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

      const lastMessages = messages.filter((message) => {
        const messageDate = new Date(message.timestamp);
        return messageDate > thread.lastChecked;
      });

      if (lastMessages.length > 0) {
        console.log(
          `🔥 Found ${lastMessages.length} new message(s) in thread: ${thread.name}`
        );
        newMessagesFound = true;

        await db.collection("MessageThreads").doc(thread.docId).update({
          lastMessages,
          lastChecked: Timestamp.now(),
          process: true,
        });

        thread.lastChecked = new Date();
      }

      await delay(1000);
    } catch (error) {
      console.error(`Error checking thread ${thread.name}:", error`);
    }
  }

  return newMessagesFound;
}

async function activeInboxMonitor(page, messageThreads, botId) {
  const MONITOR_DURATION = 60 * 60 * 1000;
  const CHECK_INTERVAL = 10 * 1000;

  let endTime = Date.now() + MONITOR_DURATION;

  console.log("🔍 Starting active inbox monitoring for 5 minutes...");

  while (Date.now() < endTime) {
    const newMessagesFound = await checkForNewMessages(
      page,
      messageThreads,
      botId
    );

    if (newMessagesFound) {
      console.log("🔄 New messages found! Resetting timer...");
      endTime = Date.now() + MONITOR_DURATION;
    }

    const wait = Math.min(CHECK_INTERVAL, endTime - Date.now());
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
  }

  console.log("✅ Active monitoring period completed");
}

export default async function processLinkedin() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let page;
  let recorder;

  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    recorder = await startPageRecording(
      page,
      `./recordings/inboxchecker_${Date.now()}.mp4`,
      {
        fps: 25,
        videoFrame: { width: 854, height: 480 },
      }
    );

    const delay = (ms) => new Promise((res) => setTimeout(res, ms));

    const { botId, threads } = await preprocessing(browser, page);

    const messageThreadsSnapshot = await db
      .collection("MessageThreads")
      .where("__name__", ">=", `${botId}_`)
      .where("__name__", "<", `${botId}_`)
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

    const batch = db.batch();
    messageThreads.forEach((thread) => {
      const ref = db.collection("MessageThreads").doc(thread.docId);
      batch.update(ref, { process: false });
    });
    await batch.commit();

    await page.goto("https://www.linkedin.com/messaging/");
    await delay(3000);

    for (const thread of messageThreads) {
      try {
        console.log(`Checking thread: ${thread.name}`);
        const threadUrl = `https://www.linkedin.com/messaging/thread/${thread.threadId}/`;
        await page.goto(threadUrl, { waitUntil: "networkidle2" });
        await delay(30000);
        await page.waitForSelector(".msg-s-message-list", { timeout: 10000 });
        await delay(2000);

        const currentMessages = await page.$$(".msg-s-message-list__event");
        const messages = [];

        for (const message of currentMessages) {
          try {
            const name = await message
              .$eval(".msg-s-message-group__name", (node) => node.innerText)
              .catch(() => null);

            if (name === thread.name) {
              const content = await message
                .$eval(".msg-s-event-listitem__body", (node) => node.innerText)
                .catch(() => null);

              if (content) {
                let timestampText = await message
                  .$eval(".msg-s-message-group__timestamp", (el) =>
                    el.innerText.trim()
                  )
                  .catch(() => null);

                let timestamp;
                if (timestampText) {
                  try {
                    const todayStr = new Date().toDateString();
                    const fullDate = new Date(`${todayStr} ${timestampText}`);
                    timestamp = !isNaN(fullDate)
                      ? fullDate.toISOString()
                      : new Date().toISOString();
                  } catch {
                    timestamp = new Date().toISOString();
                  }
                } else {
                  timestamp = new Date().toISOString();
                }

                messages.push({ content, timestamp });
              }
            }
          } catch (msgError) {
            console.error("Error processing individual message:", msgError);
          }
        }

        const lastMessages = messages.filter(
          (msg) => new Date(msg.timestamp) > thread.lastChecked
        );

        if (lastMessages.length > 0) {
          await db.collection("MessageThreads").doc(thread.docId).update({
            lastMessages,
            lastChecked: Timestamp.now(),
            process: true,
          });

          thread.lastMessages = [
            ...(thread.lastMessages || []),
            ...lastMessages,
          ];
          thread.lastChecked = new Date();
        }

        await delay(2000);
      } catch (error) {
        console.error(`Error processing thread ${thread.name}:`, error);
      }
    }

    await activeInboxMonitor(page, messageThreads, botId);
  } catch (error) {
    console.error("❌ Error in processLinkedin:", error);
    if (page)
      await page.screenshot({ path: "error_screenshot.png", fullPage: true });
  } finally {
    if (recorder) {
      await recorder.stop();
      console.log("🟢 Recording stopped and saved");
    }

    await browser.close();
    console.log("🧹 Browser closed");
  }
}

processLinkedin();
