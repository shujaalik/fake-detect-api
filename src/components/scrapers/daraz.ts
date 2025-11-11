import puppeteer, { Browser, Page } from "puppeteer";
import waitFor from "../../utils/wait.js";

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

export async function scrapeDarazProduct(productUrl: string, config: ScraperConfig = {}): Promise<ScrapingResult> {
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
    await page.setViewport({ width: 1200, height: 900 });

    await page.setRequestInterception(true);
    page.on("request", req => {
      const t = req.resourceType();
      if (["font", "media"].includes(t)) req.abort();
      else req.continue();
    });

    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout });
    await waitFor(2500);

    // Reviews section on Daraz auto-appears when scrolled into view and reviews lazy-load.
    // Do NOT click the 'See all reviews' control (it may redirect to login). Instead scroll until
    // the reviews area appears (selector .mod-reviews or .mod-rating) or until timeout.
    console.log("Scrolling to reviews section (no click)...");
    const reviewsSelector = ".mod-reviews, .mod-rating, .pdp-review-summary, #review";
    let reviewsFound = false;
    const start = Date.now();
    const scrollTimeout = 15000; // ms
    while (Date.now() - start < scrollTimeout && !reviewsFound) {
      try {
        await page.waitForSelector(reviewsSelector, { timeout: 2000 });
        reviewsFound = true;
        break;
      } catch {
        // not found yet - scroll a bit and try again
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
        await waitFor(600);
      }
    }
    if (reviewsFound) console.log("Reviews section detected on page");
    else console.log("Reviews section not detected after scrolling; will attempt to scrape visible reviews");

    // Extract product metadata (title, image)
    const productData = await page.evaluate(() => {
      const data: any = {};
      const titleSel = ["h1.pdp-mod-product-badge-title", "h1", ".pdp-mod-product-badge-title"];
      for (const s of titleSel) {
        const el = document.querySelector(s);
        if (el && el.textContent && el.textContent.trim()) {
          data.title = el.textContent.trim();
          break;
        }
      }
      const img = document.querySelector(
        "img.pdp-mod-common-image, img.pdp-mod-product-gallery__image, img",
      ) as HTMLImageElement | null;
      if (img && (img.src || (img as any).dataset?.src)) data.image = img.src || (img as any).dataset?.src;
      return data;
    });

    // Try to extract overall rating and total reviews from Daraz review header
    try {
      const meta = await page.evaluate(() => {
        const out: any = {};
        // Daraz specific: look for .mod-rating block
        const mod = document.querySelector(".mod-rating") as HTMLElement | null;
        if (mod) {
          const scoreEl = mod.querySelector(".score .score-average") as HTMLElement | null;
          if (scoreEl && scoreEl.textContent) {
            const rv = parseFloat(scoreEl.textContent.trim());
            if (!Number.isNaN(rv)) out.rating = rv;
          }
          const countEl = mod.querySelector(".count") as HTMLElement | null;
          if (countEl && countEl.textContent) {
            const m = countEl.textContent.match(/[\d,]+/);
            if (m) out.totalReviews = parseInt(m[0].replace(/,/g, ""), 10);
          }
          // breakdown: list items under .detail li with .percent text
          const detailLis = Array.from(mod.querySelectorAll(".detail li")) as HTMLElement[];
          if (detailLis.length) {
            // li[0] => 5 star, li[1] =>4 star, ...
            detailLis.forEach((li, idx) => {
              const percentEl = li.querySelector(".percent") as HTMLElement | null;
              if (percentEl && percentEl.textContent) {
                const v = parseInt((percentEl.textContent || "").replace(/,/g, "").trim(), 10);
                if (!Number.isNaN(v)) out[5 - idx] = out[5 - idx] || v;
              }
            });
          }
        }

        // fallback: Daraz sometimes uses other selectors; try generic matches
        if (!out.rating) {
          const scoreEl = document.querySelector(
            ".score-average, .product-rating__score, .rating, .overall-rating",
          ) as HTMLElement | null;
          if (scoreEl && scoreEl.textContent) {
            const rv = parseFloat(scoreEl.textContent.trim());
            if (!Number.isNaN(rv)) out.rating = rv;
          }
        }
        if (!out.totalReviews) {
          const totalEl = document.querySelector(
            ".pdp-review-summary__count, .review-count, .total-review, .count",
          ) as HTMLElement | null;
          if (totalEl && totalEl.textContent) {
            const mm = totalEl.textContent.match(/[\d,]+/);
            if (mm) out.totalReviews = parseInt(mm[0].replace(/,/g, ""), 10);
          }
        }

        return out;
      });

      if (meta.rating) productData.rating = meta.rating;
      if (meta.totalReviews) productData.totalReviews = meta.totalReviews;
    } catch (e) {
      // ignore
    }

    // Extract rating breakdown if present
    try {
      const breakdown = await page.evaluate(() => {
        const out: Record<number, number> = {};
        // Daraz often has bars with '5', '4' etc and counts in '.count' or '.bar-value'
        const rows = Array.from(
          document.querySelectorAll(".pdp-review-summary .rating-row, .rating-row, .rating-bar"),
        ) as HTMLElement[];
        if (rows.length === 0) {
          // alternative: find inputs/labels similar to BestBuy
          const alt = Array.from(document.querySelectorAll(".rating-bar")) as HTMLElement[];
          rows.push(...alt);
        }
        rows.forEach(r => {
          const star = r.querySelector(".star, .rating") as HTMLElement | null;
          let n: number | null = null;
          if (star && star.textContent) {
            const v = parseInt(star.textContent.trim(), 10);
            if (!Number.isNaN(v)) n = v;
          }
          const cntEl = r.querySelector(".count, .review-count, .bar-value, .value") as HTMLElement | null;
          let cnt = 0;
          if (cntEl && cntEl.textContent) {
            const m = cntEl.textContent.match(/[\d,]+/);
            if (m) cnt = parseInt(m[0].replace(/,/g, ""), 10);
          }
          if (n) out[n] = cnt;
        });
        return out;
      });
      productData.ratingBreakdown = breakdown;
    } catch (e) {}

    // Apply filter menu to select 5 star if available
    try {
      // wait for filter control
      try {
        await page.waitForSelector(".oper, .next-filter, .filter", { timeout: 4000 });
      } catch {}
      const filterClicked = await page.evaluate(() => {
        const oper = document.querySelector(".oper, .next-filter, .filter") as HTMLElement | null;
        if (oper) {
          try {
            oper.click();
          } catch (e) {
            /* ignore */
          }
          return true;
        }
        return false;
      });

      if (filterClicked) {
        // wait for menu items and click the one that says '5 star'
        try {
          await page.waitForSelector(".next-menu-content .next-menu-item, .next-menu-item", { timeout: 3000 });
          await page.evaluate(() => {
            const items = Array.from(
              document.querySelectorAll(".next-menu-content .next-menu-item, .next-menu-item"),
            ) as HTMLElement[];
            const target = items.find(i => (i.textContent || "").trim().toLowerCase().includes("5 star"));
            if (target) {
              try {
                target.click();
              } catch (e) {
                /* ignore */
              }
            }
          });
          // wait for review list to update
          await waitFor(800);
        } catch (e) {
          // ignore
        }
      }
    } catch (e) {
      // ignore
    }

    // Scrape reviews: collect all reviews across load-more/pagination; robust selectors and fallbacks
    console.log("Scraping Daraz reviews...");
    const allReviews: Review[] = [];
    let noChange = 0;

    async function extractBatch(): Promise<Array<{ text: string; rating: number }>> {
      return page.evaluate(() => {
        // Prefer Daraz review items inside .mod-reviews
        const boxes = Array.from(
          document.querySelectorAll(".mod-reviews .item, .item, [data-review-id], .review"),
        ) as HTMLElement[];
        const out: Array<{ text: string; rating: number }> = [];
        boxes.forEach(b => {
          let rating = 0;
          // rating from star images inside .top .container-star
          const starImgs = b.querySelectorAll(".top .container-star img.star, .container-star img.star");
          if (starImgs && starImgs.length) rating = starImgs.length;

          // fallback: aria-label or data-rating
          if (!rating) {
            const aria = (b.getAttribute("aria-label") || "") as string;
            const m = aria.match(/(\d+(?:\.\d+)?)/);
            if (m) rating = parseFloat(m[1]);
            else {
              const dr = b.querySelector("[data-rating], .rating") as HTMLElement | null;
              if (dr && dr.textContent) {
                const mm = dr.textContent.match(/(\d+(?:\.\d+)?)/);
                if (mm) rating = parseFloat(mm[1]);
              }
            }
          }

          // text
          let text = "";
          const el = b.querySelector(
            ".item-content .content, .content, .pdp-review__content, .comment-text, p",
          ) as HTMLElement | null;
          if (el && el.textContent && el.textContent.trim()) text = el.textContent.trim();
          else {
            const t = (b.textContent || "").trim();
            if (t && t.length > 10 && t.length < 2000) text = t;
          }

          if (text) out.push({ text, rating: Math.round((rating || 0) * 10) / 10 });
        });
        return out;
      });
    }

    while (allReviews.length < maxReviews && noChange < 3) {
      const before = allReviews.length;
      const batch = await extractBatch();
      for (const r of batch) {
        if (allReviews.length >= maxReviews) break;
        if (!allReviews.find(rr => rr.text === r.text)) allReviews.push(r);
      }
      if (allReviews.length === before) noChange++;
      else noChange = 0;

      console.log(`Collected ${allReviews.length} reviews so far`);

      if (allReviews.length >= maxReviews) break;

      // try click load more or next
      const clicked = await page.evaluate(() => {
        // Prefer the Daraz next button
        const nextBtn = document.querySelector(
          "button.next-btn.next, button.next-pagination-item.next",
        ) as HTMLElement | null;
        if (nextBtn) {
          try {
            nextBtn.click();
          } catch (e) {
            /* ignore */
          }
          return true;
        }
        const more = document.querySelector(
          "button.load-more, button[data-load-more], a.load-more, a[data-load-more]",
        ) as HTMLElement | null;
        if (more) {
          try {
            more.click();
          } catch (e) {
            /* ignore */
          }
          return true;
        }
        // pagination link
        const next = document.querySelector('a[rel="next"], a.next, a.pager-next') as HTMLAnchorElement | null;
        if (next) {
          try {
            next.click();
          } catch (e) {
            /* ignore */
          }
          return true;
        }
        return false;
      });

      if (clicked) {
        try {
          await page.waitForFunction(
            (sel, before) => document.querySelectorAll(sel).length > before,
            { timeout: 5000 },
            "[data-review-id], .review, .comment-item, .item",
            before,
          );
          await waitFor(600);
          continue;
        } catch {
          await waitFor(800);
        }
      }

      // fallback scroll
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await waitFor(800);
    }

    const fiveStarReviews = allReviews.filter(r => r.rating === 5).slice(0, maxReviews);

    const result: ScrapingResult = {
      title: (productData.title as string) || "N/A",
      rating: (productData.rating as number) || "N/A",
      totalReviews: (productData.totalReviews as number) || "N/A",
      image: (productData.image as string) || "N/A",
      fiveStarReviews,
      fiveStarReviewCount: fiveStarReviews.length,
      ratingBreakdown: (productData.ratingBreakdown as Record<number, number>) || undefined,
    };

    console.log("Daraz scraping complete:", {
      title: result.title,
      rating: result.rating,
      total: result.totalReviews,
      fiveStarCount: result.fiveStarReviewCount,
      ratingBreakdown: result.ratingBreakdown,
    });
    return result;
  } catch (err) {
    console.error("Daraz scraper error:", (err as Error).message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}
