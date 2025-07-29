import fs from "fs/promises";

export async function validateLinkedInCookies(cookieFilePath = "cookies.json") {
  try {
    const cookiesString = await fs.readFile(cookieFilePath, "utf8");
    const cookies = JSON.parse(cookiesString);

    const criticalCookies = ["li_at", "li_rm", "JSESSIONID"];
    const now = Math.floor(Date.now() / 1000);

    let hasExpiredCookies = false;
    let hasValidCookies = false;
    const cookieStatus = [];

    for (const cookieName of criticalCookies) {
      const cookie = cookies.find((c) => c.name === cookieName);

      if (!cookie) {
        cookieStatus.push(`❌ Critical cookie ${cookieName} is missing`);
        continue;
      }

      if (cookie.expires && cookie.expires !== -1) {
        const expirationTime = Math.floor(cookie.expires);
        const timeUntilExpiry = expirationTime - now;

        if (timeUntilExpiry <= 0) {
          cookieStatus.push(`❌ Cookie ${cookieName} has expired`);
          hasExpiredCookies = true;
        } else if (timeUntilExpiry < 3600) {
          const minutesUntilExpiry = Math.floor(timeUntilExpiry / 60);
          cookieStatus.push(
            `⚠️ Cookie ${cookieName} expires soon (${minutesUntilExpiry} minutes)`
          );
          hasValidCookies = true;
        } else {
          const hoursUntilExpiry = Math.floor(timeUntilExpiry / 3600);
          cookieStatus.push(
            `✅ Cookie ${cookieName} is valid (expires in ${hoursUntilExpiry} hours)`
          );
          hasValidCookies = true;
        }
      } else if (cookie.session) {
        cookieStatus.push(`✅ Cookie ${cookieName} is a session cookie`);
        hasValidCookies = true;
      } else {
        cookieStatus.push(`✅ Cookie ${cookieName} is persistent`);
        hasValidCookies = true;
      }
    }

    const isValid = !hasExpiredCookies && hasValidCookies;
    const message = cookieStatus.join("\n");

    return {
      isValid,
      cookies,
      message,
      hasExpiredCookies,
      hasValidCookies,
    };
  } catch (error) {
    return {
      isValid: false,
      cookies: [],
      message: `Error reading cookies: ${error.message}`,
      hasExpiredCookies: false,
      hasValidCookies: false,
    };
  }
}

export async function handleLinkedInLogin(
  page,
  email,
  password,
  cookieFilePath = "cookies.json"
) {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const cookieValidation = await validateLinkedInCookies(cookieFilePath);

  console.log("Cookie validation results:");
  console.log(cookieValidation.message);

  if (cookieValidation.isValid) {
    try {
      await page.setCookie(...cookieValidation.cookies);
      console.log("✅ Loaded valid cookies from file");

      let feedLoaded = false;
      try {
        await page.goto("https://www.linkedin.com/feed/", { timeout: 30000 });
        feedLoaded = true;
      } catch (err) {
        console.warn("⚠️ First navigation attempt timed out. Retrying...");
        try {
          await page.goto("https://www.linkedin.com/feed/", { timeout: 60000 });
          feedLoaded = true;
        } catch (retryErr) {
          console.error("❌ Retry navigation failed:", retryErr.message);
        }
      }

      if (feedLoaded) {
        await delay(5000);
        const searchBar = await page.$('[aria-label="Search"]');
        if (searchBar) {
          console.log("✅ Successfully authenticated using cookies");
          return true;
        } else {
          console.log("❌ Cookies failed server-side validation");
        }
      }
    } catch (error) {
      console.log("❌ Error using cookies:", error.message);
    }
  }

  console.log("🔄 Performing fresh login...");

  try {
    await page.goto("https://www.linkedin.com/login");
    await delay(3000);

    console.log("Entering credentials...");
    await page.type("#username", email);
    await page.type("#password", password);

    console.log("Submitting login form...");
    await page.click('button[type="submit"]');
    await delay(8000);

    const url = page.url();
    if (!url.includes("feed")) {
      const bodyText = await page
        .$eval("body", (el) => el.textContent)
        .catch(() => "");
      if (
        bodyText.includes("security challenge") ||
        bodyText.includes("verification")
      ) {
        console.log(
          "🔐 Security challenge detected. Please complete manually and press Enter to continue..."
        );
        await new Promise((resolve) => {
          process.stdin.once("data", () => resolve());
        });
      } else {
        throw new Error(`Login failed. Current URL: ${url}`);
      }
    }

    console.log("✅ Login successful!");

    const newCookies = await page.cookies();
    await fs.writeFile(cookieFilePath, JSON.stringify(newCookies, null, 2));
    console.log("💾 Saved fresh cookies for future use");

    return true;
  } catch (error) {
    console.error("❌ Login failed:", error.message);
    return false;
  }
}
