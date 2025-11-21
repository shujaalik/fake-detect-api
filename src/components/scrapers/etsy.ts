import puppeteer, { Browser, Page } from "puppeteer";
import waitFor from "../../utils/wait.js";

/**
 * Interface for a single review
 */
interface Review {
  text: string;
  rating: number;
  reviewer?: string;
  date?: string;
  image?: string;
  recommends?: boolean;
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
  ratingBreakdown?: Record<number, number>;
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
 * Scrapes product information and reviews from an Etsy product page
 * @param productUrl - The full URL of the Etsy product
 * @param config - Configuration options for scraping
 * @returns Promise containing the scraped product data and reviews
 */
export async function scrapeEtsyProduct(productUrl: string, config: ScraperConfig = {}): Promise<ScrapingResult> {
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
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-blink-features=AutomationControlled",
      ],
      executablePath: process.env.CHROME_BIN || undefined,
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
      waitUntil: "networkidle2",
      timeout: timeout,
    });

    // Wait for page to fully stabilize (Etsy has client-side navigation)
    await waitFor(5000);

    console.log("Extracting product information...");

    // Extract product information with retry logic (Etsy pages can have client-side navigation)
    let productData: any = {};
    let retries = 3;
    while (retries > 0) {
      try {
        productData = await page.evaluate(() => {
          const data: any = {};

          // Get product title - use Etsy-specific selector
          const titleSelectors = [
            'h1[data-buy-box-listing-title="true"]',
            "h1[data-buy-box-listing-title]",
            "h1.wt-text-body",
            "h1",
          ];
          for (const selector of titleSelectors) {
            const titleEl = document.querySelector(selector);
            if (titleEl && titleEl.textContent) {
              const titleText = titleEl.textContent.trim().replace(/\s+/g, " ");
              if (titleText) {
                data.title = titleText;
                break;
              }
            }
          }

          // Get product image - use carousel image selector
          const imageSelectors = [
            "img.carousel-image[data-carousel-first-image]",
            "img.carousel-image",
            'img[data-perf-group="main-product-image"]',
            "img.wt-max-width-full",
          ];
          for (const selector of imageSelectors) {
            const imgEl = document.querySelector(selector) as HTMLImageElement | null;
            if (imgEl && imgEl.src) {
              data.image = imgEl.src;
              break;
            }
          }

          // Try to get initial rating and review count from page
          const ratingEl = document.querySelector("[data-rating]");
          if (ratingEl) {
            const rating = ratingEl.getAttribute("data-rating");
            if (rating) data.rating = parseFloat(rating);
          }

          return data;
        });
        break; // Success, exit retry loop
      } catch (e) {
        retries--;
        if (retries === 0) {
          console.log("Failed to extract product data after retries:", (e as Error).message);
          throw e;
        }
        console.log(`Retry extracting product data (${3 - retries}/3)...`);
        await waitFor(2000);
      }
    }

    console.log("Product data extracted:");
    console.log("- Title:", productData.title || "Not found");
    console.log("- Image URL:", productData.image || "Not found");

    // Scroll down to reviews section
    console.log("\nScrolling to reviews section...");
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight / 2);
    });
    await waitFor(2000);

    // Click "View all reviews" button to open modal
    console.log("Opening reviews modal...");
    try {
      const modalOpened = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button")) as HTMLElement[];
        const viewAllButton = buttons.find(
          btn =>
            btn.getAttribute("data-view-all-reviews-button") === "same-listing" ||
            btn.textContent?.includes("View all reviews"),
        );
        if (viewAllButton) {
          viewAllButton.click();
          return true;
        }
        return false;
      });

      if (modalOpened) {
        console.log("Clicked 'View all reviews' button");
        await waitFor(2000);
      } else {
        console.log("Could not find 'View all reviews' button");
      }
    } catch (e) {
      console.log("Error opening modal:", (e as Error).message);
    }

    // Extract rating histogram from modal
    console.log("Extracting rating histogram...");
    try {
      // Wait for histogram to appear in modal
      try {
        await page.waitForSelector(".reviews__histogram", { timeout: 5000 });
        await waitFor(1000); // Give it a moment to fully render
      } catch (e) {
        console.log("Histogram not found, will try to extract anyway");
      }

      const histogram = await page.evaluate(() => {
        const data: any = {};

        // Get overall rating and total ratings
        const ratingText = document.querySelector(".wt-text-heading-large");
        if (ratingText && ratingText.textContent) {
          const rating = parseFloat(ratingText.textContent.trim());
          if (!isNaN(rating)) data.rating = rating;
        }

        // Try multiple approaches to find total reviews text "57 ratings"
        // Approach 1: Direct selector in rating summary area
        let totalText = document.querySelector(".wt-text-body-smaller.wt-sem-text-secondary");

        // Approach 2: Search within the flex container that has the rating
        if (!totalText || !totalText.textContent?.match(/\d+\s*ratings?/i)) {
          const containers = document.querySelectorAll(".wt-display-flex-xs");
          for (const container of Array.from(containers)) {
            const p = container.querySelector("p.wt-text-body-smaller.wt-sem-text-secondary");
            if (p && p.textContent && /\d+\s*ratings?/i.test(p.textContent)) {
              totalText = p;
              break;
            }
          }
        }

        // Approach 3: Search all matching elements for one with "ratings" text
        if (!totalText || !totalText.textContent?.match(/\d+\s*ratings?/i)) {
          const allTextElements = document.querySelectorAll("p.wt-text-body-smaller, .wt-text-body-smaller");
          for (const el of Array.from(allTextElements)) {
            if (el.textContent && /\d+\s*ratings?/i.test(el.textContent)) {
              totalText = el;
              break;
            }
          }
        }

        if (totalText && totalText.textContent) {
          // Extract number from text like "57 ratings" or "57 rating"
          const match = totalText.textContent.match(/(\d+)\s*ratings?/i);
          if (match) {
            data.totalReviews = parseInt(match[1], 10);
            console.log("Found totalReviews:", data.totalReviews, "from text:", totalText.textContent.trim());
          }
        }

        // Extract histogram breakdown - percentages to be converted to counts
        const breakdownPercentages: Record<number, number> = {};
        const rows = Array.from(document.querySelectorAll(".reviews__histogram-row")) as HTMLElement[];

        rows.forEach(row => {
          const ratingValue = row.getAttribute("data-rating-value");
          const percentageEl = row.querySelector(".reviews__histogram-percentage");

          if (ratingValue && percentageEl && percentageEl.textContent) {
            const rating = parseInt(ratingValue, 10);
            const percentageText = percentageEl.textContent.trim().replace("%", "");
            const percentage = parseInt(percentageText, 10);

            if (!isNaN(rating) && !isNaN(percentage)) {
              breakdownPercentages[rating] = percentage;
            }
          }
        });

        // Convert percentages to actual counts if we have total reviews
        if (data.totalReviews && Object.keys(breakdownPercentages).length > 0) {
          const breakdown: Record<number, number> = {};
          let totalCalculated = 0;

          // Calculate counts for each rating
          for (let i = 5; i >= 1; i--) {
            const percentage = breakdownPercentages[i] || 0;
            const count = Math.round((percentage / 100) * data.totalReviews);
            breakdown[i] = count;
            totalCalculated += count;
          }

          // Adjust for rounding errors - add/subtract difference to highest rating
          const diff = data.totalReviews - totalCalculated;
          if (diff !== 0) {
            breakdown[5] = (breakdown[5] || 0) + diff;
          }

          data.ratingBreakdown = breakdown;
        }

        return data;
      });

      if (histogram.rating) productData.rating = histogram.rating;
      if (histogram.totalReviews) productData.totalReviews = histogram.totalReviews;
      if (histogram.ratingBreakdown) productData.ratingBreakdown = histogram.ratingBreakdown;

      console.log("Rating histogram extracted:");
      console.log("- Rating:", productData.rating);
      console.log("- Total Reviews:", productData.totalReviews);
      console.log("- Breakdown:", productData.ratingBreakdown);
    } catch (e) {
      console.log("Could not extract rating histogram:", (e as Error).message);
    }

    // Sort reviews by highest rating
    console.log("Sorting reviews by highest rating...");
    try {
      const sorted = await page.evaluate(() => {
        const sortButton = document.querySelector(".sort-reviews-trigger") as HTMLElement | null;
        if (sortButton) {
          sortButton.click();
          return true;
        }
        return false;
      });

      if (sorted) {
        console.log("Clicked sort button");
        await waitFor(1000);

        // Select "Highest rating" option from menu
        await page.evaluate(() => {
          const menuItems = Array.from(document.querySelectorAll(".wt-menu__item, [role='menuitem']")) as HTMLElement[];
          const highestRatingItem = menuItems.find(
            item =>
              item.textContent?.toLowerCase().includes("highest") || item.textContent?.toLowerCase().includes("rating"),
          );
          if (highestRatingItem) {
            highestRatingItem.click();
          }
        });
        await waitFor(1500);
        console.log("Selected highest rating sort");
      }
    } catch (e) {
      console.log("Could not sort reviews:", (e as Error).message);
    }

    // Scrape reviews
    console.log("Scraping reviews...");
    const allReviews: Review[] = [];
    let noChangeCount = 0;
    let pageCount = 0;

    while (allReviews.length < maxReviews && noChangeCount < 3 && pageCount < 20) {
      const reviewsBatch = await page.evaluate(() => {
        const reviews: Array<{
          text: string;
          rating: number;
          reviewer?: string;
          date?: string;
          image?: string;
          recommends?: boolean;
        }> = [];

        // Find all review containers
        const reviewContainers = Array.from(document.querySelectorAll(".wt-max-width-full")) as HTMLElement[];

        reviewContainers.forEach(container => {
          // Check if this is actually a review container (has rating input)
          const ratingInput = container.querySelector('input[name="rating"]') as HTMLInputElement | null;
          if (!ratingInput) return;

          const review: any = {};

          // Get rating from input value
          const ratingValue = ratingInput.value;
          if (ratingValue) {
            review.rating = parseFloat(ratingValue);
          }

          // Check if recommends
          const recommendsEl = container.querySelector(".wt-text-slime");
          if (recommendsEl && recommendsEl.textContent?.includes("Recommends")) {
            review.recommends = true;
          }

          // Get reviewer name
          const reviewerLink = container.querySelector("[data-review-username]") as HTMLElement | null;
          if (reviewerLink && reviewerLink.textContent) {
            review.reviewer = reviewerLink.textContent.trim();
          }

          // Get date
          const dateElements = container.querySelectorAll("p.wt-text-body-small");
          dateElements.forEach(el => {
            const text = el.textContent || "";
            // Look for date pattern (e.g., "19 Nov, 2025")
            if (/\d{1,2}\s+\w+,?\s+\d{4}/.test(text)) {
              const match = text.match(/(\d{1,2}\s+\w+,?\s+\d{4})/);
              if (match) review.date = match[1].trim();
            }
          });

          // Get review text
          const textContainers = container.querySelectorAll(".wt-text-body");
          textContainers.forEach(el => {
            const text = el.textContent?.trim();
            if (text && text.length > 10 && !review.text) {
              review.text = text;
            }
          });

          // Get review image if present
          const reviewImage = container.querySelector("img[alt*='added a photo']") as HTMLImageElement | null;
          if (reviewImage && reviewImage.src) {
            review.image = reviewImage.src;
          }

          // Only add if we have text and rating
          if (review.text && review.rating) {
            reviews.push(review);
          }
        });

        return reviews;
      });

      const before = allReviews.length;
      for (const r of reviewsBatch) {
        if (allReviews.length >= maxReviews) break;
        // Deduplicate by text
        if (!allReviews.find(rr => rr.text === r.text)) {
          allReviews.push(r);
        }
      }

      if (allReviews.length === before) {
        noChangeCount++;
      } else {
        noChangeCount = 0;
      }

      console.log(`Collected ${allReviews.length} reviews so far...`);

      if (allReviews.length >= maxReviews) break;

      // Try to click next button for pagination
      const nextClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button.wt-action-group__item")) as HTMLElement[];
        const nextButton = buttons.find(btn => {
          const screenReaderText = btn.querySelector(".wt-screen-reader-only");
          return screenReaderText && screenReaderText.textContent?.includes("Next");
        });

        if (nextButton) {
          nextButton.click();
          return true;
        }
        return false;
      });

      if (nextClicked) {
        console.log("Clicked next page button");
        await waitFor(2000);
        pageCount++;
      } else {
        console.log("No next button found, ending pagination");
        break;
      }
    }

    // Filter for 5-star reviews
    const fiveStarReviews = allReviews.filter(r => r.rating === 5).slice(0, maxReviews);

    console.log(`Found ${fiveStarReviews.length} 5-star reviews after collecting all reviews.`);

    // Compile final result
    const result: ScrapingResult = {
      title: productData.title || "N/A",
      rating: productData.rating || "N/A",
      totalReviews: productData.totalReviews || "N/A",
      image: productData.image || "N/A",
      fiveStarReviews: fiveStarReviews,
      fiveStarReviewCount: fiveStarReviews.length,
      ratingBreakdown: productData.ratingBreakdown || undefined,
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
    console.error("Error scraping Etsy:", err.message);
    console.error(err.stack);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
