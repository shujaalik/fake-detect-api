import { scrapeAmazonProduct } from "../components/scrapers/amazon.js";
// Manually load env if not using a runner that does it, or assume running with dotenv
import dotenv from "dotenv";
import path from "path";

// Load env from backend root
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function test() {
  console.log("Testing Apify Amazon Scraper...");
  // Use a common product, e.g., a book or tech item
  const url = "https://www.amazon.com/Apple-iPhone-11-64GB-Black/dp/B07ZPKN6YR"; // Renewed iPhone 11

  try {
    const result = await scrapeAmazonProduct(url);
    console.log("Scrape Success!");
    console.log("Title:", result.title);
    console.log("Image:", result.image);
    console.log("Five Star Reviews Count:", result.fiveStarReviews.length);
    if (result.fiveStarReviews.length > 0) {
      console.log("Sample Review:", result.fiveStarReviews[0]);
    }
  } catch (e) {
    console.error("Scrape Failed:", e);
  }
}

test();
