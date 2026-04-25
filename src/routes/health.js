import { Router } from "express";
import { queue } from "../queue.js";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    queue: queue.size(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
