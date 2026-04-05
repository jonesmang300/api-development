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

async function getRoleExtensionRegionIDs(userId) {
  if (!userId) return [];

  const [rows] = await db.query(
    `
    SELECT regionID
    FROM tblsctretargeting_role_extension
    WHERE userID = ?
      AND regionID IS NOT NULL
    ORDER BY regionID
    `,
    [userId],
  );

  return rows
    .map((row) => String(row.regionID || "").trim())
    .filter((value) => value.length > 0);
}

async function getAssignedTaIDs(userId) {
  if (!userId) return [];

  const [rows] = await db.query(
    `
    SELECT taID
    FROM tblsctretargeting_user_location
    WHERE userID = ?
      AND taID IS NOT NULL
    ORDER BY taID
    `,
    [userId],
  );

  return rows
    .map((row) => String(row.taID || "").trim())
    .filter((value) => value.length > 0);
}

async function getAssignedDistrictIDs(userId) {
  const taIDs = await getAssignedTaIDs(userId);
  if (taIDs.length === 0) return [];

  const [rows] = await db.query(
    `
    SELECT DISTINCT DistrictID
    FROM tblta
    WHERE TAID IN (${taIDs.map(() => "?").join(", ")})
      AND DistrictID IS NOT NULL
    ORDER BY DistrictID
    `,
    taIDs,
  );

  return rows
    .map((row) => String(row.DistrictID || "").trim())
    .filter((value) => value.length > 0);
}

async function getAssignedRegionIDsFromTas(userId) {
  const taIDs = await getAssignedTaIDs(userId);
  if (taIDs.length === 0) return [];

  const [rows] = await db.query(
    `
    SELECT DISTINCT d.regionID
    FROM tblta t
    INNER JOIN tbldistrict d ON d.DistrictID = t.DistrictID
    WHERE t.TAID IN (${taIDs.map(() => "?").join(", ")})
      AND d.regionID IS NOT NULL
    ORDER BY d.regionID
    `,
    taIDs,
  );

  return rows
    .map((row) => String(row.regionID || "").trim())
    .filter((value) => value.length > 0);
}

/* ===============================
   GET ALL REGIONS
   =============================== */
router.get("/regions", async (req, res) => {
  try {
    const authUser = parseAuthUser(req);
    const roleId = Number(authUser?.userRole);
    const userId = authUser?.id ? String(authUser.id) : "";

    let sql = "SELECT regionID, name FROM tblregion";
    const params = [];

    if (roleId === 2) {
      const regionIDs = await getRoleExtensionRegionIDs(userId);
      if (regionIDs.length === 0) {
        return res.json([]);
      }

      sql += ` WHERE regionID IN (${regionIDs.map(() => "?").join(", ")})`;
      params.push(...regionIDs);
    } else if (roleId === 5) {
      const regionIDs = await getAssignedRegionIDsFromTas(userId);
      if (regionIDs.length === 0) {
        return res.json([]);
      }

      sql += ` WHERE regionID IN (${regionIDs.map(() => "?").join(", ")})`;
      params.push(...regionIDs);
    }

    sql += " ORDER BY name";

    const [rows] = await db.query(sql, params);
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
    const authUser = parseAuthUser(req);
    const roleId = Number(authUser?.userRole);
    const userId = authUser?.id ? String(authUser.id) : "";

    if (roleId === 2) {
      const regionIDs = await getRoleExtensionRegionIDs(userId);
      if (
        regionIDs.length === 0 ||
        !regionIDs.includes(String(regionID || "").trim())
      ) {
        return res.json([]);
      }
    } else if (roleId === 5) {
      const regionIDs = await getAssignedRegionIDsFromTas(userId);
      if (
        regionIDs.length === 0 ||
        !regionIDs.includes(String(regionID || "").trim())
      ) {
        return res.json([]);
      }
    }

    let sql = `
      SELECT DistrictID, DistrictName, regionID
      FROM tbldistrict
      WHERE regionID = ?
    `;
    const params = [regionID];

    if (roleId === 5) {
      const districtIDs = await getAssignedDistrictIDs(userId);
      if (districtIDs.length === 0) {
        return res.json([]);
      }

      sql += ` AND DistrictID IN (${districtIDs.map(() => "?").join(", ")})`;
      params.push(...districtIDs);
    }

    sql += " ORDER BY DistrictName";

    const [rows] = await db.query(sql, params);

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

    if (roleId === 2) {
      const regionIDs = await getRoleExtensionRegionIDs(userId);
      if (regionIDs.length === 0) {
        return res.json([]);
      }

      const [districtRows] = await db.query(
        `
        SELECT regionID
        FROM tbldistrict
        WHERE DistrictID = ?
        LIMIT 1
        `,
        [districtID],
      );

      const districtRegionID = String(districtRows?.[0]?.regionID || "").trim();
      if (!districtRegionID || !regionIDs.includes(districtRegionID)) {
        return res.json([]);
      }
    }

    // role 5 sees only assigned TAIDs
    if (roleId === 5) {
      if (!userId) {
        return res.json([]);
      }

      const taIDs = await getAssignedTaIDs(userId);

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
    const authUser = parseAuthUser(req);
    const roleId = Number(authUser?.userRole);
    const userId = authUser?.id ? String(authUser.id) : "";

    if (roleId === 2) {
      const regionIDs = await getRoleExtensionRegionIDs(userId);
      if (regionIDs.length === 0) {
        return res.json([]);
      }

      const [taRows] = await db.query(
        `
        SELECT d.regionID
        FROM tblta t
        INNER JOIN tbldistrict d ON d.DistrictID = t.DistrictID
        WHERE t.TAID = ?
        LIMIT 1
        `,
        [taID],
      );

      const taRegionID = String(taRows?.[0]?.regionID || "").trim();
      if (!taRegionID || !regionIDs.includes(taRegionID)) {
        return res.json([]);
      }
    } else if (roleId === 5) {
      const taIDs = await getAssignedTaIDs(userId);
      if (
        taIDs.length === 0 ||
        !taIDs.includes(String(taID || "").trim())
      ) {
        return res.json([]);
      }
    }

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
