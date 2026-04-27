// Side-effect import: dotenv populates process.env from .env before any other
// module reads it. Must come before config / logger imports.
import "dotenv/config";

import { createApp } from "./app.js";
import { config, validateConfig } from "./config.js";
import { logger } from "./logger.js";

validateConfig();

const app = createApp();

app.listen(config.port, () => {
  logger.info(`Clauditor listening on port ${config.port}`);
  logger.info(`Queue worker running...`);
});
