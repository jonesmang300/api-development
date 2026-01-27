const express = require("express");
const router = express.Router();
const db = require("../config/db");

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
    const [rows] = await db.query(
      `
      SELECT TAID, TAName, DistrictID
      FROM tblta
      WHERE DistrictID = ?
      ORDER BY TAName
      `,
      [districtID],
    );

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
