const express = require("express");
const router = express.Router();
const db = require("../config/db");

/* ===============================
   GET BENEFICIARIES BY VILLAGE
   =============================== */
router.get("/beneficiaries/filter", async (req, res) => {
  const { villageClusterID, lastSync } = req.query;

  if (!villageClusterID) {
    return res.status(400).json({ message: "villageClusterID is required" });
  }

  try {
    let sql = `
      SELECT 
        sppCode,
        hh_head_name,
        sex,
        dob,
        nat_id,
        hh_code,
        regionID,
        districtID,
        taID,
        villageClusterID,
        groupname,
        selected,
        created_at,
        updated_at
      FROM tblsctretargeting_beneficiaries
      WHERE villageClusterID = ?
    `;
    const params = [villageClusterID];

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
   UPDATE SINGLE BENEFICIARY
   =============================== */
router.patch("/beneficiaries/:sppCode", async (req, res) => {
  try {
    const { sppCode } = req.params;
    const { sex, dob, nat_id, groupname, selected } = req.body;

    const [result] = await db.query(
      `
      UPDATE tblsctretargeting_beneficiaries
      SET
        sex = COALESCE(?, sex),
        dob = COALESCE(?, dob),
        nat_id = COALESCE(?, nat_id),
        groupname = COALESCE(?, groupname),
        selected = COALESCE(?, selected),
        updated_at = NOW()
      WHERE sppCode = ?
      `,
      [sex, dob, nat_id, groupname, selected, sppCode],
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
  try {
    await conn.beginTransaction();

    for (const b of updates) {
      await conn.query(
        `
        UPDATE tblsctretargeting_beneficiaries
        SET
          sex = COALESCE(?, sex),
          dob = COALESCE(?, dob),
          nat_id = COALESCE(?, nat_id),
          groupname = COALESCE(?, groupname),
          selected = COALESCE(?, selected),
          updated_at = NOW()
        WHERE sppCode = ?
        `,
        [b.sex, b.dob, b.nat_id, b.groupname, b.selected, b.sppCode],
      );
    }

    await conn.commit();
    res.json({ message: "✅ Sync completed", count: updates.length });
  } catch (error) {
    await conn.rollback();
    console.error(error);
    res.status(500).json({ message: "Bulk sync failed" });
  } finally {
    conn.release();
  }
});

module.exports = router;
