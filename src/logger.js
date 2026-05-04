import { config } from "./config.js";

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

/**
 * ISO 8601 timestamp in the machine's local timezone, with a UTC offset
 * suffix so the value remains unambiguous (e.g. "2026-05-04T11:06:44.123+07:00").
 *
 * Set LOG_UTC=true to force UTC ("…Z") if you ship logs across timezones.
 */
function nowIso() {
  const d = new Date();
  if (process.env.LOG_UTC === "true") return d.toISOString();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const offsetMin = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = offsetMin >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(offsetMin) / 60));
  const om = pad(Math.abs(offsetMin) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`
  );
}

function format(level, message, meta = {}) {
  const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  return `[${nowIso()}] [${level.toUpperCase()}] ${message}${metaStr}`;
}

export const logger = {
  debug: (msg, meta) => { if (currentLevel <= 0) console.debug(format("debug", msg, meta)); },
  info:  (msg, meta) => { if (currentLevel <= 1) console.info(format("info",  msg, meta)); },
  warn:  (msg, meta) => { if (currentLevel <= 2) console.warn(format("warn",  msg, meta)); },
  error: (msg, meta) => { if (currentLevel <= 3) console.error(format("error", msg, meta)); },
};
