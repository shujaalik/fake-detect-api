import { FastifyInstance, FastifyPluginOptions } from "fastify";

export default async function baseRoutes(fastify: FastifyInstance, _options: FastifyPluginOptions) {
  fastify.get("/", async function handler() {
    // return uptime, memory usage, and current timestamp
    return {
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      timestamp: Date.now(),
    };
  });

  fastify.get("/ping", async function handler() {
    return { pong: "it worked!" };
  });
}
