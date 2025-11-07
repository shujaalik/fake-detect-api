import { scrapeDarazProduct } from "./scrapers/daraz.js";
// import { scrapeAliExpressProduct } from "./scrapers/aliexpress.js";
// import Fastify from "fastify";

const DEBUG = false;

const main = async () => {
  const url =
    "https://www.daraz.pk/products/tws-10-i477228354-s2238430730.html?pvid=af79c6fe-0276-4c56-9f6e-8e76ecb13f1e&search=jfy&scm=1007.51705.413671.0&spm=a2a0e.tm80335142.just4u.d_477228354";
  await scrapeDarazProduct(url, { headless: DEBUG });
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
