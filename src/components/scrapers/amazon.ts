import { ApifyClient } from "apify-client";

interface Review {
  text: string;
  rating: number;
  author?: string;
  date?: string;
}

interface ScrapingResult {
  title: string;
  image: string;
  rating: number | string;
  totalReviews: number | string;
  fiveStarReviews: Review[];
}

export async function scrapeAmazonProduct(url: string): Promise<ScrapingResult> {
  const token = "kMPw8AyYv6FkK5Xq9xfnnmskB"; //process.env.APIFY_TOKEN;
  if (!token) {
    throw new Error("APIFY_TOKEN is missing in environment variables");
  }

  const client = new ApifyClient({
    token: token,
  });

  // Prepare input for the actor
  // Actor: junglee/amazon-reviews-scraper (ZebkvH3nVOrafqr5T)
  const input = {
    productUrls: [{ url }],
    maxReviews: 50,
    sort: "helpful",
    filterByRatings: ["fiveStar"],
    scrapeProductDetails: true, // Request product metadata
    // Actually the project seems to collect reviews.
    // The previous scrapers collect 5-star reviews mostly?
    // Check AliScraper: "fiveStarReviews" field.
    // I will explicitly filter for 5 stars to match "fiveStarReviews" naming,
    // or if the purpose is fake detection, we might want all?
    // The field name is `fiveStarReviews`, so I will target 5 stars.
  };

  console.log(`[Amazon] Starting scrape for ${url} via Apify...`);

  // Run the actor
  const run = await client.actor("junglee/amazon-reviews-scraper").call(input);

  console.log(`[Amazon] Actor run started: ${run.id}`);

  // Fetch results
  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  // Map results
  // The actor returns specific format. I'll need to parse it.
  // Usually items have productInfo and reviews.

  // Let's inspect the first item to get product details if available,
  // or we might need to look at how this actor structures output.
  // junglee/amazon-reviews-scraper returns one item per review usually.
  // Wait, let's verify if proper product metadata is returned.
  // If it returns flat list of reviews, we might need to extract title/image from the first one
  // or use a different actor or input config.
  // Actually, junglee/amazon-reviews-scraper output typically includes productTitle, productImageUrl in each review item.

  if (items.length === 0) {
    console.log("[Amazon] No reviews found.");
    return {
      title: "Unknown Product",
      image: "",
      rating: 0,
      totalReviews: 0,
      fiveStarReviews: [],
    };
  }

  // const firstItem = items[0] as any;

  const productItem = items.find((i: any) => i.productTitle || (i.product && i.product.title));
  const rawProduct = productItem ? productItem.product || {} : ({} as any);

  // Attempt to parse rating from product info if available
  // Some actors use 'rating', 'averageRating', 'stars'
  const productRating = rawProduct.rating || rawProduct.averageRating || rawProduct.stars || 0;

  const title = productItem?.productTitle || rawProduct.title || "Amazon Product";
  const image =
    rawProduct?.highResolutionImages?.[0] ||
    rawProduct.mainImage ||
    rawProduct.image ||
    (rawProduct.images && rawProduct.images[0]) ||
    "";
  const rating = productItem?.productRating || productRating || 0;

  const reviews: Review[] = items
    .map((item: any) => ({
      text: (item.reviewTitle ? item.reviewTitle + "\n" : "") + (item.reviewDescription || ""),
      rating: item.ratingScore || 0,
      author: item.reviewAuthor || "Amazon Customer", // keys showed userId, maybe author name not scraped
      date: item.date,
    }))
    .filter(r => r.rating === 5 && r.text.length > 5);

  // Filter strictly for 5 stars if we fetched other stars, but input filter matches.

  return {
    title,
    image,
    rating,
    totalReviews: items.length, // accurate enough for the batch
    fiveStarReviews: reviews,
  };
}
