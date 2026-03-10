const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../config/db");

const PASSWORD_VERSION = "v1";
const PBKDF2_ITERATIONS = 120000;
const PBKDF2_KEYLEN = 16;
const PBKDF2_DIGEST = "sha256";

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

/**
 * REGISTER USER
 */
router.post("/users/register", async (req, res) => {
  const { username, email, password, userRole, firstname, lastname } = req.body;

  if (!username || !password || !userRole) {
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
      [username, email || null],
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
        username,
        email || null,
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

  const loginKey = username || email;

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

module.exports = router;
