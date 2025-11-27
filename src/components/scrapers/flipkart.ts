import puppeteer, { Browser } from "puppeteer";
import waitFor from "../../utils/wait.js";

interface Review {
  text: string;
  rating: number;
  reviewer?: string;
  date?: string;
  image?: string;
  recommends?: boolean;
}

interface ScrapingResult {
  title: string;
  image: string;
  rating: number;
  totalReviews: number;
  fiveStarReviews: Review[];
  fiveStarReviewCount: number;
  ratingBreakdown: Record<number, number>;
}

interface ScraperConfig {
  maxReviews?: number;
  headless?: boolean;
  timeout?: number;
  userAgent?: string;
}

export async function scrapeFlipkartProduct(productUrl: string, config: ScraperConfig = {}): Promise<ScrapingResult> {
  const {
    maxReviews = 100,
    headless = true,
    timeout = 60000,
    userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  } = config;

  let browser: Browser | undefined;
  const result: ScrapingResult = {
    title: "",
    image: "",
    rating: 0,
    totalReviews: 0,
    fiveStarReviews: [],
    fiveStarReviewCount: 0,
    ratingBreakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
  };

  try {
    browser = await puppeteer.launch({
      headless: headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);

    // Set viewport
    await page.setViewport({ width: 1366, height: 768 });

    // Navigate to product page
    console.log(`Navigating to ${productUrl}`);
    await page.goto(productUrl, {
      waitUntil: "networkidle2",
      timeout: timeout,
    });

    // Extract Product Metadata
    try {
      await page.waitForSelector("span.VU-ZEz", { timeout: 10000 });

      result.title = await page.$eval("span.VU-ZEz", (el: Element) => el.textContent?.trim() || "");

      // Try multiple image selectors
      const imageSelectors = ["img.DByuf4", "img._396cs4"];
      for (const selector of imageSelectors) {
        const img = await page.$(selector);
        if (img) {
          result.image = await page.$eval(selector, (el: Element) => el.getAttribute("src") || "");
          break;
        }
      }

      // Rating
      const ratingEl = await page.$("div.XQDdHH");
      if (ratingEl) {
        const ratingText = await page.$eval("div.XQDdHH", (el: Element) => el.textContent?.trim() || "0");
        result.rating = parseFloat(ratingText);
      }

      // Total Reviews
      const totalReviewsEl = await page.$("span.Wphh3N");
      if (totalReviewsEl) {
        const totalReviewsText = await page.$eval("span.Wphh3N", (el: Element) => el.textContent?.trim() || "");
        // Format: "3,443 Ratings & 367 Reviews"
        const match = totalReviewsText.match(/(\d+(?:,\d+)*)\s*Reviews/i);
        if (match) {
          result.totalReviews = parseInt(match[1].replace(/,/g, ""), 10);
        }
      }
    } catch (e) {
      console.error("Error extracting product metadata:", e);
    }

    // Navigate to All Reviews Page
    let reviewsUrl = "";
    try {
      // Look for the "All reviews" link
      const allReviewsLink = await page.$("div._3UAT2v._16PBlm span");
      if (allReviewsLink) {
        // Find the anchor tag by traversing up from the div
        reviewsUrl = await page.evaluate(() => {
          const div = document.querySelector("div._3UAT2v._16PBlm");
          if (div) {
            const anchor = div.closest("a");
            return anchor ? anchor.href : "";
          }
          return "";
        });
      }

      if (!reviewsUrl) {
        const links = await page.$$eval("a", (as: Element[]) => as.map((a: Element) => (a as HTMLAnchorElement).href));
        reviewsUrl = links.find(l => l.includes("/product-reviews/")) || "";
      }
    } catch (e) {
      console.log("Could not find reviews link, trying current URL if it is already a reviews page");
    }

    if (reviewsUrl) {
      console.log(`Navigating to reviews page: ${reviewsUrl}`);
      await page.goto(reviewsUrl, { waitUntil: "networkidle2", timeout });
    } else {
      console.log("Could not find dedicated reviews page, attempting to scrape from current page");
    }

    // Scrape Reviews
    const reviews: Review[] = [];
    let hasNextPage = true;
    let pageNum = 1;

    while (hasNextPage && reviews.length < maxReviews) {
      console.log(`Scraping reviews page ${pageNum}`);

      try {
        await page.waitForSelector("div.col.EPCmJX.Ma1fCG", { timeout: 5000 });
      } catch (e) {
        console.log("No reviews found on this page");
        break;
      }

      const reviewElements = await page.$$("div.col.EPCmJX.Ma1fCG");

      for (const el of reviewElements) {
        if (reviews.length >= maxReviews) break;

        try {
          // Rating
          let rating = 0;
          const ratingEl = await el.$("div.XQDdHH.Ga3i8K");
          if (ratingEl) {
            const ratingText = await el.$eval("div.XQDdHH.Ga3i8K", (e: Element) => e.textContent?.trim() || "0");
            rating = parseFloat(ratingText);
          }

          if (rating === 5) {
            // Text
            let text = "";
            const textEl = await el.$("div.ZmyHeo div div");
            if (textEl) {
              text = await el.$eval("div.ZmyHeo div div", (e: Element) => e.textContent?.trim() || "");
              text = text.replace("READ MORE", "").trim();
            }

            // Reviewer
            let reviewer = "";
            const reviewerEl = await el.$("p._2NsDsF");
            if (reviewerEl) {
              reviewer = await el.$eval("p._2NsDsF", (e: Element) => e.textContent?.trim() || "");
            }

            // Date
            let date = "";
            const dateEls = await el.$$("p._2NsDsF");
            if (dateEls.length > 1) {
              date = await page.evaluate((e: Element) => e.textContent?.trim() || "", dateEls[dateEls.length - 1]);
            }

            reviews.push({
              text,
              rating,
              reviewer,
              date,
            });
          }
        } catch (e) {
          console.error("Error extracting review:", e);
        }
      }

      // Pagination
      const nextButton = await page.$("a._9QVEpD");
      if (nextButton) {
        const nextText = await page.evaluate((el: Element) => el.textContent, nextButton);
        if (nextText?.includes("Next")) {
          await nextButton.click();
          await waitFor(3000);
          pageNum++;
        } else {
          hasNextPage = false;
        }
      } else {
        hasNextPage = false;
      }
    }

    result.fiveStarReviews = reviews;
    result.fiveStarReviewCount = reviews.length;

    // Rating Breakdown
    try {
      const countElements = await page.$$("div.BArk-j");
      if (countElements.length >= 5) {
        const getCount = async (i: number) => {
          const txt = await page.evaluate((el: Element) => el.textContent || "0", countElements[i]);
          return parseInt(txt.replace(/,/g, ""), 10);
        };
        result.ratingBreakdown[5] = await getCount(0);
        result.ratingBreakdown[4] = await getCount(1);
        result.ratingBreakdown[3] = await getCount(2);
        result.ratingBreakdown[2] = await getCount(3);
        result.ratingBreakdown[1] = await getCount(4);
      }
    } catch (e) {
      console.log("Could not extract rating breakdown");
    }
  } catch (error) {
    console.error("Flipkart scraping failed:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return result;
}
