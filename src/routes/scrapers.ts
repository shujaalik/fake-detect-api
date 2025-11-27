import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { scrapeAliExpressProduct } from "src/components/scrapers/aliexpress";
import { scrapeDarazProduct } from "src/components/scrapers/daraz";
import { scrapeBestBuyProduct } from "src/components/scrapers/bestbuy";
import { scrapeEtsyProduct } from "src/components/scrapers/etsy";
import { scrapeFlipkartProduct } from "src/components/scrapers/flipkart";
const DEBUG = process.env.DEBUG === "true";

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
}
