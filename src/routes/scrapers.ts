import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { scrapeAliExpressProduct } from "src/components/scrapers/aliexpress";
import { scrapeDarazProduct } from "src/components/scrapers/daraz";
import { scrapeBestBuyProduct } from "src/components/scrapers/bestbuy";
import { scrapeEtsyProduct } from "src/components/scrapers/etsy";
import { scrapeFlipkartProduct } from "src/components/scrapers/flipkart";
import { runPythonPredict } from "src/utils/pythonBridge";

const DEBUG = process.env.DEBUG === "true";

type ScraperType = "aliexpress" | "daraz" | "bestbuy" | "etsy" | "flipkart" | "unknown";

function detectPlatform(url: string): ScraperType {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes("aliexpress")) return "aliexpress";
  if (lowerUrl.includes("daraz")) return "daraz";
  if (lowerUrl.includes("bestbuy")) return "bestbuy";
  if (lowerUrl.includes("etsy")) return "etsy";
  if (lowerUrl.includes("flipkart")) return "flipkart";
  return "unknown";
}

export default async function scrapersRoutes(fastify: FastifyInstance, _options: FastifyPluginOptions) {
  fastify.get("/aliexpress", async function handler(request, reply) {
    const url = (request.query as { url?: string }).url;
    if (!url) {
      reply.status(400).send({ error: "Missing url query parameter" });
      return;
    }
    try {
      const data = await scrapeAliExpressProduct(url, {
        headless: !DEBUG,
        maxReviews: 100,
      });
      return data;
    } catch (error) {
      reply.status(500).send({ error: "Failed to scrape product", details: error });
      return;
    }
  });

  fastify.get("/daraz", async function handler(request, reply) {
    const url = (request.query as { url?: string }).url;
    if (!url) {
      reply.status(400).send({ error: "Missing url query parameter" });
      return;
    }
    try {
      const data = await scrapeDarazProduct(url, {
        headless: !DEBUG,
        maxReviews: 100,
      });
      return data;
    } catch (error) {
      reply.status(500).send({ error: "Failed to scrape product", details: error });
      return;
    }
  });

  fastify.get("/bestbuy", async function handler(request, reply) {
    const url = (request.query as { url?: string }).url;
    if (!url) {
      reply.status(400).send({ error: "Missing url query parameter" });
      return;
    }
    try {
      const data = await scrapeBestBuyProduct(url, {
        headless: !DEBUG,
        maxReviews: 100,
      });
      return data;
    } catch (error) {
      reply.status(500).send({ error: "Failed to scrape product", details: error });
      return;
    }
  });

  fastify.get("/etsy", async function handler(request, reply) {
    const url = (request.query as { url?: string }).url;
    if (!url) {
      reply.status(400).send({ error: "Missing url query parameter" });
      return;
    }
    try {
      const data = await scrapeEtsyProduct(url, {
        headless: !DEBUG,
        maxReviews: 100,
      });
      return data;
    } catch (error) {
      reply.status(500).send({ error: "Failed to scrape product", details: error });
      return;
    }
  });

  fastify.get("/flipkart", async function handler(request, reply) {
    const url = (request.query as { url?: string }).url;
    if (!url) {
      reply.status(400).send({ error: "Missing url query parameter" });
      return;
    }
    try {
      const data = await scrapeFlipkartProduct(url, {
        headless: !DEBUG,
        maxReviews: 100,
      });
      return data;
    } catch (error) {
      reply.status(500).send({ error: "Failed to scrape product", details: error });
      return;
    }
  });
  fastify.get("/analyze", async function handler(request, reply) {
    const url = (request.query as { url?: string }).url;
    if (!url) {
      reply.status(400).send({ error: "Missing url query parameter" });
      return;
    }

    const platform = detectPlatform(url);
    if (platform === "unknown") {
      reply.status(400).send({ error: "Unsupported platform. Supported: AliExpress, Daraz, BestBuy, Etsy, Flipkart" });
      return;
    }

    // try {
    let scrapingResult;
    const config = { headless: !DEBUG, maxReviews: 100 };

    switch (platform) {
      case "aliexpress":
        scrapingResult = await scrapeAliExpressProduct(url, config);
        break;
      case "daraz":
        scrapingResult = await scrapeDarazProduct(url, config);
        break;
      case "bestbuy":
        scrapingResult = await scrapeBestBuyProduct(url, config);
        break;
      case "etsy":
        scrapingResult = await scrapeEtsyProduct(url, config);
        break;
      case "flipkart":
        scrapingResult = await scrapeFlipkartProduct(url, config);
        break;
    }

    if (!scrapingResult) {
      throw new Error("Scraping failed to return data");
    }

    // Extract review texts for analysis
    // Note: Scrapers currently populate 'fiveStarReviews'.
    // We might want to generalize this later, but for now we use what's available.
    const reviewsToAnalyze = scrapingResult.fiveStarReviews.map(r => r.text).filter(t => t && t.length > 0);

    let analysisResults: any[] = [];
    if (reviewsToAnalyze.length > 0) {
      analysisResults = await runPythonPredict(reviewsToAnalyze);
    }

    // Calculate stats
    const fakeCount = analysisResults.filter(r => r.prediction === "CG").length; // Assuming 'CG' = Computer Generated
    const realCount = analysisResults.filter(r => r.prediction === "OR").length; // Assuming 'OR' = Original Review
    const totalAnalyzed = analysisResults.length;
    const trustScore = totalAnalyzed > 0 ? (realCount / totalAnalyzed) * 100 : 0;

    const report = {
      product: {
        title: scrapingResult.title,
        image: scrapingResult.image,
        rating: scrapingResult.rating,
        totalReviews: scrapingResult.totalReviews,
        platform: platform,
      },
      analysis: {
        totalScraped: totalAnalyzed,
        fakeCount,
        realCount,
        trustScore,
        reviews: analysisResults.map((r, i) => ({
          text: r.review,
          rating: scrapingResult.fiveStarReviews[i]?.rating || 5, // Fallback if index mismatch, though unlikely
          prediction: r.prediction,
          probability: r.probability,
        })),
      },
    };

    return report;

    // } catch (error) {
    //   console.error("Analysis failed:", error);
    //   reply.status(500).send({ error: "Analysis failed", details: error });
    //   return;
    // }
  });
}
