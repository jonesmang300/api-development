const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../config/db");

let beneficiaryGroupColumnsCache = null;

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

async function getBeneficiaryVisibilityFilter(req, alias = "") {
  const authUser = parseAuthUser(req);
  const roleId = Number(authUser?.userRole || 0);
  const userId = authUser?.id ? String(authUser.id) : "";
  const prefix = alias ? `${alias}.` : "";

  if (roleId === 1) {
    return { sql: "", params: [], deny: false };
  }

  if (roleId === 2) {
    const regionIDs = await getRoleExtensionRegionIDs(userId);
    if (regionIDs.length === 0) {
      return { sql: "", params: [], deny: true };
    }

    return {
      sql: ` AND ${prefix}regionID IN (${regionIDs.map(() => "?").join(", ")})`,
      params: regionIDs,
      deny: false,
    };
  }

  if (roleId === 5) {
    const taIDs = await getAssignedTaIDs(userId);
    if (taIDs.length === 0) {
      return { sql: "", params: [], deny: true };
    }

    return {
      sql: ` AND ${prefix}taID IN (${taIDs.map(() => "?").join(", ")})`,
      params: taIDs,
      deny: false,
    };
  }

  return { sql: "", params: [], deny: false };
}

const getBeneficiaryGroupColumns = async () => {
  if (beneficiaryGroupColumnsCache) {
    return beneficiaryGroupColumnsCache;
  }

  const [groupCodeRows] = await db.query(
    "SHOW COLUMNS FROM tblsctretargeting_beneficiaries LIKE 'groupCode'",
  );
  const [groupIDRows] = await db.query(
    "SHOW COLUMNS FROM tblsctretargeting_beneficiaries LIKE 'groupID'",
  );

  beneficiaryGroupColumnsCache = {
    hasGroupCode: groupCodeRows.length > 0,
    hasGroupID: groupIDRows.length > 0,
  };

  return beneficiaryGroupColumnsCache;
};

const buildGroupSelectSql = async () => {
  const { hasGroupCode, hasGroupID } = await getBeneficiaryGroupColumns();

  if (hasGroupCode && hasGroupID) {
    return "groupCode, groupID,";
  }
  if (hasGroupCode && !hasGroupID) {
    return "groupCode, groupCode AS groupID,";
  }
  if (!hasGroupCode && hasGroupID) {
    return "groupID AS groupCode, groupID,";
  }
  return "NULL AS groupCode, NULL AS groupID,";
};

const buildGroupWhereSql = async () => {
  const { hasGroupCode, hasGroupID } = await getBeneficiaryGroupColumns();

  if (hasGroupCode && hasGroupID) {
    return {
      whereSql: "(groupCode = ? OR groupID = ?)",
      paramsFor: (groupCode) => [groupCode, groupCode],
    };
  }

  if (hasGroupCode) {
    return {
      whereSql: "groupCode = ?",
      paramsFor: (groupCode) => [groupCode],
    };
  }

  if (hasGroupID) {
    return {
      whereSql: "groupID = ?",
      paramsFor: (groupCode) => [groupCode],
    };
  }

  return null;
};

/* ===============================
   GET BENEFICIARIES BY VILLAGE
   =============================== */
router.get("/beneficiaries/filter", async (req, res) => {
  const { villageClusterID, lastSync } = req.query;

  if (!villageClusterID) {
    return res.status(400).json({ message: "villageClusterID is required" });
  }

  try {
    const visibility = await getBeneficiaryVisibilityFilter(req);
    if (visibility.deny) {
      return res.json([]);
    }

    const groupSelectSql = await buildGroupSelectSql();

    let sql = `
      SELECT 
        sppCode,
        hh_head_name,
        sex,
        dob,
        nat_id,
        hh_size,
        hh_code,
        regionID,
        districtID,
        taID,
        villageClusterID,
        groupname,
        ${groupSelectSql}
        selected,
        created_at,
        updated_at
      FROM tblsctretargeting_beneficiaries
      WHERE villageClusterID = ?
    `;
    const params = [villageClusterID, ...visibility.params];
    sql += visibility.sql;

    /* Incremental sync support */
    if (lastSync) {
      sql += " AND updated_at > ?";
      params.push(lastSync);
    }

    sql += " ORDER BY hh_head_name";

    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===============================
   LIST VERIFIED BENEFICIARIES
   FILTERED BY VILLAGE CLUSTER
   =============================== */
router.get("/beneficiaries/verified", async (req, res) => {
  const { villageClusterID } = req.query;

  if (!villageClusterID) {
    return res.status(400).json({ message: "villageClusterID is required" });
  }

  try {
    const visibility = await getBeneficiaryVisibilityFilter(req);
    if (visibility.deny) {
      return res.json([]);
    }

    const sql = `
      SELECT
        sppCode,
        groupname,
        hh_head_name,
        hh_code,
        villageClusterID
      FROM tblsctretargeting_beneficiaries
      WHERE selected = '1' AND villageClusterID = ?
      ${visibility.sql}
      ORDER BY groupname, hh_head_name
    `;

    const [rows] = await db.query(sql, [villageClusterID, ...visibility.params]);
    res.json(rows);
  } catch (error) {
    console.error("Verified list error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===============================
   LIST VERIFIED BENEFICIARIES
   FILTERED BY VILLAGE CLUSTER AND DEVICEID
   =============================== */
router.get("/beneficiaries/verified/deviceId", async (req, res) => {
  const { villageClusterID, deviceId } = req.query;

  if (!villageClusterID) {
    return res.status(400).json({ message: "villageClusterID is required" });
  }

  if (!deviceId) {
    return res.status(400).json({ message: "deviceId is required" });
  }

  try {
    const visibility = await getBeneficiaryVisibilityFilter(req);
    if (visibility.deny) {
      return res.json([]);
    }

    const sql = `
      SELECT
        sppCode,
        groupname,
        hh_head_name,
        hh_code,
        villageClusterID
      FROM tblsctretargeting_beneficiaries
      WHERE selected = '1'
        AND villageClusterID = ?
        AND deviceId = ?
        ${visibility.sql}
      ORDER BY groupname, hh_head_name
    `;

    const [rows] = await db.query(sql, [
      villageClusterID,
      deviceId,
      ...visibility.params,
    ]);
    res.json(rows);
  } catch (error) {
    console.error("Verified list error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===============================
   LIST BENEFICIARIES BY GROUP CODE/ID
   =============================== */
router.get("/beneficiaries/group", async (req, res) => {
  const { groupCode } = req.query;

  if (!groupCode) {
    return res.status(400).json({ message: "groupCode is required" });
  }

  try {
    const visibility = await getBeneficiaryVisibilityFilter(req);
    if (visibility.deny) {
      return res.json([]);
    }

    const groupSelectSql = await buildGroupSelectSql();
    const whereConfig = await buildGroupWhereSql();

    if (!whereConfig) {
      return res.status(500).json({
        message: "Neither groupCode nor groupID column exists on beneficiaries",
      });
    }

    const sql = `
      SELECT
        sppCode,
        hh_head_name,
        sex,
        dob,
        nat_id,
        hh_size,
        hh_code,
        regionID,
        districtID,
        taID,
        villageClusterID,
        groupname,
        ${groupSelectSql}
        selected
      FROM tblsctretargeting_beneficiaries
      WHERE ${whereConfig.whereSql}
      ${visibility.sql}
      ORDER BY hh_head_name
    `;

    const [rows] = await db.query(sql, [
      ...whereConfig.paramsFor(String(groupCode).trim()),
      ...visibility.params,
    ]);
    res.json(rows);
  } catch (error) {
    console.error("Group beneficiaries error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

const getRequestedSppCode = (req) => {
  const queryCode =
    req.query && typeof req.query.sppCode === "string"
      ? req.query.sppCode
      : "";
  const paramCode =
    req.params && typeof req.params.sppCode === "string"
      ? req.params.sppCode
      : "";

  return String(queryCode || paramCode || "").trim();
};

const handleGetBeneficiary = async (req, res) => {
  const sppCode = getRequestedSppCode(req);

  if (!sppCode) {
    return res.status(400).json({ message: "sppCode is required" });
  }

  try {
    const visibility = await getBeneficiaryVisibilityFilter(req);
    if (visibility.deny) {
      return res.status(404).json({ message: "Beneficiary not found" });
    }

    const groupSelectSql = await buildGroupSelectSql();

    const sql = `
      SELECT
        sppCode,
        hh_head_name,
        sex,
        dob,
        nat_id,
        hh_size,
        hh_code,
        regionID,
        districtID,
        taID,
        villageClusterID,
        groupname,
        ${groupSelectSql}
        selected,
        created_at,
        updated_at
      FROM tblsctretargeting_beneficiaries
      WHERE sppCode = ?
      ${visibility.sql}
      LIMIT 1
    `;

    const [rows] = await db.query(sql, [sppCode, ...visibility.params]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "Beneficiary not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get beneficiary error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

/* ===============================
   GET SINGLE BENEFICIARY BY sppCode
   =============================== */
router.get("/beneficiaries", async (req, res, next) => {
  if (!getRequestedSppCode(req)) {
    return next();
  }

  return handleGetBeneficiary(req, res);
});

router.get("/beneficiaries/:sppCode", handleGetBeneficiary);

/* ===============================
   UPDATE SINGLE BENEFICIARY
   =============================== */
const handlePatchBeneficiary = async (req, res) => {
  try {
    const visibility = await getBeneficiaryVisibilityFilter(req);
    if (visibility.deny) {
      return res.status(404).json({ message: "Beneficiary not found" });
    }

    const sppCode = getRequestedSppCode(req);
    const body = req.body || {};
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(body, key);
    const groupValue = hasOwn("groupCode")
      ? body.groupCode
      : hasOwn("groupID")
        ? body.groupID
        : undefined;
    const { hasGroupCode, hasGroupID } = await getBeneficiaryGroupColumns();

    const setParts = [];
    const values = [];

    if (hasOwn("sex")) {
      setParts.push("sex = ?");
      values.push(body.sex);
    }

    if (hasOwn("dob")) {
      setParts.push("dob = ?");
      values.push(body.dob);
    }

    if (hasOwn("nat_id")) {
      setParts.push("nat_id = ?");
      values.push(body.nat_id);
    }

    if (hasOwn("hh_size")) {
      setParts.push("hh_size = ?");
      values.push(body.hh_size);
    }

    if (hasOwn("hh_code")) {
      setParts.push("hh_code = ?");
      values.push(body.hh_code);
    }

    if (hasOwn("groupname")) {
      setParts.push("groupname = ?");
      values.push(body.groupname);
    }

    if (hasGroupCode && groupValue !== undefined) {
      setParts.push("groupCode = ?");
      values.push(groupValue);
    }

    if (hasGroupID && groupValue !== undefined) {
      setParts.push("groupID = ?");
      values.push(groupValue);
    }

    if (hasOwn("selected")) {
      setParts.push("selected = ?");
      values.push(body.selected);
    }

    if (setParts.length === 0) {
      return res.status(400).json({ message: "No beneficiary fields provided" });
    }

    setParts.push("updated_at = NOW()");
    values.push(sppCode, ...visibility.params);

    const [result] = await db.query(
      `
      UPDATE tblsctretargeting_beneficiaries
      SET
        ${setParts.join(", ")}
      WHERE sppCode = ?
      ${visibility.sql}
      `,
      values,
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Beneficiary not found" });
    }

    res.sendStatus(204);
  } catch (err) {
    console.error("DB Error:", err.code || err.message);

    if (err.code === "ECONNREFUSED") {
      return res.status(503).json({ message: "Database unavailable" });
    }

    res.status(500).json({ message: "Internal server error" });
  }
};

router.patch("/beneficiaries", async (req, res, next) => {
  if (!getRequestedSppCode(req)) {
    return next();
  }

  return handlePatchBeneficiary(req, res);
});

router.patch("/beneficiaries/:sppCode", handlePatchBeneficiary);

/* ===============================
   COUNT ALL VERIFIED BENEFICIARIES
   =============================== */
router.get("/beneficiaries/count/selected", async (req, res) => {
  try {
    const visibility = await getBeneficiaryVisibilityFilter(req);
    if (visibility.deny) {
      return res.json({ total: 0 });
    }

    const sql = `
      SELECT COUNT(sppCode) AS total
      FROM tblsctretargeting_beneficiaries
      WHERE selected = '1'
      ${visibility.sql}
    `;

    const [rows] = await db.query(sql, visibility.params);

    res.json({
      total: rows[0].total,
    });
  } catch (error) {
    console.error("Count error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===============================
   BULK SYNC (OFFLINE → ONLINE)
   =============================== */
router.post("/beneficiaries/bulk-sync", async (req, res) => {
  const updates = req.body;

  if (!Array.isArray(updates)) {
    return res.status(400).json({ message: "Invalid payload" });
  }

  const conn = await db.getConnection();
  let currentSppCode = null;
  let currentIndex = -1;

  try {
    await conn.beginTransaction();
    const { hasGroupCode, hasGroupID } = await getBeneficiaryGroupColumns();
    const [[{ hasDeviceId = 0 } = {}]] = await conn.query(
      "SELECT COUNT(*) AS hasDeviceId FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'tblsctretargeting_beneficiaries' AND COLUMN_NAME = 'deviceId'",
    );

    for (let index = 0; index < updates.length; index += 1) {
      const b = updates[index];
      currentIndex = index;
      currentSppCode = b?.sppCode || null;

      if (!currentSppCode) {
        throw new Error(`Missing sppCode at item ${index + 1}`);
      }

      const groupValue = b.groupCode ?? b.groupID ?? null;
      const setParts = [
        "sex = COALESCE(?, sex)",
        "dob = COALESCE(?, dob)",
        "nat_id = COALESCE(?, nat_id)",
        "hh_size = COALESCE(?, hh_size)",
        "groupname = COALESCE(?, groupname)",
      ];
      const values = [b.sex, b.dob, b.nat_id, b.hh_size, b.groupname];

      if (hasGroupCode) {
        setParts.push("groupCode = COALESCE(?, groupCode)");
        values.push(groupValue);
      }

      if (hasGroupID) {
        setParts.push("groupID = COALESCE(?, groupID)");
        values.push(groupValue);
      }

      setParts.push(`
        selected = CASE
          WHEN ? IS NOT NULL THEN ?
          ELSE selected
        END
      `);
      values.push(b.selected, b.selected);

      if (hasDeviceId) {
        setParts.push("deviceId = COALESCE(?, deviceId)");
        values.push(b.deviceId);
      }

      setParts.push("updated_at = NOW()");
      values.push(currentSppCode);

      const [result] = await conn.query(
        `
        UPDATE tblsctretargeting_beneficiaries
        SET
          ${setParts.join(", ")}
        WHERE sppCode = ?
        `,
        values,
      );

      if (Number(result?.affectedRows || 0) === 0) {
        throw new Error(`Beneficiary not found for sppCode ${currentSppCode}`);
      }
    }

    await conn.commit();
    res.json({ message: "✅ Sync completed", count: updates.length });
  } catch (error) {
    await conn.rollback();
    const detail =
      error?.sqlMessage ||
      error?.message ||
      error?.code ||
      "Unknown bulk sync error";

    console.error("Bulk sync failed", {
      index: currentIndex,
      sppCode: currentSppCode,
      code: error?.code,
      sqlMessage: error?.sqlMessage,
      message: error?.message,
    });

    res.status(500).json({
      message: currentSppCode
        ? `Bulk sync failed for ${currentSppCode}: ${detail}`
        : `Bulk sync failed: ${detail}`,
      sppCode: currentSppCode,
      index: currentIndex >= 0 ? currentIndex : undefined,
      detail,
    });
  } finally {
    conn.release();
  }
});

router.get(
  "/beneficiaries/count/selected/device/:deviceId",
  async (req, res) => {
    const { deviceId } = req.params;

    if (!deviceId) {
      return res.status(400).json({ message: "deviceId is required" });
    }

    try {
      const visibility = await getBeneficiaryVisibilityFilter(req);
      if (visibility.deny) {
        return res.json({ total: 0 });
      }

      const [rows] = await db.query(
        `
      SELECT COUNT(*) AS total
      FROM tblsctretargeting_beneficiaries
      WHERE selected = '1'
      AND deviceId = ?
      ${visibility.sql}
      `,
        [deviceId, ...visibility.params],
      );

      res.json({ total: Number(rows?.[0]?.total || 0) });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  },
);

/* ===============================
   SUMMARY BY GROUPNAME (SEX COUNTS)
   FILTERED BY VILLAGE CLUSTER
   =============================== */
router.get("/beneficiaries/summary/group", async (req, res) => {
  const { villageClusterID } = req.query;

  if (!villageClusterID) {
    return res.status(400).json({ message: "villageClusterID is required" });
  }

  try {
    const visibility = await getBeneficiaryVisibilityFilter(req);
    if (visibility.deny) {
      return res.json([]);
    }

    const sql = `
      SELECT
        groupname,

        SUM(
          CASE
            WHEN sex IN ('01', 'M', 'm') THEN 1
            ELSE 0
          END
        ) AS males,

        SUM(
          CASE
            WHEN sex IN ('02', 'F', 'f') THEN 1
            ELSE 0
          END
        ) AS females,

        COUNT(*) AS total

      FROM tblsctretargeting_beneficiaries
      WHERE villageClusterID = ?
        AND groupname IS NOT NULL
        AND TRIM(groupname) <> ''
        ${visibility.sql}
      GROUP BY groupname
      ORDER BY groupname ASC
    `;

    const [rows] = await db.query(sql, [villageClusterID, ...visibility.params]);

    res.json(rows);
  } catch (error) {
    console.error("Summary error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===============================
   SUMMARY BY VERIFIED MEMBERS
   FILTERED BY VILLAGE CLUSTER
   =============================== */
router.get("/beneficiaries/summary/verified/totals", async (req, res) => {
  const { villageClusterID } = req.query;

  if (!villageClusterID) {
    return res.status(400).json({ message: "villageClusterID is required" });
  }

  try {
    const visibility = await getBeneficiaryVisibilityFilter(req);
    if (visibility.deny) {
      return res.json({ M: 0, F: 0, Total: 0 });
    }

    const sql = `
      SELECT
        SUM(CASE WHEN sex IN ('01', 'M', 'm') THEN 1 ELSE 0 END) AS M,
        SUM(CASE WHEN sex IN ('02', 'F', 'f') THEN 1 ELSE 0 END) AS F,
        (
          SUM(CASE WHEN sex IN ('01', 'M', 'm') THEN 1 ELSE 0 END) +
          SUM(CASE WHEN sex IN ('02', 'F', 'f') THEN 1 ELSE 0 END)
        ) AS Total
      FROM tblsctretargeting_beneficiaries
      WHERE selected = '1'
        AND villageClusterID = ?
        ${visibility.sql}
    `;

    const [rows] = await db.query(sql, [villageClusterID, ...visibility.params]);

    res.json(rows[0]);
  } catch (error) {
    console.error("Verified totals error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
