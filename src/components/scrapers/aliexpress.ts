import puppeteer, { Browser, Page } from "puppeteer";
import waitFor from "../../utils/wait.js";

/**
 * Interface for a single review
 */
interface Review {
  text: string;
  rating: number;
}

/**
 * Interface for product data extracted from the page
 */
interface ProductData {
  title?: string;
  rating?: number;
  totalReviews?: number;
  image?: string;
}

/**
 * Interface for the final scraping result
 */
interface ScrapingResult {
  title: string;
  rating: number | string;
  totalReviews: number | string;
  image: string;
  fiveStarReviews: Review[];
  fiveStarReviewCount: number;
}

/**
 * Configuration options for the scraper
 */
interface ScraperConfig {
  maxReviews?: number;
  headless?: boolean;
  timeout?: number;
  userAgent?: string;
}

/**
 * Scrapes product information and 5-star reviews from an AliExpress product page
 * @param productUrl - The full URL of the AliExpress product
 * @param config - Configuration options for scraping
 * @returns Promise containing the scraped product data and reviews
 */
export async function scrapeAliExpressProduct(productUrl: string, config: ScraperConfig = {}): Promise<ScrapingResult> {
  const {
    maxReviews = 100,
    headless = true,
    timeout = 60000,
    userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  } = config;

  let browser: Browser | undefined;

  try {
    console.log("Launching browser...");
    browser = await puppeteer.launch({
      headless: headless ? "shell" : false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage", // Overcome limited resource problems
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process", // Use with caution - may be unstable
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      executablePath: process.env.CHROME_BIN || undefined, // Allow custom Chrome path
    });

    const page: Page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent(userAgent);

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set extra headers to avoid detection
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    // Block unnecessary resources to speed up
    await page.setRequestInterception(true);
    page.on("request", request => {
      const resourceType = request.resourceType();
      if (["font", "media"].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    console.log("Navigating to product page...");
    await page.goto(productUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeout,
    });

    // Wait for page to load
    await waitFor(5000);

    console.log("Extracting product information...");

    // Extract product information (title + image). Keep this simple and avoid nested page.evaluate calls.
    const productData: ProductData = await page.evaluate(() => {
      const data: ProductData = {};

      // Get product title - try multiple selectors
      const titleSelectors: string[] = [
        'h1[data-pl="product-title"]',
        ".product-title-text",
        "h1.product-title",
        '[class*="Title"]',
        "h1",
      ];

      for (const selector of titleSelectors) {
        const titleEl = document.querySelector(selector);
        if (titleEl && titleEl.textContent?.trim()) {
          data.title = titleEl.textContent.trim();
          break;
        }
      }

      // Get product image - try multiple selectors
      const imageSelectors: string[] = [
        ".magnifier--image--RM17RL2",
        "img.magnifier--image--RM17RL2",
        ".magnifier--wrap--qjbuwmt img",
        '[class*="magnifier"][class*="image"]',
        ".magnifier-image img",
        '[class*="ImageView"] img',
        ".images-view-item img",
        'img[data-pl="product-image"]',
        ".product-image img",
        '[class*="image-view"] img',
      ];

      for (const selector of imageSelectors) {
        const imgEl = document.querySelector(selector) as HTMLImageElement | null;
        if (imgEl && (imgEl.src || (imgEl as any).dataset?.src)) {
          data.image = imgEl.src || (imgEl as any).dataset?.src;
          if (data.image && !data.image.includes("data:image")) {
            break;
          }
        }
      }

      return data;
    });

    console.log("Product data extracted:");
    console.log("- Title:", productData.title || "Not found");
    console.log("- Rating:", productData.rating || "Not found");
    console.log("- Total Reviews:", productData.totalReviews || "Not found");
    console.log("- Image URL:", productData.image);

    // Scroll down to load reviews section
    console.log("\nScrolling to reviews section...");
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
    });
    await waitFor(3000);

    // Try to open reviews modal/tab and filter to 5-star reviews
    console.log("Looking for reviews modal and rating filter...");
    try {
      // 1) Click the "View more" button to expand reviews (commonly contains the text "View more")
      const viewMoreClicked: boolean = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];
        const btn = candidates.find(b => {
          const txt = (b.textContent || "").trim().toLowerCase();
          const spanTxt = (b.querySelector("span")?.textContent || "").trim().toLowerCase();
          return txt === "view more" || spanTxt === "view more" || txt.includes("view more");
        });
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });

      if (viewMoreClicked) {
        console.log("Clicked 'View more' to expand reviews modal");
        await waitFor(1500);
      }

      // 2) Open the ratings dropdown and select the "5 Star" item using element handles.
      // The dropdown on this site shows on hover, so use elementHandle.hover() where possible
      // and confirm the filter applied by checking for a change in the review count.
      let fiveStarSelected = false;
      try {
        // find candidate buttons that could be the ratings control
        const candidates = await page.$$('button, a, div[role="button"], .filter--filterItem--AEUeCbl');
        let ratingsHandle: any = null;
        for (const h of candidates) {
          const txt = (await page.evaluate(el => (el.textContent || "").toLowerCase(), h)) as string;
          if (txt.includes("all ratings") || txt.includes("ratings")) {
            ratingsHandle = h;
            break;
          }
        }

        if (ratingsHandle) {
          try {
            await ratingsHandle.hover();
            console.log("Hovered 'All ratings' button");
          } catch (e) {
            // hover might fail in some headless contexts, fall back to a click
            try {
              await ratingsHandle.click();
              console.log("Clicked 'All ratings' button as fallback");
            } catch {}
          }

          // Wait for the dropdown menu to appear
          try {
            await page.waitForSelector(".comet-v2-dropdown-body, .comet-v2-menu-item", { timeout: 3000 });
          } catch {
            // small fallback wait
            await waitFor(800);
          }

          // locate menu items and pick the one matching 5 stars
          const menuItems = await page.$$(".comet-v2-menu-item, .comet-v2-menu-item-content, li");
          let targetItem: any = null;
          for (const mi of menuItems) {
            const mtxt = (await page.evaluate(el => (el.textContent || "").trim().toLowerCase(), mi)) as string;
            if (mtxt === "5 star" || mtxt.startsWith("5 ") || mtxt.includes("5-star")) {
              targetItem = mi;
              break;
            }
          }

          // If we found a candidate, click it and wait for the list to change
          if (targetItem) {
            const preCount = await page.$$eval(".list--itemBox--je_KNzb", els => els.length);
            try {
              await targetItem.click();
              console.log("Clicked '5 Star' menu item");
            } catch (e) {
              // try clicking via evaluate as a last resort
              try {
                await page.evaluate(el => (el as HTMLElement).click(), targetItem);
              } catch {}
            }

            // wait for change in number of review boxes (indicates filter applied), or time out
            try {
              await page.waitForFunction(
                (sel, before) => document.querySelectorAll(sel).length !== before,
                { timeout: 5000 },
                ".list--itemBox--je_KNzb",
                preCount,
              );
              fiveStarSelected = true;
              console.log("Detected change in review list after selecting '5 Star'");
            } catch {
              // no change detected — keep fiveStarSelected false and fall back later
              console.log("No immediate change in review list after selecting '5 Star'");
            }
          } else {
            console.log("Could not find explicit '5 Star' menu item (will attempt other fallbacks)");
          }
        } else {
          console.log("Couldn't find an 'All ratings' control to hover/click");
        }
      } catch (e) {
        console.log("Error while trying to open/select ratings dropdown:", (e as Error).message);
      }

      if (fiveStarSelected) {
        console.log("Selected '5 Star' filter (confirmed)");
        await waitFor(800);
      }
      // Wait for the reviews modal and the review list to appear — the modal uses `.comet-v2-modal-body`
      try {
        await page.waitForSelector(".comet-v2-modal-body", { timeout: 8000 });
        await page.waitForSelector(".list--itemBox--je_KNzb", { timeout: 8000 });
        console.log("Reviews modal and list detected");
      } catch (e) {
        console.log("Reviews modal or list not detected within timeout, continuing to scraping (may miss reviews)");
      }
    } catch (e) {
      const error = e as Error;
      console.log("Could not open/filter reviews:", error.message);
    }

    // Try to filter for 5-star reviews
    console.log("Attempting to filter for 5-star reviews...");
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, label, div[role="button"]'));
        const fiveStarButton = buttons.find(
          btn =>
            btn.textContent?.includes("5") &&
            (btn.textContent?.toLowerCase().includes("star") || btn.innerHTML.includes("star")),
        );
        if (fiveStarButton) {
          (fiveStarButton as HTMLElement).click();
        }
      });
      await waitFor(2000);
    } catch (e) {
      console.log("Could not filter for 5-star reviews");
    }

    // Scrape all reviews (load lazily by scrolling the modal). We'll collect all reviews and their numeric
    // rating (counting full and half stars), deduplicate by text, then filter locally for 5-star entries.
    console.log("Scraping reviews (collecting all, will filter locally)...");
    const allReviews: Review[] = [];
    let noChangeCount = 0;

    while (allReviews.length < maxReviews && noChangeCount < 3) {
      // Grab visible review boxes and extract text + rating (full + half stars)
      const reviewsBatch: Array<{ text: string; rating: number }> = await page.evaluate(() => {
        const boxes = Array.from(document.querySelectorAll(".list--itemBox--je_KNzb")) as HTMLElement[];
        const collected: Array<{ text: string; rating: number }> = [];

        boxes.forEach(box => {
          // Count filled and half star icons
          const filled = box.querySelectorAll(".comet-icon-starreviewfilled").length || 0;
          const half = box.querySelectorAll(".comet-icon-starhalfreview").length || 0;
          const rating = filled + (half > 0 ? 0.5 : 0);

          // Primary review text element
          const reviewEl = box.querySelector(".list--itemReview--d9Z9Z5Z");
          let reviewText = reviewEl && reviewEl.textContent ? reviewEl.textContent.trim() : "";

          // Fallback: some boxes include an "Additional review" block (strong + span)
          if (!reviewText) {
            const strong = box.querySelector("strong");
            if (strong && /additional review/i.test(strong.textContent || "")) {
              const span = strong.nextElementSibling as HTMLElement | null;
              if (span && span.textContent) {
                reviewText = span.textContent.trim();
              } else if (strong.parentElement) {
                const nearbySpan = strong.parentElement.querySelector("span");
                if (nearbySpan && nearbySpan.textContent) reviewText = nearbySpan.textContent.trim();
              }
            }
          }

          // Last resort: small trimmed text from the box
          if (!reviewText) {
            const boxText = (box.textContent || "").trim();
            if (boxText && boxText.length > 5 && boxText.length < 800) {
              reviewText = boxText;
            }
          }

          if (reviewText) {
            collected.push({ text: reviewText, rating });
          }
        });

        return collected;
      });

      // Add unique reviews to the master list (dedupe by exact text)
      const before = allReviews.length;
      for (const r of reviewsBatch) {
        if (allReviews.length >= maxReviews) break;
        if (!allReviews.find(rr => rr.text === r.text)) {
          allReviews.push({ text: r.text, rating: Math.round(r.rating * 10) / 10 });
        }
      }

      if (allReviews.length === before) {
        noChangeCount++;
      } else {
        noChangeCount = 0;
      }

      console.log(`Collected ${allReviews.length} total reviews so far...`);

      if (allReviews.length >= maxReviews) break;

      // Attempt to load more reviews by scrolling the reviews modal (preferred) or window as fallback.
      const preBoxCount = await page.$$eval(".list--itemBox--je_KNzb", els => els.length);
      await page.evaluate(() => {
        const modal = document.querySelector(".comet-v2-modal-body") as HTMLElement | null;
        if (modal) {
          modal.scrollBy(0, modal.scrollHeight || 1000);
          return;
        }
        window.scrollBy(0, 1000);
      });

      // Wait until more boxes appear (or timeout) to confirm lazy-load; otherwise loop will exit after a few tries
      try {
        await page.waitForFunction(
          (sel, before) => document.querySelectorAll(sel).length > before,
          { timeout: 3000 },
          ".list--itemBox--je_KNzb",
          preBoxCount,
        );
        // small pause after new content appears
        await waitFor(600);
      } catch {
        // No new boxes appeared in the allotted time; allow the loop's noChangeCount to advance
        await waitFor(600);
      }
    }

    // Now filter locally for exactly 5.0 rated reviews
    const fiveStarReviews = allReviews.filter(r => r.rating === 5).slice(0, maxReviews);

    console.log(`Found ${fiveStarReviews.length} 5-star reviews after collecting all reviews.`);

    // Compile final result
    const result: ScrapingResult = {
      title: productData.title || "N/A",
      rating: productData.rating || "N/A",
      totalReviews: productData.totalReviews || "N/A",
      image: productData.image || "N/A",
      fiveStarReviews: fiveStarReviews.slice(0, maxReviews),
      fiveStarReviewCount: fiveStarReviews.length,
    };

    console.log("\n=== SCRAPING COMPLETE ===");
    console.log(`Title: ${result.title}`);
    console.log(`Rating: ${result.rating}`);
    console.log(`Total Reviews: ${result.totalReviews}`);
    console.log(`Image URL: ${result.image !== "N/A" ? "Found" : "Not found"}`);
    console.log(`5-Star Reviews Found: ${result.fiveStarReviewCount}`);

    return result;
  } catch (error) {
    const err = error as Error;
    console.error("Error scraping AliExpress:", err.message);
    console.error(err.stack);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
