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
  ratingBreakdown?: Record<number, number>;
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

type RatingBreakdown = {
  5: number;
  4: number;
  3: number;
  2: number;
  1: number;
};

function estimateRatingBreakdown(averageRating: number, totalRatings: number): RatingBreakdown {
  let ratios: number[];

  if (averageRating >= 4.9) ratios = [0.93, 0.05, 0.01, 0.005, 0.005];
  else if (averageRating >= 4.7) ratios = [0.88, 0.08, 0.02, 0.01, 0.01];
  else if (averageRating >= 4.5) ratios = [0.8, 0.1, 0.05, 0.03, 0.02];
  else if (averageRating >= 4.3) ratios = [0.7, 0.15, 0.07, 0.05, 0.03];
  else ratios = [0.6, 0.2, 0.1, 0.06, 0.04];

  const [r5, r4, r3, r2, r1] = ratios;

  // Calculate approximate counts
  const breakdown = {
    5: Math.round(totalRatings * r5),
    4: Math.round(totalRatings * r4),
    3: Math.round(totalRatings * r3),
    2: Math.round(totalRatings * r2),
    1: Math.round(totalRatings * r1),
  };

  // Fix rounding errors so total adds up
  const diff = totalRatings - (breakdown[5] + breakdown[4] + breakdown[3] + breakdown[2] + breakdown[1]);
  breakdown[5] += diff;

  return breakdown;
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

    // Track whether we've successfully selected the 5-star filter (declared at page-level scope so
    // fallback handlers can read/update it).
    let fiveStarSelected = false;

    console.log("Navigating to product page...");
    await page.goto(productUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeout,
    });

    // Wait for page to load
    await waitFor(5000);

    console.log("Extracting product information...");

    // Extract product information (title + image + rating + totalReviews). Keep this simple and avoid nested page.evaluate calls.
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

      // Extract rating and total reviews from the reviewer box if present
      const reviewerSelectors = [".reviewer--box--wVguYsD", '[class*="reviewer--box"]', '[class*="reviewer"]'];

      let reviewerEl: Element | null = null;
      for (const sel of reviewerSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          reviewerEl = el;
          break;
        }
      }
      if (reviewerEl) {
        // rating is inside a <strong> element (example: "\u00A0\u00A03.6\u00A0\u00A0")
        const strong = reviewerEl.querySelector("strong");
        if (strong && strong.textContent) {
          const txt = strong.textContent.replace(/\u00A0/g, " ").trim();
          const m = txt.match(/([0-9]+(?:\.[0-9]+)?)/);
          if (m) {
            const val = parseFloat(m[1]);
            if (!Number.isNaN(val)) data.rating = val;
          }
        }

        // total reviews typically in an <a> near the rating (example: "459 Reviews")
        // total reviews: prefer an anchor whose text contains "review(s)" —
        // avoid matching the integer part of a decimal rating (e.g. "3.6") by ensuring not followed by a dot
        let revAnchor: Element | null = null;
        const anchorCandidates = Array.from(reviewerEl.querySelectorAll("a")) as Element[];
        for (const a of anchorCandidates) {
          const t = (a.textContent || "").trim();
          if (/\breview(s)?\b/i.test(t)) {
            revAnchor = a;
            break;
          }
        }

        // fallback: anchor with reviews-like class
        if (!revAnchor) {
          revAnchor = reviewerEl.querySelector('a[class*="reviews"]');
        }

        if (revAnchor && revAnchor.textContent) {
          const txt = revAnchor.textContent.replace(/,/g, "").trim();
          // match a whole integer (optionally with comma separators and trailing +),
          // but avoid matching the integer part of a decimal rating (e.g. "3.6") by ensuring not followed by a dot
          const m2 = txt.match(/(\d[\d,]*\+?)(?!\.)/);
          if (m2) {
            const digitsOnly = m2[1].replace(/[^\d]/g, "");
            const cnt = parseInt(digitsOnly, 10);
            if (!Number.isNaN(cnt)) data.totalReviews = cnt;
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

    // If we have an average rating and total reviews but no explicit breakdown,
    // estimate the rating breakdown using the helper function added above.
    try {
      if (
        typeof productData.rating === "number" &&
        typeof productData.totalReviews === "number" &&
        !productData.ratingBreakdown
      ) {
        productData.ratingBreakdown = estimateRatingBreakdown(productData.rating, productData.totalReviews);
        console.log("Estimated rating breakdown:", productData.ratingBreakdown);
      }
    } catch (e) {
      // ignore estimation errors — not critical
    }

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

      // Only click page-level anchors to open the reviews modal if the modal is not already open.
      // Clicking the anchor when the modal is open can close it on some pages, which breaks scraping.
      try {
        const modalHandle = await page.$(".comet-v2-modal-body");
        if (modalHandle) {
          console.log("Reviews modal already open, skipping page-level anchor clicks");
        } else {
          // Prefer clicking via element handle (more robust) before falling back to evaluate.
          let opened = false;
          try {
            const reviewHandle = await page.$(
              'a[href="#nav-review"], .reviewer--rating--xrWWFzx, .reviewer--reviews--cx7Zs_V',
            );
            if (reviewHandle) {
              try {
                await reviewHandle.click();
                console.log("Clicked reviews anchor (handle) to open modal/scroll");
                await waitFor(1000);
                opened = true;
              } catch {
                try {
                  await page.evaluate(el => (el as HTMLElement).click(), reviewHandle);
                  opened = true;
                } catch {}
              }
            }
          } catch {}

          if (!opened) {
            try {
              const clicked = await page.evaluate(() => {
                const a = document.querySelector('a[href="#nav-review"]') as HTMLElement | null;
                if (a) {
                  a.click();
                  return true;
                }
                const el = document.querySelector(
                  ".reviewer--rating--xrWWFzx, .reviewer--reviews--cx7Zs_V",
                ) as HTMLElement | null;
                if (el) {
                  el.click();
                  return true;
                }
                return false;
              });
              if (clicked) {
                console.log("Clicked reviews anchor to open modal/scroll (evaluate)");
                await waitFor(1000);
              }
            } catch {}
          }
        }
      } catch {}

      // 2) Open the ratings dropdown and select the "5 Star" item INSIDE THE MODAL.
      // Important: Scope to the modal container and use hover for the "All ratings" control.
      try {
        const modalSelector = ".comet-v2-modal-content.comet-v2-modal-no-footer, .comet-v2-modal-body";
        const modalScope = await page.$(modalSelector);
        if (!modalScope) {
          console.log("Modal not open yet; deferring 5-star selection to modal phase");
        } else {
          // A) Hover the in-modal "All ratings" control to open the dropdown
          try {
            const triggers = await modalScope.$$(
              'button, [role="button"], .filter--filterItem--AEUeCbl, .filter--filterItem',
            );
            let hoveredAllRatings = false;
            for (const t of triggers) {
              const txt = (await page.evaluate(el => (el.textContent || "").trim().toLowerCase(), t)) as string;
              if (txt.includes("all ratings") || txt === "all" || txt.includes("ratings")) {
                try {
                  await t.hover();
                  hoveredAllRatings = true;
                  console.log("Hovered 'All ratings' inside modal");
                  break;
                } catch {
                  try {
                    await page.evaluate(el => {
                      const evt = new MouseEvent("mouseover", { bubbles: true, cancelable: true });
                      (el as HTMLElement).dispatchEvent(evt);
                    }, t);
                    hoveredAllRatings = true;
                    console.log("Dispatched mouseover on 'All ratings' inside modal");
                    break;
                  } catch {}
                }
              }
            }

            if (hoveredAllRatings) {
              // Wait briefly for the dropdown menu to render
              try {
                await page.waitForSelector(
                  ".comet-v2-menu-item, .comet-v2-dropdown-body, .comet-v2-menu-item-content, li",
                  { timeout: 2000 },
                );
              } catch {}

              // Prefer visible menu items
              const menuItems = await page.$$(".comet-v2-menu-item, .comet-v2-menu-item-content, li, button, a");
              for (const mi of menuItems) {
                const [isVisible, mtxt] = (await Promise.all([
                  page.evaluate(el => {
                    const rect = (el as HTMLElement).getBoundingClientRect();
                    const style = window.getComputedStyle(el as HTMLElement);
                    return (
                      rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
                    );
                  }, mi),
                  page.evaluate(el => (el.textContent || "").trim().toLowerCase(), mi),
                ])) as [boolean, string];

                if (!isVisible) continue;
                if (
                  mtxt === "5 star" ||
                  mtxt.startsWith("5 star") ||
                  mtxt.includes("5-star") ||
                  mtxt.includes("5 star")
                ) {
                  try {
                    await mi.click();
                    fiveStarSelected = true;
                    console.log("Selected '5 Star' from modal dropdown");
                    await waitFor(800);
                    break;
                  } catch {}
                }
              }
            }
          } catch {}

          // B) If not selected via dropdown, try a direct 5-star button within the modal
          if (!fiveStarSelected) {
            const directClickedInModal = await page.evaluate((sel: string) => {
              const modal = document.querySelector(sel);
              const root: Document | Element = modal || document;
              const candidates = Array.from(
                root.querySelectorAll(
                  'button, a, div[role="button"], .filter--filterItem--AEUeCbl, .filter--filterItem',
                ),
              ) as HTMLElement[];
              for (const el of candidates) {
                const txt = (el.textContent || "").trim().toLowerCase();
                if (txt === "5 star" || txt.startsWith("5 star") || txt.includes("5-star") || txt.includes("5 star")) {
                  try {
                    (el as HTMLElement).click();
                    return true;
                  } catch {}
                }
                const btn = el.querySelector && (el.querySelector("button") as HTMLElement | null);
                if (btn) {
                  const btxt = (btn.textContent || "").trim().toLowerCase();
                  if (btxt === "5 star" || btxt.startsWith("5 star") || btxt.includes("5-star")) {
                    try {
                      btn.click();
                      return true;
                    } catch {}
                  }
                }
              }
              return false;
            }, modalSelector);

            if (directClickedInModal) {
              fiveStarSelected = true;
              console.log("Clicked 5 Star directly inside modal");
            } else {
              console.log("No explicit 5 Star control found inside modal — will rely on later fallbacks");
            }
          }
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
        // If we haven't already selected the 5-star filter, try clicking the filter items
        // that appear inside the modal. Many pages use `.filter--filterItem--AEUeCbl` with a
        // button whose text is "5 Star" — click that if present.
        if (!fiveStarSelected) {
          try {
            const clicked = await page.evaluate(() => {
              // check for filter item blocks first
              const blocks = Array.from(
                document.querySelectorAll(".filter--filterItem--AEUeCbl, .filter--filterItem"),
              ) as HTMLElement[];
              for (const b of blocks) {
                const btn = b.querySelector("button") as HTMLElement | null;
                const txt = (btn?.textContent || b.textContent || "").trim().toLowerCase();
                if (txt.includes("5 star") || txt.startsWith("5 star") || txt.includes("5-star")) {
                  if (btn) btn.click();
                  else (b as HTMLElement).click();
                  return true;
                }
              }

              // fallback: any button with exact/near-exact text
              const buttons = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];
              for (const btn of buttons) {
                const t = (btn.textContent || "").trim().toLowerCase();
                if (t === "5 star" || t.startsWith("5 star") || t.includes("5-star")) {
                  btn.click();
                  return true;
                }
              }

              return false;
            });

            if (clicked) {
              fiveStarSelected = true;
              console.log("Clicked 5 Star filter inside modal");
              await waitFor(800);
            }
          } catch (e) {
            // ignore — we'll try other fallbacks below
          }
        }
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
      // Try clicking modal filter blocks using element handles (more reliable than in-page evaluate).
      try {
        const modalSelector = ".comet-v2-modal-content.comet-v2-modal-no-footer, .comet-v2-modal-body";
        const modalScope = await page.$(modalSelector);
        const blocks = modalScope
          ? await modalScope.$$(".filter--filterItem--AEUeCbl, .filter--filterItem")
          : await page.$$(".filter--filterItem--AEUeCbl, .filter--filterItem");

        for (const b of blocks) {
          const txt = (await page.evaluate(el => (el.textContent || "").toLowerCase(), b)) as string;
          if (txt.includes("5 star") || txt.includes("5-star")) {
            try {
              await b.click();
              console.log("Clicked 5 Star filter (handle)");
              await waitFor(800);
              fiveStarSelected = true;
              break;
            } catch {}
          }
          const btn = await b.$("button");
          if (btn) {
            const btxt = (await page.evaluate(el => (el.textContent || "").toLowerCase(), btn)) as string;
            if (btxt.includes("5 star") || btxt.includes("5-star")) {
              try {
                await btn.click();
                console.log("Clicked inner button 5 Star (handle)");
                await waitFor(800);
                fiveStarSelected = true;
                break;
              } catch {}
            }
          }
        }
      } catch (e) {
        // ignore
      }
      const modalSelector2 = ".comet-v2-modal-content.comet-v2-modal-no-footer, .comet-v2-modal-body";
      await page.evaluate((sel: string) => {
        const root = (document.querySelector(sel) as HTMLElement) || document.body;
        const buttons = Array.from(root.querySelectorAll('button, label, div[role="button"]')) as HTMLElement[];
        const fiveStarButton = buttons.find(btn => {
          const t = (btn.textContent || "").toLowerCase();
          return (t.includes("5") && t.includes("star")) || btn.innerHTML.toLowerCase().includes("star");
        });
        if (fiveStarButton) fiveStarButton.click();
      }, modalSelector2);
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
      // Ensure ratingBreakdown is surfaced to the caller
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
    console.error("Error scraping AliExpress:", err.message);
    console.error(err.stack);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
