import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { scrapeAliExpressProduct } from "src/components/scrapers/aliexpress";
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
}
