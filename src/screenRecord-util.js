import { PuppeteerScreenRecorder } from "puppeteer-screen-recorder";

export async function startPageRecording(page, outputPath, options = {}) {
  const recorder = new PuppeteerScreenRecorder(page, options);
  await recorder.start(outputPath);
  console.log("🔴 Recording started...");
  return recorder;
}
