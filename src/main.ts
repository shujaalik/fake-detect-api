import { scrapeBestBuyProduct } from "./scrapers/bestbuy.js";
// import { scrapeAliExpressProduct } from "./scrapers/aliexpress.js";
// import Fastify from "fastify";

const DEBUG = false;

const main = async () => {
  const url =
    "https://www.bestbuy.com/product/hp-15-6-full-hd-touch-screen-laptop-intel-core-i7-16gb-memory-512gb-ssd-natural-silver/JJGRPJV92P#tabbed-customerreviews";
  await scrapeBestBuyProduct(url, { headless: DEBUG });
};

main();
// const fastify = Fastify({
//   logger: true,
// });

// // Declare a route
// fastify.get("/", async function handler() {
//   // return uptime, memory usage, and current timestamp
//   return {
//     uptime: process.uptime(),
//     memoryUsage: process.memoryUsage(),
//     timestamp: Date.now(),
//   };
// });

// fastify.get("/ping", async function handler() {
//   return { pong: "it worked!" };
// });

// fastify.get("/scrape/aliexpress", async function handler(request, reply) {
//   const url = (request.query as { url?: string }).url;
//   if (!url) {
//     reply.status(400).send({ error: "Missing url query parameter" });
//     return;
//   }
//   try {
//     const data = await scrapeAliExpressProduct(url, {
//       headless: !DEBUG,
//       maxReviews: 100,
//     });
//     return data;
//   } catch (error) {
//     reply.status(500).send({ error: "Failed to scrape product", details: error });
//     return;
//   }
// });

// // Run the server!
// try {
//   await fastify.listen({ port: 3000 });
// } catch (err) {
//   fastify.log.error(err);
//   process.exit(1);
// }
