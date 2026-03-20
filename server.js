const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", require("./routes/master.routes"));
app.use("/api", require("./routes/beneficiaries.routes"));
app.use("/api", require("./routes/operations.routes"));
app.use("/api", require("./routes/userAuth.routes"));

/**
 * Health check (VERY important)
 */
app.get("/health", async (req, res) => {
  try {
    const db = require("./config/db");
    await db.query("SELECT 1");
    res.json({ status: "OK", database: "connected" });
  } catch {
    res.status(503).json({ status: "DOWN", database: "disconnected" });
  }
});

/**
 * Global error handler
 */
app.use((err, req, res, next) => {
  console.error("🔥 Unhandled error:", err);

  if (err.code === "PROTOCOL_CONNECTION_LOST") {
    return res.status(503).json({ message: "Database connection lost" });
  }

  res.status(500).json({ message: "Internal server error" });
});

/**
 * Prevent Node from crashing
 */
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ API running on port ${PORT}`));
