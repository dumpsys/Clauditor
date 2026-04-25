import { createApp } from "./app.js";
import { config, validateConfig } from "./config.js";
import { logger } from "./logger.js";

validateConfig();

const app = createApp();

app.listen(config.port, () => {
  logger.info(`Clauditor listening on port ${config.port}`);
  logger.info(`Queue worker running...`);
});
