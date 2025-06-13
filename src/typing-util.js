const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function simulateNaturalTyping(page, selector, message) {
  const element = await page.$(selector);
  if (!element) {
    throw new Error(`Element with selector ${selector} not found`);
  }

  await element.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");

  const wordsPerMinute = 67;
  const charsPerSecond = (wordsPerMinute * 5) / 60;
  const baseDelay = 1000 / charsPerSecond;

  let charCount = 0;

  for (let i = 0; i < message.length; i++) {
    const char = message[i];

    const typingDelay = baseDelay + (Math.random() - 0.5) * 100;
    await delay(typingDelay);

    if (
      charCount > 0 &&
      charCount % 30 === 0 &&
      Math.random() < 0.4 &&
      char !== " "
    ) {
      const wrongChar = String.fromCharCode(
        char.charCodeAt(0) + Math.floor(Math.random() * 3) - 1
      );
      await page.keyboard.type(wrongChar);
      await delay(150 + Math.random() * 200); // Pause to "notice" typo
      await page.keyboard.press("Backspace");
      await delay(80 + Math.random() * 120);
    }

    await page.keyboard.type(char);
    charCount++;

    if ([".", "!", "?", ","].includes(char)) {
      await delay(200 + Math.random() * 300);
    }

    if (char === " ") {
      await delay(60 + Math.random() * 100);
    }
  }

  console.log(`✓ Typed message naturally: ${message.length} characters`);
}

export default simulateNaturalTyping;
