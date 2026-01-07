import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Browser, Page } from "puppeteer";
import waitFor from "../../utils/wait.js";

puppeteer.use(StealthPlugin());

/**
 * Local types for this scraper
 */
interface Review {
  text: string;
  rating: number;
}

interface ScrapingResult {
  title: string;
  rating: number | string;
  totalReviews: number | string;
  image: string;
  fiveStarReviews: Review[];
  fiveStarReviewCount: number;
  ratingBreakdown?: Record<number, number>;
}

interface ScraperConfig {
  maxReviews?: number;
  headless?: boolean;
  timeout?: number;
  userAgent?: string;
}

/**
 * Scrape BestBuy product page: click "See All Customer Reviews", then scrape reviews pages.
 * Returns product metadata and locally-filtered 5-star reviews.
 */
export async function scrapeBestBuyProduct(productUrl: string, config: ScraperConfig = {}): Promise<ScrapingResult> {
  const {
    maxReviews = 100,
    headless = true,
    timeout = 60000,
    userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  } = config;

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

    // Block fonts/media to speed up
    await page.setRequestInterception(true);
    page.on("request", req => {
      const t = req.resourceType();
      if (["font", "media"].includes(t)) req.abort();
      else req.continue();
    });

    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout });
    await waitFor(2500);

    // 3. Locate and click "See All Customer Reviews" or determining if we need to expand an accordion
    console.log("Looking for reviews trigger...");

    try {
      // Try multiple selectors for the reviews trigger
      const clicked = await page.evaluate(() => {
        // Strategy 1: The specific data-testid found in debugging
        const statsLink = document.querySelector('a[data-testid="rnr-stats-link"]') as HTMLElement;
        if (statsLink) {
          statsLink.click();
          // return "stats-link"; // Continue to try other clicks just in case
        }

        // Strategy 2: Find the "Customer Reviews" or "Reviews" accordion button
        // Best Buy often uses a button with child h2 or h3
        const buttons = Array.from(document.querySelectorAll("button"));
        const reviewAccordion = buttons.find(b => {
          const t = b.innerText || "";
          return t.includes("Reviews") && (t.includes("Customer") || t.includes("("));
        });
        if (reviewAccordion) {
          reviewAccordion.click();
          return "accordion-button";
        }

        // Strategy 3: Look for the specific class used by Q&A accordion and find its sibling?
        // Q&A button class was: c-button-unstyled font-weight-medium w-full flex justify-content-between align-items-center
        const accordions = Array.from(document.querySelectorAll("button.c-button-unstyled.w-full"));
        const reviewAcc = accordions.find(b => b.textContent?.includes("Reviews"));
        if (reviewAcc) {
          reviewAcc.click();
          return "generic-accordion";
        }

        return statsLink ? "stats-link-only" : null;
      });

      console.log(`Clicked reviews trigger: ${clicked}`);

      // Force scroll to bottom to ensure lazy loading triggers
      await page.evaluate(async () => {
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, 2000));
        window.scrollTo(0, document.body.scrollHeight / 2); // Scroll back up slightly
      });

      await new Promise(r => setTimeout(r, 3000)); // Wait for lazy load
    } catch (e) {
      console.log("Error interacting with review controls:", e);
    }

    // 4. Check if reviews exist; if not, try direct navigation to reviews page using SKU
    const hasReviews = await page.$(".ugc-review, .review-item, [data-review-id]");
    if (!hasReviews) {
      console.log("No reviews found on product page. Attempting direct navigation to reviews page...");
      try {
        // Extract SKU
        const sku = await page.evaluate(() => {
          // Selector logic for SKU
          const skuEl = document.querySelector(".sku .product-data-value, .disclaimer") as HTMLElement;
          if (skuEl && skuEl.textContent) {
            const m = skuEl.textContent.match(/SKU:\s*(\d+)/i);
            return m ? m[1] : null;
          }
          return null;
        });

        if (sku) {
          console.log(`Extracted SKU: ${sku}. Navigating to reviews page...`);
          // Best Buy Reviews URL pattern: /site/reviews/{slug}/{sku}
          // We can often use a dummy slug
          const reviewsUrl = `https://www.bestbuy.com/site/reviews/product/${sku}`;
          await page.goto(reviewsUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
          await waitFor(2000);
        } else {
          console.log("Could not extract SKU to build reviews URL.");
        }
      } catch (err) {
        console.log("Direct navigation failed:", err);
      }
    }

    // Basic product metadata (title + image)
    const productData = await page.evaluate(() => {
      const data: any = {};
      const titleSelectors = [".sku-title h1", "h1.sku-title", "h1", '[data-testid="product-title"]'];
      for (const s of titleSelectors) {
        const el = document.querySelector(s);
        if (el && el.textContent && el.textContent.trim()) {
          data.title = el.textContent.trim();
          break;
        }
      }
      const img = document.querySelector(
        'img.product-image, img.primary-image, img[itemprop="image"]',
      ) as HTMLImageElement | null;
      if (img && (img.src || (img as any).dataset?.src)) data.image = img.src || (img as any).dataset?.src;
      return data;
    });

    // If we're on the reviews page, the title and ratings may be in different selectors — try to extract them
    try {
      const reviewPageMeta = await page.evaluate(() => {
        const data: any = {};
        // title on reviews page
        const titleEl = document.querySelector("h2.heading-6.product-title a, h2.heading-6.product-title");
        if (titleEl && titleEl.textContent && titleEl.textContent.trim()) data.title = titleEl.textContent.trim();

        // rating and total reviews - try a few BestBuy-specific patterns
        // 1) Newer UGC block: .ugc-rating-stars-v3 .overall-rating and .reviews-and-stars
        const overall = document.querySelector(".ugc-rating-stars-v3 .overall-rating") as HTMLElement | null;
        if (overall && overall.textContent && overall.textContent.trim()) {
          const rv = parseFloat(overall.textContent.trim());
          if (!Number.isNaN(rv)) data.rating = rv;
        }

        const reviewsAndStarsSr = document.querySelector(
          ".ugc-rating-stars-v3 .reviews-and-stars p.sr-only",
        ) as HTMLElement | null;
        if (reviewsAndStarsSr && reviewsAndStarsSr.textContent) {
          const txt = reviewsAndStarsSr.textContent;
          const rm = txt.match(/([0-9]+\.?[0-9]*)\s*out of\s*5/i);
          if (rm) data.rating = parseFloat(rm[1]);
          const cm = txt.match(/([\d,]+)\s*reviews?/i);
          if (cm) data.totalReviews = parseInt(cm[1].replace(/,/g, ""), 10);
        }

        // 2) older/sibling selectors
        const ratingEl = document.querySelector(".ugc-c-review-average, .c-review-average") as HTMLElement | null;
        if (!data.rating && ratingEl && ratingEl.textContent) {
          const rv = parseFloat(ratingEl.textContent.trim());
          if (!Number.isNaN(rv)) data.rating = rv;
        }

        const totalEl = document.querySelector(
          ".c-reviews.ugc-review-container, .c-reviews, .c-reviews-text",
        ) as HTMLElement | null;
        if (!data.totalReviews && totalEl && totalEl.textContent) {
          const m = (totalEl.textContent || "").match(/([\d,]+)/);
          if (m) data.totalReviews = parseInt(m[1].replace(/,/g, ""), 10);
        }

        // 3) As fallback, parse the visually-hidden summary paragraph
        if ((!data.rating || !data.totalReviews) && document.querySelector(".c-ratings-reviews")) {
          const p = document.querySelector(".c-ratings-reviews p.visually-hidden") as HTMLElement | null;
          if (p && p.textContent) {
            const txt = p.textContent;
            const rm = txt.match(/([0-9]+\.?[0-9]*)\s*out of\s*5/i);
            if (rm && !data.rating) data.rating = parseFloat(rm[1]);
            const cm = txt.match(/([\d,]+)\s*reviews?/i);
            if (cm && !data.totalReviews) data.totalReviews = parseInt(cm[1].replace(/,/g, ""), 10);
          }
        }

        return data;
      });

      if (reviewPageMeta.title) productData.title = reviewPageMeta.title;
      if (reviewPageMeta.rating) productData.rating = reviewPageMeta.rating;
      if (reviewPageMeta.totalReviews) productData.totalReviews = reviewPageMeta.totalReviews;
    } catch (e) {
      // ignore extraction errors here
    }

    // Extract rating breakdown (counts per star) from the rating-bar if present
    try {
      const breakdown = await page.evaluate(() => {
        const out: Record<number, number> = {};
        // selectors that wrap each rating bar
        const wrappers = Array.from(
          document.querySelectorAll(".rating-bar .c-checkbox-wrapper, .rating-bar-brix-wrapper"),
        ) as HTMLElement[];
        if (wrappers.length === 0) {
          // alternative: look for rating-bar wrappers directly
          const alt = Array.from(document.querySelectorAll(".rating-bar")) as HTMLElement[];
          for (const a of alt) {
            const w = Array.from(a.querySelectorAll(".c-checkbox-wrapper")) as HTMLElement[];
            wrappers.push(...w);
          }
        }

        wrappers.forEach(w => {
          // try input id parsing
          const inp = w.querySelector("input") as HTMLInputElement | null;
          let rating: number | null = null;
          if (inp && inp.id) {
            const m = inp.id.match(/rating-bar-(\d)-checkbox/);
            if (m) rating = parseInt(m[1], 10);
          }

          // fallback: span.rating inside label
          if (!rating) {
            const sp = w.querySelector(".rating") as HTMLElement | null;
            if (sp && sp.textContent) {
              const n = parseInt(sp.textContent.trim(), 10);
              if (!Number.isNaN(n)) rating = n;
            }
          }

          // extract count from .review-count or sr-only text
          let count = 0;
          const rc = w.querySelector(".review-count") as HTMLElement | null;
          if (rc && rc.textContent) {
            const m = rc.textContent.match(/[\d,]+/);
            if (m) count = parseInt(m[0].replace(/,/g, ""), 10);
          } else {
            const sr = w.querySelector(".sr-only") as HTMLElement | null;
            if (sr && sr.textContent) {
              const mm = sr.textContent.match(/([\d,]+)\s*reviews?/i);
              if (mm) count = parseInt(mm[1].replace(/,/g, ""), 10);
            }
          }

          if (rating) out[rating] = count;
        });

        return out;
      });
      console.log("Extracted rating breakdown:", breakdown);
      productData.ratingBreakdown = breakdown;
    } catch (e) {
      // ignore
    }
    // Try to apply the 5-star filter (click the checkbox/label) and wait for the list to update
    console.log("Attempting to apply 5-star filter if present...");
    try {
      const filterClicked = await page.evaluate(() => {
        const inp = document.querySelector(
          'input.rating-bar-checkbox[id^="rating-bar-5-checkbox"], input[id^="rating-bar-5-checkbox"]',
        ) as HTMLInputElement | null;
        if (inp) {
          if (!inp.checked)
            try {
              inp.click();
            } catch (e) {}
          return true;
        }

        const lbl = Array.from(
          document.querySelectorAll('label[for^="rating-bar-5-checkbox"], label.rating-bar-label'),
        ).find(l => (l.textContent || "").toLowerCase().includes("5")) as HTMLElement | undefined;
        if (lbl) {
          try {
            lbl.click();
          } catch (e) {}
          return true;
        }

        const byData = Array.from(document.querySelectorAll("input[data-track]")).find(i =>
          (i.getAttribute("data-track") || "").toLowerCase().includes("5 star"),
        ) as HTMLElement | undefined;
        if (byData) {
          try {
            (byData as HTMLElement).click();
          } catch (e) {}
          return true;
        }

        return false;
      });

      if (filterClicked) {
        const beforeCount = await page.$$eval("[data-review-id], .review-item, .ugc-review", els => els.length);
        try {
          await page.waitForFunction(
            (sel, before) => document.querySelectorAll(sel).length !== before,
            { timeout: 6000 },
            "[data-review-id], .review-item, .ugc-review",
            beforeCount,
          );
        } catch {}
        await waitFor(800);
        console.log("5-star filter applied or attempted");
      } else {
        console.log("5-star filter control not found");
      }
    } catch (e) {
      console.log("Error applying 5-star filter:", (e as Error).message);
    }

    // Scrape reviews with pagination/load-more handling
    console.log("Scraping BestBuy reviews...");
    const allReviews: Review[] = [];
    let pageIndex = 0;
    let noChangeCount = 0;

    // Helper to extract reviews on current page
    async function extractVisibleReviews(): Promise<Array<{ text: string; rating: number }>> {
      return page.evaluate(() => {
        const boxes = Array.from(
          document.querySelectorAll("[data-review-id], .review-item, .ugc-review"),
        ) as HTMLElement[];
        const out: Array<{ text: string; rating: number }> = [];

        boxes.forEach(box => {
          // Try aria-label rating like '5 out of 5'
          let rating = 0;
          const aria = Array.from(box.querySelectorAll("[aria-label]")) as HTMLElement[];
          for (const a of aria) {
            const al = (a.getAttribute("aria-label") || "").trim();
            const m = al.match(/(\d+(?:\.\d+)?)\s*(?:out of|out of 5|stars?)/i);
            if (m) {
              rating = parseFloat(m[1]);
              break;
            }
          }

          // fallback: look for text nodes that say 'out of 5'
          if (!rating) {
            const txt = (box.textContent || "").match(/(\d+(?:\.\d+)?)\s*(?:out of|out of 5|stars?)/i);
            if (txt) rating = parseFloat(txt[1]);
          }

          // fallback: count star icons (filled)
          if (!rating) {
            const filled =
              box.querySelectorAll(".c-review-average, .ugc-rating, .star-rating, svg[aria-hidden]")?.length || 0;
            if (filled) rating = Math.min(5, filled);
          }

          // Extract review text
          let text = "";
          const textSelectors = [".review-body", ".review-text", ".ugc-review-body", ".review-text__paragraph", "p"];
          for (const s of textSelectors) {
            const el = box.querySelector(s) as HTMLElement | null;
            if (el && el.textContent && el.textContent.trim()) {
              text = el.textContent.trim();
              break;
            }
          }

          // fallback: trimmed box text (avoid very short noise)
          if (!text) {
            const t = (box.textContent || "").trim();
            if (t && t.length > 10 && t.length < 2000) text = t;
          }

          if (text) out.push({ text, rating: Math.round((rating || 0) * 10) / 10 });
        });

        return out;
      });
    }

    while (allReviews.length < maxReviews && noChangeCount < 3) {
      const before = allReviews.length;
      const batch = await extractVisibleReviews();
      for (const r of batch) {
        if (allReviews.length >= maxReviews) break;
        if (!allReviews.find(rr => rr.text === r.text)) allReviews.push(r);
      }

      if (allReviews.length === before) noChangeCount++;
      else noChangeCount = 0;
      console.log(`Collected ${allReviews.length} reviews (page ${pageIndex})`);

      if (allReviews.length >= maxReviews) break;

      // Try to navigate to the next page of reviews (prefer anchor with data-track="Page next")
      const nextResult = await page.evaluate(() => {
        // Prefer the next page anchor
        const nextAnchor = document.querySelector(
          'a[data-track="Page next"], a[title*="next Page"]',
        ) as HTMLAnchorElement | null;
        if (nextAnchor && nextAnchor.getAttribute("aria-disabled") !== "true") {
          return nextAnchor.getAttribute("href");
        }

        // If not, try common pagination selectors and click them; indicate a click occurred
        const nextSelectors = [
          'button[aria-label*="Next"], button[aria-label*="next"]',
          'a[rel="next"]',
          'button[data-qa="load-more-reviews"]',
          'button.c-button[data-qa="pagination-next"]',
        ];
        for (const s of nextSelectors) {
          const el = document.querySelector(s) as HTMLElement | null;
          if (el && !(el as HTMLButtonElement).disabled) {
            try {
              (el as HTMLElement).click();
            } catch {}
            return "__clicked__";
          }
        }

        // Fallback: any 'show more' / 'more reviews' link or button
        const candidates = Array.from(document.querySelectorAll("a, button")) as HTMLElement[];
        const btn = candidates.find(b => {
          const t = (b.textContent || "").trim().toLowerCase();
          return t.includes("show more") || t.includes("more reviews") || t === "next";
        });
        if (btn) {
          try {
            btn.click();
          } catch (e) {}
          return "__clicked__";
        }

        return null;
      });

      if (nextResult) {
        if (nextResult === "__clicked__") {
          // clicked a button; wait for new content
          try {
            await page.waitForFunction(
              (sel, before) => document.querySelectorAll(sel).length > before,
              { timeout: 5000 },
              "[data-review-id], .review-item, .ugc-review",
              before,
            );
            await waitFor(600);
            pageIndex++;
            continue;
          } catch {
            await waitFor(800);
          }
        } else {
          // href returned -> navigate to that page
          try {
            const href = nextResult as string;
            const nextUrl = href.startsWith("http") ? href : new URL(href, page.url()).toString();
            await page.goto(nextUrl, { waitUntil: "domcontentloaded" });
            await waitFor(800);
            pageIndex++;
            continue;
          } catch {
            await waitFor(800);
          }
        }
      }

      // As a fallback, try scrolling to bottom to trigger lazy load
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await waitFor(800);
    }

    const fiveStarReviews = allReviews.filter(r => r.rating === 5).slice(0, maxReviews);

    const result: ScrapingResult = {
      title: (productData.title as string) || "N/A",
      rating: productData.rating || "N/A",
      totalReviews: productData.totalReviews || allReviews.length,
      image: (productData.image as string) || "N/A",
      fiveStarReviews: fiveStarReviews,
      fiveStarReviewCount: fiveStarReviews.length,
    };

    console.log(`Found ${result.fiveStarReviewCount} 5-star reviews.`);
    // print results
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    console.error("BestBuy scraper error:", (err as Error).message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}
