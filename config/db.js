const mysql = require("mysql2");
require("dotenv").config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  // 🔑 Critical for unstable connections
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

/**
 * 🔥 Handle pool-level errors safely
 */
pool.on("error", (err) => {
  console.error("❌ MySQL Pool Error:", err.code);

  if (
    err.code === "PROTOCOL_CONNECTION_LOST" ||
    err.code === "ECONNREFUSED" ||
    err.code === "ETIMEDOUT"
  ) {
    console.warn("⚠️ MySQL disconnected. Waiting for reconnection...");
    // DO NOT exit process
  }
});

module.exports = pool.promise();
