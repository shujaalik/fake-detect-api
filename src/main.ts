import Fastify from "fastify";
import scrapersRoutes from "./routes/scrapers.js";
import baseRoutes from "./routes/base.js";

const fastify = Fastify({
  logger: true,
});

// routes
fastify.register(baseRoutes, { prefix: "/" });
fastify.register(scrapersRoutes, { prefix: "/scrapers" });

// Run the server!
try {
  await fastify.listen({ port: process.env.PORT ? parseInt(process.env.PORT) : 3000 });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
