import puppeteer, { Browser, Page } from "puppeteer";
import waitFor from "../utils/wait.js";

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
    userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  } = config;

  let browser: Browser | undefined;

  try {
    browser = await puppeteer.launch({
      headless: headless ? "shell" : false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      executablePath: process.env.CHROME_BIN || undefined,
    });

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

    // Click "See All Customer Reviews" (button or link)
    console.log("Looking for 'See All Customer Reviews' button...");

    // Wait until the button/link/span with the expected text appears (helps with dynamic rendering)
    try {
      await page.waitForFunction(
        () => {
          const sel = 'button[role="link"] span, button span, a';
          const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
          return els.some(e => {
            const t = (e.textContent || "").trim().toLowerCase();
            return t.includes("see all customer reviews") || t.includes("see all reviews");
          });
        },
        { timeout: 10000 },
      );
      console.log("'See All Customer Reviews' control detected (or timed in). Proceeding to click logic...");
    } catch (e) {
      // timeout or other - we'll still try the click logic below
      console.log("Timed out waiting for 'See All Customer Reviews' control; attempting best-effort click");
    }

    try {
      const clicked = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll("a, button")) as HTMLElement[];
        const btn = candidates.find(el => {
          const txt = (el.textContent || "").trim().toLowerCase();
          return (
            txt === "see all customer reviews" ||
            txt.includes("see all customer reviews") ||
            txt === "see all reviews" ||
            txt.includes("see all reviews")
          );
        });
        if (btn) {
          (btn as HTMLElement).click();
          return true;
        }
        // Some pages have a link with href to /site/reviews/... try to find it
        const link = Array.from(document.querySelectorAll("a")).find(a =>
          (a.getAttribute("href") || "").includes("/site/reviews/"),
        ) as HTMLAnchorElement | undefined;
        if (link) {
          (link as HTMLAnchorElement).click();
          return true;
        }
        return false;
      });

      if (clicked) {
        // wait for navigation to reviews path or for reviews container
        try {
          await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 });
        } catch {}
        // ensure we're on reviews page (URL contains /site/reviews/ or /reviews/)
        if (!/\/site\/reviews\//.test(page.url())) {
          // sometimes clicking doesn't navigate (opens in same document via JS) - wait for review list
          try {
            await page.waitForSelector("[data-reviews-container], .reviews", { timeout: 6000 });
          } catch (e) {
            // ignore
          }
        }
        console.log("Navigated to reviews page (or review list visible)");
      } else {
        console.log(
          "Could not locate explicit 'See All Customer Reviews' button/link; attempting to detect reviews section in place",
        );
      }
    } catch (e) {
      console.log("Error clicking 'See All Customer Reviews':", (e as Error).message);
    }

    // Wait a bit for reviews to load
    await waitFor(1200);

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
      rating: "N/A",
      totalReviews: allReviews.length,
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
