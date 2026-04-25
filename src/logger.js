import { config } from "./config.js";

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

function format(level, message, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  return `[${ts}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

export const logger = {
  debug: (msg, meta) => { if (currentLevel <= 0) console.debug(format("debug", msg, meta)); },
  info:  (msg, meta) => { if (currentLevel <= 1) console.info(format("info",  msg, meta)); },
  warn:  (msg, meta) => { if (currentLevel <= 2) console.warn(format("warn",  msg, meta)); },
  error: (msg, meta) => { if (currentLevel <= 3) console.error(format("error", msg, meta)); },
};
