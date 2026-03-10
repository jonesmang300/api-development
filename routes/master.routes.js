const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../config/db");

function parseAuthUser(req) {
  try {
    const auth = req.headers.authorization || "";
    const [scheme, token] = auth.split(" ");
    if (scheme !== "Bearer" || !token) return null;

    const [payloadPart, signaturePart] = token.split(".");
    if (!payloadPart || !signaturePart) return null;

    const secret = process.env.AUTH_TOKEN_SECRET || "cimis-mobile-secret";
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payloadPart)
      .digest("base64url");

    if (expectedSig.length !== signaturePart.length) return null;
    const ok = crypto.timingSafeEqual(
      Buffer.from(expectedSig),
      Buffer.from(signaturePart),
    );
    if (!ok) return null;

    const payloadJson = Buffer.from(payloadPart, "base64url").toString("utf8");
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

/* ===============================
   GET ALL REGIONS
   =============================== */
router.get("/regions", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT regionID, name FROM tblregion ORDER BY name",
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to load regions" });
  }
});

/* ===============================
   GET DISTRICTS BY REGION
   =============================== */
router.get("/districts", async (req, res) => {
  const { regionID } = req.query;

  if (!regionID) {
    return res.status(400).json({ message: "regionID is required" });
  }

  try {
    const [rows] = await db.query(
      `
      SELECT DistrictID, DistrictName, regionID
      FROM tbldistrict
      WHERE regionID = ?
      ORDER BY DistrictName
      `,
      [regionID],
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to load districts" });
  }
});

/* ===============================
   GET TAs BY DISTRICT
   =============================== */
router.get("/tas", async (req, res) => {
  const { districtID } = req.query;

  if (!districtID) {
    return res.status(400).json({ message: "districtID is required" });
  }

  try {
    const authUser = parseAuthUser(req);
    const roleId = Number(authUser?.userRole);
    const userId = authUser?.id ? String(authUser.id) : "";

    let sql = `
      SELECT TAID, TAName, DistrictID
      FROM tblta
      WHERE DistrictID = ?
    `;
    const params = [districtID];

    // role 5 sees only assigned TAIDs
    if (roleId === 5) {
      if (!userId) {
        return res.json([]);
      }

      const [assignedRows] = await db.query(
        `
        SELECT taID
        FROM tblsctretargeting_user_location
        WHERE userID = ?
          AND taID IS NOT NULL
        `,
        [userId],
      );

      const taIDs = assignedRows
        .map((r) => String(r.taID || "").trim())
        .filter((v) => v.length > 0);

      if (taIDs.length === 0) {
        return res.json([]);
      }

      const placeholders = taIDs.map(() => "?").join(", ");
      sql += ` AND TAID IN (${placeholders})`;
      params.push(...taIDs);
    }

    sql += " ORDER BY TAName";

    const [rows] = await db.query(sql, params);

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to load TAs" });
  }
});

/* ===============================
   GET VILLAGE CLUSTERS BY TA
   =============================== */
router.get("/village-clusters", async (req, res) => {
  const { taID } = req.query;

  if (!taID) {
    return res.status(400).json({ message: "taID is required" });
  }

  try {
    const [rows] = await db.query(
      `
      SELECT 
        villageClusterID,
        villageClusterName,
        taID,
        districtID
      FROM tblsctretargeting_village_clusters
      WHERE taID = ?
      ORDER BY villageClusterName
      `,
      [taID],
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to load village clusters" });
  }
});

module.exports = router;
