import { createApp } from "./app.js";
import { readEnv } from "./env.js";

const env = readEnv(process.env);
const app = await createApp({ env });

try {
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT || env.API_PORT) });
} catch (error) {
  app.log.error({ err: error instanceof Error ? { name: error.name, message: error.message } : { message: "unknown startup error" } }, "API startup failed");
  process.exitCode = 1;
}
