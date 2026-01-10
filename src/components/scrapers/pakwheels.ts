import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

interface Review {
  // internal use for the detailed object
  id?: string;
  author?: string;
  date?: string;
  body: string;
  rating: number;
  source?: string;
  helpfulCount?: number;
}

interface ScraperConfig {
  maxReviews?: number;
  headless?: boolean;
  timeout?: number;
  userAgent?: string;
}

interface ScrapingResult {
  title: string;
  image: string;
  rating: number | string;
  totalReviews: number | string;
  fiveStarReviews: { text: string; rating: number }[];
}

puppeteer.use(StealthPlugin());

export async function scrapePakWheelsProduct(productUrl: string, config: ScraperConfig = {}): Promise<ScrapingResult> {
  const {
    maxReviews = 50,
    headless = true,
    timeout = 60000,
    userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  } = config;

  console.log(`[PakWheels] Starting scrape for ${productUrl}`);

  let browser: Browser | undefined;

  try {
    browser = (await puppeteer.launch({
      headless: headless ? "shell" : false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      executablePath: process.env.CHROME_BIN || undefined,
    })) as unknown as Browser;

    const page: Page = await browser.newPage();
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1280, height: 900 });

    // Enable request interception to speed up loading by blocking unnecessary resources
    await page.setRequestInterception(true);
    page.on("request", req => {
      const resourceType = req.resourceType();
      if (["font", "media"].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log("[PakWheels] Navigating to product page...");
    try {
      await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout });
    } catch (e) {
      console.log("[PakWheels] Navigation timeout/error, proceeding...", e);
    }

    // Scroll to bottom to trigger lazy loading (essential for reviews if they exist)
    console.log("[PakWheels] Scrolling to trigger lazy loading...");
    await page.evaluate(async () => {
      await new Promise<void>(resolve => {
        let totalHeight = 0;
        const distance = 100;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 50); // Faster scroll
      });
    });
    // Wait for any final network calls
    await new Promise(r => setTimeout(r, 2000));

    // Extract Product Details
    console.log("[PakWheels] Extracting product details...");
    const productInfo = await page.evaluate(() => {
      const title = document.querySelector("h1")?.textContent?.trim() || "Unknown Product";

      // Image: try multiple sources
      let image = "";
      const imgEl = document.querySelector('img[itemprop="image"]');
      if (imgEl) {
        image = imgEl.getAttribute("src") || imgEl.getAttribute("data-original") || "";
        // If src is base64, look for data-src or fallback
        if (image.startsWith("data:")) {
          image = imgEl.getAttribute("data-original") || imgEl.getAttribute("data-src") || "";
        }
      }

      // Look for gallery if main image is not found
      if (!image) {
        const galleryImg = document.querySelector(".gallery.light-gallery img");
        if (galleryImg) {
          image = galleryImg.getAttribute("src") || galleryImg.getAttribute("data-original") || "";
        }
      }

      // Rating & Reviews Count
      const ratingEl = document.querySelector('meta[itemprop="ratingValue"]');
      const rating = ratingEl ? parseFloat(ratingEl.getAttribute("content") || "0") : 0;

      const reviewCountEl = document.querySelector('meta[itemprop="reviewCount"]');
      const totalReviews = reviewCountEl ? parseInt(reviewCountEl.getAttribute("content") || "0", 10) : 0;

      return { title, image, rating, totalReviews };
    });

    console.log(
      `[PakWheels] Product: ${productInfo.title}, Rating: ${productInfo.rating}, Reviews: ${productInfo.totalReviews}`,
    );

    const reviews: Review[] = [];

    // Attempt to find reviews
    // Since we couldn't find them in the static dump, we'll try a generic search strategies
    // 1. Look for schematic review items: [itemtype$="Review"]
    // 2. Look for common classes: .review, .user-review

    // Note: PakWheels might not show text reviews for accessories easily, or uses a specific widget.
    // We will attempt to scrape if found.

    // Updated extraction strategy based on DOM analysis
    console.log("[PakWheels] Extracting reviews...");

    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage && reviews.length < maxReviews) {
      console.log(`[PakWheels] Scraping page ${pageNum}...`);

      // Extract reviews from current page
      const extractedReviews = await page.evaluate(() => {
        const results: any[] = [];
        const potentialContainers = document.querySelectorAll("div.mb30");

        potentialContainers.forEach(container => {
          const reviewBox = container.querySelector(".border-light-blue.well-sm.br8");
          if (!reviewBox) return;

          const ratingContainer = reviewBox.querySelector(".rating");
          let rating = 0;
          if (ratingContainer) {
            const allStars = ratingContainer.querySelectorAll(".fa-star");
            const emptyStars = ratingContainer.querySelectorAll(".fa-star.non-filled");
            rating = allStars.length - emptyStars.length;
          }

          const bodyEl = reviewBox.querySelector(".mt20");
          const body = bodyEl?.textContent?.trim() || "";

          const footerEl = container.querySelector(".mt10.text-right.text-muted.small");
          let author = "Anonymous";
          let dateLine = "";

          if (footerEl && footerEl.textContent) {
            const text = footerEl.textContent.trim();
            const lastDashIndex = text.lastIndexOf("-");
            if (lastDashIndex !== -1) {
              author = text.substring(0, lastDashIndex).trim();
              dateLine = text.substring(lastDashIndex + 1).trim();
            } else {
              author = text;
            }
          }

          if (body) {
            results.push({ author, date: dateLine || new Date().toISOString(), body, rating });
          }
        });
        return results;
      });

      if (extractedReviews.length > 0) {
        console.log(`[PakWheels] Found ${extractedReviews.length} reviews on page ${pageNum}.`);
        for (const r of extractedReviews) {
          if (reviews.length >= maxReviews) break;
          reviews.push({
            id: `pw-${Date.now()}-${Math.random()}`,
            ...r,
            source: "pakwheels",
            helpfulCount: 0,
          });
        }
      } else {
        console.log(`[PakWheels] No reviews found on page ${pageNum}.`);
      }

      // Check for next page
      if (reviews.length < maxReviews) {
        const nextLink = await page.$('li.next_page a[rel="next"]');
        if (nextLink) {
          const href = await page.evaluate(el => el.getAttribute("href"), nextLink);
          if (href) {
            console.log(`[PakWheels] Navigating to next page: ${href}`);
            const nextUrl = href.startsWith("http") ? href : `https://www.pakwheels.com${href}`;

            try {
              await Promise.all([
                page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }),
                page.goto(nextUrl),
              ]);
              pageNum++;
            } catch (e) {
              console.error("[PakWheels] Pagination navigation failed:", e);
              hasNextPage = false;
            }
          } else {
            console.log("[PakWheels] Next page link found but has no href.");
            hasNextPage = false;
          }
        } else {
          console.log("[PakWheels] No next page link found. Finished.");
          hasNextPage = false;
        }
      } else {
        console.log(`[PakWheels] Reached max reviews limit (${maxReviews}).`);
        hasNextPage = false;
      }
    }

    if (reviews.length === 0) {
      console.log("[PakWheels] No individual review elements found matching standard selectors.");
      // If we have a high review count but no reviews found, it might be they are hidden or we lack the selector.
      // If we have a high review count but no reviews found, it might be they are hidden or we lack the selector.
      if (productInfo.totalReviews > 0) {
        console.log("[PakWheels] WARNING: Reviews exist but could not be extracted. Taking snapshot...");
        try {
          const fs = await import("fs");
          const path = await import("path");
          const { fileURLToPath } = await import("url");

          // Derive __dirname for ES modules
          const __filename = fileURLToPath(import.meta.url);
          const __dirname = path.dirname(__filename);

          const debugDir = path.resolve(__dirname, "../../../../debug_dumps");
          if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
          }

          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const dumpPath = path.join(debugDir, `pakwheels_dump_${timestamp}.html`);
          const screenshotPath = path.join(debugDir, `pakwheels_screenshot_${timestamp}.png`);

          // Save HTML
          const content = await page.content();
          await fs.promises.writeFile(dumpPath, content);

          // Save Screenshot
          const buffer = await page.screenshot({ fullPage: true, type: "png" });
          await fs.promises.writeFile(screenshotPath, buffer);

          console.log(`[PakWheels] Snapshot saved to:`);
          console.log(`HTML: ${dumpPath}`);
          console.log(`Image: ${screenshotPath}`);
        } catch (err) {
          console.error("[PakWheels] Failed to save snapshot:", err);
        }
      }
    }

    // Filter for 5-star reviews
    const fiveStarReviews = reviews.filter(r => r.rating >= 5);
    console.log(`[PakWheels] Extracted ${reviews.length} total reviews, ${fiveStarReviews.length} are 5-star.`);

    return {
      title: productInfo.title,
      image: productInfo.image,
      rating: productInfo.rating,
      totalReviews: productInfo.totalReviews,
      fiveStarReviews: fiveStarReviews.map(r => ({ text: r.body, rating: r.rating })),
    };
  } catch (error) {
    console.error("[PakWheels] Scraping failed:", error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}
