const express = require("express");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const router = express.Router();
const db = require("../config/db");

const PASSWORD_VERSION = "v1";
const PBKDF2_ITERATIONS = 120000;
const PBKDF2_KEYLEN = 16;
const PBKDF2_DIGEST = "sha256";

function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(8).toString("base64");
  const hash = crypto
    .pbkdf2Sync(
      plainPassword,
      salt,
      PBKDF2_ITERATIONS,
      PBKDF2_KEYLEN,
      PBKDF2_DIGEST,
    )
    .toString("base64");

  // Fits VARCHAR(45): v1$<salt>$<hash>
  return `${PASSWORD_VERSION}$${salt}$${hash}`;
}

function verifyPassword(plainPassword, storedPassword) {
  if (!storedPassword || typeof storedPassword !== "string") {
    return false;
  }

  const parts = storedPassword.split("$");
  if (parts.length !== 3 || parts[0] !== PASSWORD_VERSION) {
    return false;
  }

  const salt = parts[1];
  const expectedHash = parts[2];
  const computedHash = crypto
    .pbkdf2Sync(
      plainPassword,
      salt,
      PBKDF2_ITERATIONS,
      PBKDF2_KEYLEN,
      PBKDF2_DIGEST,
    )
    .toString("base64");

  if (computedHash.length !== expectedHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(computedHash, "utf8"),
    Buffer.from(expectedHash, "utf8"),
  );
}

/**
 * Create authentication token
 */
function createAuthToken(user) {
  const secret = process.env.AUTH_TOKEN_SECRET || "cimis-mobile-secret";

  const payload = Buffer.from(
    JSON.stringify({
      id: user.id,
      username: user.username,
      userRole: user.userRole,
      ts: Date.now(),
    }),
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

/* ===============================
   PASSWORD RESET HELPERS
================================ */
const RESET_TABLE = "tblsctretargeting_password_resets";
let resetTableReady = false;
const getResetDeliveryMode = () =>
  String(process.env.PASSWORD_RESET_MODE || "console").trim().toLowerCase();

async function ensureResetTable() {
  if (resetTableReady) return;
  await db.query(
    `
    CREATE TABLE IF NOT EXISTS ${RESET_TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      tokenHash VARCHAR(128) NOT NULL,
      expiresAt DATETIME NOT NULL,
      used TINYINT(1) DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (userId),
      INDEX idx_token (tokenHash),
      CONSTRAINT fk_reset_user FOREIGN KEY (userId) REFERENCES tblsctretargeting_users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `,
  );
  resetTableReady = true;
}

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

function buildMailer() {
  if (getResetDeliveryMode() === "console") {
    return null;
  }

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    const error = new Error("Password reset email is not configured on the server");
    error.code = "SMTP_NOT_CONFIGURED";
    throw error;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass },
  });
}

/* ===============================
   FORGOT PASSWORD (SEND EMAIL)
================================ */
router.post("/users/forgot-password", async (req, res) => {
  const { email, username } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeText(username);
  const loginKey = normalizedEmail || normalizedUsername;

  if (!loginKey) {
    return res.status(400).json({ message: "email or username is required" });
  }

  try {
    await ensureResetTable();

    const [rows] = await db.query(
      `
      SELECT id, email, username
      FROM tblsctretargeting_users
      WHERE email = ? OR username = ?
      LIMIT 1
    `,
      [normalizedEmail || loginKey, normalizedUsername || loginKey],
    );

    if (rows.length === 0) {
      // Do not reveal whether user exists
      return res.status(200).json({ message: "If the account exists, a reset link has been sent" });
    }

    const user = rows[0];
    if (!user.email) {
      return res.status(400).json({
        message: "This user does not have an email address for password reset",
      });
    }
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.query(
      `
      INSERT INTO ${RESET_TABLE} (userId, tokenHash, expiresAt, used)
      VALUES (?, ?, ?, 0)
    `,
      [user.id, tokenHash, expires],
    );

    const resetBase = process.env.RESET_LINK_BASE || "https://comsip.cloud/reset-password";
    const resetLink = `${resetBase}?token=${encodeURIComponent(token)}&email=${encodeURIComponent(
      user.email || "",
    )}`;
    const transporter = buildMailer();
    const from = process.env.SMTP_FROM || "no-reply@comsip.cloud";

    if (!transporter) {
      console.log("[PASSWORD RESET] Reset link for %s: %s", user.email, resetLink);
      return res.status(200).json({
        message: "Password reset link generated in server logs",
      });
    }

    await transporter.sendMail({
      from,
      to: user.email || from,
      subject: "CIMIS password reset",
      text: `You requested a password reset. Use the link below within 1 hour.\n\n${resetLink}\n\nIf you didn't request this, ignore this email.`,
      html: `<p>You requested a password reset.</p><p><a href="${resetLink}">Reset your password</a> (valid for 1 hour).</p><p>If you didn't request this, ignore this email.</p>`,
    });

    res.status(200).json({ message: "If the account exists, a reset link has been sent" });
  } catch (error) {
    console.error("Forgot password error:", error);
    if (error?.code === "SMTP_NOT_CONFIGURED") {
      return res.status(500).json({
        message: "Password reset email is not configured on the server",
      });
    }
    res.status(500).json({
      message: error?.message || "Failed to start password reset",
    });
  }
});

/* ===============================
   RESET PASSWORD (CONSUME TOKEN)
================================ */
router.post("/users/reset-password", async (req, res) => {
  const { token, email, username, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeText(username);

  if (!token || !password || (!normalizedEmail && !normalizedUsername)) {
    return res
      .status(400)
      .json({ message: "token, new password, and email or username are required" });
  }

  try {
    await ensureResetTable();

    const [userRows] = await db.query(
      `
      SELECT id, password
      FROM tblsctretargeting_users
      WHERE email = ? OR username = ?
      LIMIT 1
    `,
      [normalizedEmail || normalizedUsername, normalizedUsername || normalizedEmail],
    );

    if (userRows.length === 0) {
      return res.status(400).json({ message: "Invalid token or user" });
    }

    const user = userRows[0];
    const tokenHash = hashToken(token);

    const [resetRows] = await db.query(
      `
      SELECT id, expiresAt, used
      FROM ${RESET_TABLE}
      WHERE userId = ?
        AND tokenHash = ?
        AND used = 0
      ORDER BY id DESC
      LIMIT 1
    `,
      [user.id, tokenHash],
    );

    if (resetRows.length === 0) {
      return res.status(400).json({ message: "Invalid or expired token" });
    }

    const reset = resetRows[0];
    if (new Date(reset.expiresAt).getTime() < Date.now()) {
      return res.status(400).json({ message: "Token expired" });
    }

    const newHashed = hashPassword(password);

    await db.query(
      `
      UPDATE tblsctretargeting_users
      SET password = ?
      WHERE id = ?
    `,
      [newHashed, user.id],
    );

    await db.query(
      `
      UPDATE ${RESET_TABLE}
      SET used = 1
      WHERE id = ?
    `,
      [reset.id],
    );

    res.status(200).json({ message: "Password reset successful" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ message: "Failed to reset password" });
  }
});

/**
 * REGISTER USER
 */
router.post("/users/register", async (req, res) => {
  const { username, email, password, userRole, firstname, lastname } = req.body;
  const normalizedUsername = normalizeText(username);
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedUsername || !password || !userRole) {
    return res
      .status(400)
      .json({ message: "username, password and userRole are required" });
  }

  try {
    const hashedPassword = hashPassword(password);

    const [existingRows] = await db.query(
      `
      SELECT id
      FROM tblsctretargeting_users
      WHERE username = ?
         OR (email IS NOT NULL AND email = ?)
      LIMIT 1
      `,
      [normalizedUsername, normalizedEmail],
    );

    if (existingRows.length > 0) {
      return res.status(409).json({
        message: "User with the same username or email already exists",
      });
    }

    const [result] = await db.query(
      `
      INSERT INTO tblsctretargeting_users (
        username,
        email,
        password,
        userRole,
        firstname,
        lastname
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        normalizedUsername,
        normalizedEmail,
        hashedPassword,
        userRole,
        firstname || null,
        lastname || null,
      ],
    );

    res.status(201).json({
      message: "User created successfully",
      id: result.insertId,
    });
  } catch (error) {
    console.error("User registration error:", error);
    res.status(500).json({ message: "Failed to create user" });
  }
});

/**
 * LOGIN USER
 */
router.post("/users/login", async (req, res) => {
  const { username, email, password } = req.body;
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeText(username);
  const loginKey = normalizedUsername || normalizedEmail;

  if (!loginKey || !password) {
    return res
      .status(400)
      .json({ message: "username/email and password are required" });
  }

  try {
    const [rows] = await db.query(
      `
      SELECT
        id,
        username,
        email,
        password,
        userRole,
        firstname,
        lastname
      FROM tblsctretargeting_users
      WHERE username = ?
         OR email = ?
      LIMIT 1
      `,
      [loginKey, loginKey],
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = rows[0];

    let isValidPassword = verifyPassword(password, user.password);

    // Backward compatibility for old plaintext rows; upgrade to hash on success.
    if (!isValidPassword && user.password === password) {
      isValidPassword = true;
      const upgradedPassword = hashPassword(password);
      await db.query(
        `
        UPDATE tblsctretargeting_users
        SET password = ?
        WHERE id = ?
        `,
        [upgradedPassword, user.id],
      );
    }

    if (!isValidPassword) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = createAuthToken(user);

    res.status(200).json({
      message: "Authentication successful",
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        userRole: user.userRole,
        firstname: user.firstname,
        lastname: user.lastname,
      },
    });
  } catch (error) {
    console.error("User login error:", error);
    res.status(500).json({ message: "Authentication failed" });
  }
});

/**
 * GET ALL USER ROLES
 */
router.get("/user-roles", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT roleid, rolename
      FROM userrole
      ORDER BY roleid ASC
      `,
    );

    res.json(rows);
  } catch (error) {
    console.error("Get user roles error:", error);
    res.status(500).json({ message: "Failed to load user roles" });
  }
});

/**
 * GET USER ROLE BY ID
 */
router.get("/user-roles/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT roleid, rolename
      FROM userrole
      WHERE roleid = ?
      LIMIT 1
      `,
      [req.params.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User role not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get user role by id error:", error);
    res.status(500).json({ message: "Failed to load user role" });
  }
});

/* ===============================
   USER REPORT (EXPORT CSV)
================================ */
router.get("/users/report", async (_req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        COALESCE(DistrictID, '') AS district,
        COALESCE(TAID, '') AS ta,
        username,
        email,
        '' AS password_placeholder
      FROM tblsctretargeting_users
      ORDER BY DistrictID, TAID, username
      `,
    );

    const header = "DISTRICT,TA,USERNAME,PASSWORD,EMAIL";
    const csvLines = rows.map(
      (r) =>
        [
          r.district,
          r.ta,
          r.username,
          "NOT_STORED",
          r.email || "",
        ]
          .map((v) => `"${String(v).replace(/\"/g, '""')}"`)
          .join(","),
    );

    const csv = [header, ...csvLines].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=users.csv");
    return res.status(200).send(csv);
  } catch (error) {
    console.error("User report error:", error);
    res.status(500).json({ message: "Failed to generate report" });
  }
});

/* ===============================
   USER MANAGEMENT (ADMIN)
================================ */

// List users (basic profile info)
router.get("/users", async (_req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        id,
        username,
        email,
        userRole,
        firstname,
        lastname
      FROM tblsctretargeting_users
      ORDER BY id DESC
      `,
    );

    res.json(rows);
  } catch (error) {
    console.error("List users error:", error);
    res.status(500).json({ message: "Failed to load users" });
  }
});

// Get single user
router.get("/users/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT
        id,
        username,
        email,
        userRole,
        firstname,
        lastname
      FROM tblsctretargeting_users
      WHERE id = ?
      LIMIT 1
      `,
      [req.params.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({ message: "Failed to load user" });
  }
});

// Update user role / name / password
router.patch("/users/:id", async (req, res) => {
  const { username, email, userRole, firstname, lastname, newPassword } = req.body || {};
  const normalizedUsername =
    username === undefined ? undefined : normalizeText(username);
  const normalizedEmail =
    email === undefined ? undefined : normalizeEmail(email);

  if (
    username === undefined &&
    email === undefined &&
    userRole === undefined &&
    firstname === undefined &&
    lastname === undefined &&
    newPassword === undefined
  ) {
    return res.status(400).json({ message: "No fields provided" });
  }

  if (username !== undefined && !normalizedUsername) {
    return res.status(400).json({ message: "username cannot be empty" });
  }

  try {
    if (normalizedUsername !== undefined || normalizedEmail !== undefined) {
      const [existingRows] = await db.query(
        `
        SELECT id
        FROM tblsctretargeting_users
        WHERE id <> ?
          AND (
            (? IS NOT NULL AND username = ?)
            OR (? IS NOT NULL AND email = ?)
          )
        LIMIT 1
        `,
        [
          req.params.id,
          normalizedUsername || null,
          normalizedUsername || null,
          normalizedEmail || null,
          normalizedEmail || null,
        ],
      );

      if (existingRows.length > 0) {
        return res.status(409).json({
          message: "User with the same username or email already exists",
        });
      }
    }

    const setParts = [];
    const values = [];

    if (username !== undefined) {
      setParts.push("username = ?");
      values.push(normalizedUsername);
    }

    if (email !== undefined) {
      setParts.push("email = ?");
      values.push(normalizedEmail);
    }

    if (userRole !== undefined) {
      setParts.push("userRole = ?");
      values.push(userRole);
    }

    if (firstname !== undefined) {
      setParts.push("firstname = ?");
      values.push(firstname);
    }

    if (lastname !== undefined) {
      setParts.push("lastname = ?");
      values.push(lastname);
    }

    if (newPassword !== undefined && newPassword !== null && newPassword !== "") {
      const hashed = hashPassword(newPassword);
      setParts.push("password = ?");
      values.push(hashed);
    }

    values.push(req.params.id);

    const [result] = await db.query(
      `
      UPDATE tblsctretargeting_users
      SET ${setParts.join(", ")}
      WHERE id = ?
      `,
      values,
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: "User updated" });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ message: "Failed to update user" });
  }
});

module.exports = router;
