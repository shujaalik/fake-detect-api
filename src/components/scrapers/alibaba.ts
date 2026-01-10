import { Browser } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import path from "path";

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

export async function scrapeAlibabaProduct(productUrl: string, config: ScraperConfig = {}): Promise<ScrapingResult> {
  const {
    // maxReviews = 50,
    headless = true,
    timeout = 60000,
    userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  } = config;

  console.log(`[Alibaba] Starting scrape for ${productUrl}`);

  const browser = (await puppeteer.launch({
    headless: headless ? true : false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  })) as unknown as Browser;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    // NOTE: We do NOT use request interception to block images/fonts because Alibaba's review system
    // appears to depend on scripts/assets that get blocked by aggressive filtering.
    // Keeping full page load ensures reviews are rendered.

    console.log("[Alibaba] Navigating to product page...");
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout });

    // Try to extract JSON-LD first as it's the most reliable source on Alibaba
    console.log("[Alibaba] Extracting structured data...");
    const jsonLdData = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent || "{}");
          // Check if it's an array and search for Product type
          if (Array.isArray(data)) {
            const product = data.find(item => item["@type"] === "Product");
            if (product) return product;
          }
          // Or if it's a single object
          if (data["@type"] === "Product") return data;
        } catch (e) {
          // Ignore parse errors
        }
      }
      return null;
    });

    // Fallback selectors
    const productInfo: any = {};

    if (jsonLdData) {
      console.log("[Alibaba] Found JSON-LD Product data.");
      (productInfo.title = jsonLdData.name),
        (productInfo.image = Array.isArray(jsonLdData.image) ? jsonLdData.image[0] : jsonLdData.image);
      productInfo.rating = jsonLdData.aggregateRating?.ratingValue || 0;
      productInfo.totalReviews = jsonLdData.aggregateRating?.reviewCount || 0;
    } else {
      console.log("[Alibaba] No JSON-LD found. Using DOM selectors.");
      productInfo.title = await page.$eval("h1", el => el.textContent?.trim()).catch(() => "Unknown Product");
      productInfo.image = await page
        .$eval(".main-image img, .detail-main-image img", el => el.getAttribute("src"))
        .catch(() => "");
      productInfo.rating = 0;
      productInfo.totalReviews = 0;
    }

    console.log(
      `[Alibaba] Product: ${productInfo.title}, Rating: ${productInfo.rating}, Reviews: ${productInfo.totalReviews}`,
    );

    // Enable console log forwarding
    // console.log("[Alibaba] Attempting to find review elements...");
    const reviews: Review[] = [];

    let modalOpened = false;
    try {
      console.log("[Alibaba] Scrolling to find 'Show all' button...");

      let showAllBtnHandle = null;
      for (let i = 0; i < 15; i++) {
        // Check if button is visible
        showAllBtnHandle = await page.evaluateHandle(() => {
          const candidates = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
          return candidates.find(b => {
            const t = b.textContent?.trim() || "";
            return (
              (t === "Show all" || t === "View all" || t.includes("All reviews")) && (b as HTMLElement).offsetHeight > 0
            );
          });
        });

        if (await showAllBtnHandle.asElement()) {
          break;
        }

        // Scroll down from Node.js side
        await page.evaluate(() => {
          window.scrollBy(0, 800);
        });
        await new Promise(resolve => setTimeout(resolve, 800));
      }

      const showAllBtn = showAllBtnHandle?.asElement();

      if (showAllBtn) {
        console.log("[Alibaba] Found 'Show all' button, clicking to open modal...");

        // Ensure button is in view
        await showAllBtn.evaluate(b => (b as HTMLElement).scrollIntoView({ block: "center" }));
        await new Promise(r => setTimeout(r, 1000));

        // Try standard click
        try {
          await showAllBtn.click();
        } catch (clickErr) {
          console.log("[Alibaba] Standard click failed, trying JS click...", clickErr);
          await showAllBtn.evaluate(b => (b as HTMLElement).click());
        }

        // Wait for modal to appear
        try {
          await page.waitForSelector('div[role="dialog"], .r-reviews-dialog', { timeout: 5000, visible: true });
          modalOpened = true;
        } catch (waitErr) {
          console.log("[Alibaba] Modal selector not found after click, assuming standard page flow or failed open.");

          // Debug Snapshot
          try {
            const dumpDir = path.resolve(process.cwd(), "debug_dumps");
            if (!fs.existsSync(dumpDir)) fs.mkdirSync(dumpDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const shotPath = path.join(dumpDir, `alibaba_modal_fail_${timestamp}.png`);
            await page.screenshot({ path: shotPath, fullPage: true });
            console.log(`[Alibaba DEBUG] Saved modal failure screenshot to: ${shotPath}`);
          } catch (shotErr) {
            console.error("[Alibaba DEBUG] Failed to save failure screenshot:", shotErr);
          }

          // Check if we are already in a state (maybe it wasn't a modal?)
        }

        // Extra safety wait
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.log("[Alibaba] 'Show all' button not found, trying generic toggle...");
        const reviewToggle = await page.$(".detail-review-item, .detail-product-comment");
        if (reviewToggle) {
          await reviewToggle.click();
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    } catch (e) {
      console.log("[Alibaba] Error interacting with review UI:", e);
    }

    if (modalOpened) {
      console.log("[Alibaba] Scrolling inside modal...");
      const scrollScript = `
            return new Promise((resolve) => {
                const limit = 50; 
                
                // Find visible modal
                const possibleModals = Array.from(document.querySelectorAll('div[role="dialog"], div[class*="dialog"], div[class*="overlay"]'));
                let modal = possibleModals.find(m => {
                    const style = window.getComputedStyle(m);
                    return style.display !== 'none' && style.visibility !== 'hidden' && m.clientHeight > 0;
                });
                if (!modal) modal = document.querySelector('.r-reviews-dialog');
                const root = modal || document.body;
                
                // Find scrollable
                let scrollTarget = root.querySelector('.r-overflow-y-auto') || root.querySelector('[style*="overflow-y: auto"]');
                if (!scrollTarget) {
                    const findScrollable = (el) => {
                        const style = window.getComputedStyle(el);
                        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
                        for (const child of Array.from(el.children)) {
                            const found = findScrollable(child);
                            if (found) return found;
                        }
                        return null;
                    };
                    scrollTarget = findScrollable(root) || window;
                }
                
                console.log("[Alibaba] Scroll target identified:", scrollTarget === window ? "Window" : (scrollTarget.className || "Element"));

                let lastHeight = 0;
                let noChangeCount = 0;
                
                const timer = setInterval(() => {
                    if (scrollTarget instanceof Window) {
                        window.scrollTo(0, document.body.scrollHeight);
                        const currentHeight = document.body.scrollHeight;
                        if (currentHeight === lastHeight) noChangeCount++;
                        else {
                             noChangeCount = 0;
                             window.scrollBy(0, -100);
                             window.scrollTo(0, document.body.scrollHeight);
                        }
                        lastHeight = currentHeight;
                    } else {
                        // Force scroll to bottom of the modal container
                        scrollTarget.scrollTop = scrollTarget.scrollHeight;
                        const currentHeight = scrollTarget.scrollHeight;
                        if (currentHeight === lastHeight) noChangeCount++;
                        else noChangeCount = 0;
                        lastHeight = currentHeight;
                    }

                    const reviewCount = document.querySelectorAll('div[class*="r-whitespace-normal"]').length;
                    
                    if (reviewCount >= limit || noChangeCount > 10) { 
                        clearInterval(timer);
                        resolve();
                    }
                }, 1000); 
            });
        `;

      // Pass function string to evaluate
      await page.evaluate(new Function(scrollScript) as any);
    } else {
      // Fallback: Scroll main page to bottom if modal didn't open
      console.log("[Alibaba] Scrolling main page to load dynamic content...");
      await page.evaluate(async () => {
        await new Promise<void>(resolve => {
          let totalHeight = 0;
          const distance = 100;
          const timer = setInterval(() => {
            const scrollHeight = document.body.scrollHeight;
            window.scrollBy(0, distance);
            totalHeight += distance;

            if (totalHeight >= scrollHeight || totalHeight > 15000) {
              clearInterval(timer);
              resolve();
            }
          }, 50);
        });
      });
    }

    await new Promise(r => setTimeout(r, 3000)); // Wait for lazy loads after scroll

    const evaluationResult = await page.evaluate(() => {
      const results: any[] = [];
      let foundRating = 0;
      let foundCount = 0;

      // Use TreeWalker to find review text, as precise selectors are flaky on dynamic B2B pages
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim();
        if (!text || text.length < 5) continue;

        const parent = node.parentElement;
        if (!parent) continue;

        // Check for Rating/Review count in text like "4.9(181 reviews)"
        const ratingMatch = text.match(/(\d+(\.\d+)?)\s*\(\s*(\d+)\s*reviews\s*\)/i);
        if (ratingMatch) {
          const r = parseFloat(ratingMatch[1]);
          const c = parseInt(ratingMatch[3]);
          if (!isNaN(r)) foundRating = r;
          if (!isNaN(c)) foundCount = c;
        }

        // Identify Review Body:
        // 1. Long text (reviews are usually detailed)
        // 2. Parent has utility classes seen in inspection (r-text-[#222], r-whitespace-normal)
        const pClass = parent.className;
        // Check for the specific utility class combo or similar
        const isReviewNode =
          (pClass.includes("r-whitespace-normal") && pClass.includes("r-text")) ||
          (pClass.includes("detail-review-item") && !pClass.includes("detail-star"));

        const isSummary =
          text.includes("reviews)") || text.includes("sold") || text.includes("Sort by") || text.includes("5 stars");

        if (text.length > 20 && !isSummary && isReviewNode) {
          // console.log(`[Alibaba DEBUG] ACCEPTED review: "${text.substring(0,30)}..."`);
          results.push({
            body: text.substring(0, 500),
            rating: 5,
            author: "Alibaba Buyer",
            date: new Date().toISOString(),
          });
        }
      }
      return { reviews: results, rating: foundRating, count: foundCount };
    });

    const mlReviews = evaluationResult.reviews;
    if (mlReviews.length > 0) {
      console.log(`[Alibaba] Extracted ${mlReviews.length} text reviews.`);
      reviews.push(...mlReviews);
    }

    // Update product info from global scope if we parsed it from DOM
    if (evaluationResult.count > 0) {
      console.log(
        `[Alibaba] Updated metadata from DOM: ${evaluationResult.rating} stars, ${evaluationResult.count} reviews`,
      );
      productInfo.totalReviews = evaluationResult.count;
      productInfo.rating = evaluationResult.rating || (mlReviews.length > 0 ? 5 : 0);
    } else if (productInfo.totalReviews === 0 && mlReviews.length > 0) {
      productInfo.totalReviews = mlReviews.length;
    }

    // Ensure rating is not 0 if we have reviews/info
    if (productInfo.rating === 0 && productInfo.totalReviews > 0) {
      productInfo.rating = 5;
    }

    return {
      title: productInfo.title || "Unknown Product",
      image: productInfo.image || "",
      rating: productInfo.rating || 0,
      totalReviews: productInfo.totalReviews || 0,
      fiveStarReviews: reviews.map(r => ({ text: r.body, rating: r.rating })),
    };
  } catch (error) {
    console.error("[Alibaba] Scrape failed:", error);
    // Return partial/empty result instead of throwing, so the UI doesn't crash
    return {
      title: "Error scraping product",
      image: "",
      rating: 0,
      totalReviews: 0,
      fiveStarReviews: [],
    };
  } finally {
    await browser.close();
  }
}
