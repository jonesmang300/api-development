const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const db = require("../config/db");

function registerCrudRoutes({
  basePath,
  table,
  idField,
  fields,
  label,
  includeCreate = true,
  includeList = true,
}) {
  if (includeCreate) {
    router.post(basePath, async (req, res) => {
      const providedFields = fields.filter(
        (field) => req.body[field] !== undefined,
      );

      if (providedFields.length === 0) {
        return res.status(400).json({ message: "No valid fields provided" });
      }

      const columnsSql = providedFields
        .map((field) => `\`${field}\``)
        .join(", ");
      const placeholdersSql = providedFields.map(() => "?").join(", ");
      const values = providedFields.map((field) => req.body[field]);

      try {
        const sql = `
        INSERT INTO \`${table}\` (${columnsSql})
        VALUES (${placeholdersSql})
      `;

        const [result] = await db.query(sql, values);

        res.status(201).json({
          message: `${label} created successfully`,
          id: result.insertId || req.body[idField] || null,
        });
      } catch (error) {
        console.error(`Create ${label} error:`, error);
        res.status(500).json({ message: `Failed to create ${label}` });
      }
    });
  }

  if (includeList) {
    router.get(basePath, async (req, res) => {
      try {
        const sql = `
        SELECT *
        FROM \`${table}\`
        WHERE deleted = '0'
        ORDER BY \`${idField}\` DESC
      `;

        const [rows] = await db.query(sql);
        res.json(rows);
      } catch (error) {
        console.error(`Get all ${label} error:`, error);
        res.status(500).json({ message: `Failed to load ${label}` });
      }
    });
  }

  router.get(`${basePath}/:id`, async (req, res) => {
    try {
      const sql = `
        SELECT *
        FROM \`${table}\`
        WHERE \`${idField}\` = ?
          AND deleted = '0'
        LIMIT 1
      `;

      const [rows] = await db.query(sql, [req.params.id]);

      if (rows.length === 0) {
        return res.status(404).json({ message: `${label} not found` });
      }

      res.json(rows[0]);
    } catch (error) {
      console.error(`Get ${label} by id error:`, error);
      res.status(500).json({ message: `Failed to load ${label}` });
    }
  });

  router.patch(`${basePath}/:id`, async (req, res) => {
    const updateFields = fields.filter(
      (field) => req.body[field] !== undefined,
    );

    if (updateFields.length === 0) {
      return res
        .status(400)
        .json({ message: "No valid fields provided for update" });
    }

    const setSql = updateFields.map((field) => `\`${field}\` = ?`).join(", ");
    const values = updateFields.map((field) => req.body[field]);
    values.push(req.params.id);

    try {
      const sql = `
        UPDATE \`${table}\`
        SET ${setSql}
        WHERE \`${idField}\` = ?
          AND deleted = '0'
      `;

      const [result] = await db.query(sql, values);

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: `${label} not found` });
      }

      res.status(200).json({ message: `${label} updated successfully` });
    } catch (error) {
      console.error(`Update ${label} error:`, error);
      res.status(500).json({ message: `Failed to update ${label}` });
    }
  });

  router.patch(`${basePath}/:id/delete`, async (req, res) => {
    try {
      const sql = `
        UPDATE \`${table}\`
        SET deleted = '1'
        WHERE \`${idField}\` = ?
          AND deleted = '0'
      `;

      const [result] = await db.query(sql, [req.params.id]);

      if (result.affectedRows === 0) {
        return res.status(404).json({ message: `${label} not found` });
      }

      res.status(200).json({ message: `${label} deleted successfully` });
    } catch (error) {
      console.error(`Delete ${label} error:`, error);
      res.status(500).json({ message: `Failed to delete ${label}` });
    }
  });
}

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
    const payload = JSON.parse(payloadJson);
    return payload;
  } catch {
    return null;
  }
}

async function getTableColumns(tableName) {
  const [rows] = await db.query(`SHOW COLUMNS FROM \`${tableName}\``);
  return rows.map((row) => String(row.Field || ""));
}

async function getPreferredIdField(tableName, fallbacks) {
  const columns = await getTableColumns(tableName);
  return fallbacks.find((field) => columns.includes(field)) || fallbacks[0];
}

router.get("/groups", async (req, res) => {
  try {
    const authUser = parseAuthUser(req);
    const userId = authUser?.id ? String(authUser.id) : "";
    const roleId = Number(authUser?.userRole);

    let sql = `
      SELECT *
      FROM \`tblsctretargeting_group\`
      WHERE deleted = '0'
    `;
    const params = [];

    // Role 5 users are restricted by groups they created.
    if (roleId === 5 && !userId) {
      return res.json([]);
    }

    if (roleId === 5 && userId) {
      sql += " AND userID = ?";
      params.push(userId);
    }

    sql += " ORDER BY groupID DESC";

    const [groups] = await db.query(sql, params);
    res.json(groups);
  } catch (error) {
    console.error("Get all groups error:", error);
    res.status(500).json({ message: "Failed to load groups" });
  }
});

router.post("/groups", async (req, res) => {
  const fields = [
    "groupname",
    "DateEstablished",
    "regionID",
    "DistrictID",
    "TAID",
    "villageClusterID",
    "cohort",
    "projectID",
    "programID",
    "userID",
    "slgApproved",
  ];

  const projectCode = req.body.projectID || req.body.proj;
  const projectMap = {
    "01": "SLG",
    "02": "csG",
    "03": "CCI",
    "04": "LRP",
    "05": "nuG",
    "06": "RSG",
  };

  if (!projectCode || !projectMap[projectCode]) {
    return res.status(400).json({
      message: "projectID (or proj) must be one of: 01, 02, 03, 04, 05, 06",
    });
  }

  try {
    const [countRows] = await db.query(
      "SELECT COUNT(*) AS total FROM tblsctretargeting_group",
    );
    const nextCount = Number(countRows?.[0]?.total || 0) + 1;
    const paddedCount = String(nextCount).padStart(6, "0");
    const year = new Date().getFullYear();
    const generatedGroupID = `${year}/${projectMap[projectCode]}/${paddedCount}`;

    const providedFields = fields.filter(
      (field) => req.body[field] !== undefined,
    );

    const columns = ["groupID", ...providedFields];
    const values = [
      generatedGroupID,
      ...providedFields.map((field) => req.body[field]),
    ];

    const columnsSql = columns.map((column) => `\`${column}\``).join(", ");
    const placeholdersSql = columns.map(() => "?").join(", ");

    const sql = `
      INSERT INTO \`tblsctretargeting_group\` (${columnsSql})
      VALUES (${placeholdersSql})
    `;

    await db.query(sql, values);

    res.status(201).json({
      message: "group created successfully",
      id: generatedGroupID,
      groupID: generatedGroupID,
    });
  } catch (error) {
    console.error("Create group error:", error);
    res.status(500).json({ message: "Failed to create group" });
  }
});

registerCrudRoutes({
  basePath: "/groups",
  table: "tblsctretargeting_group",
  idField: "groupID",
  fields: [
    "groupname",
    "DateEstablished",
    "regionID",
    "DistrictID",
    "TAID",
    "villageClusterID",
    "cohort",
    "projectID",
    "programID",
    "userID",
    "slgApproved",
  ],
  label: "group",
  includeCreate: false,
  includeList: false,
});

registerCrudRoutes({
  basePath: "/group-savings",
  table: "tblsctretargeting_groupsavings",
  idField: "RecID",
  fields: ["GroupID", "DistrictID", "Yr", "Month", "Amount", "sType"],
  label: "group saving",
});

registerCrudRoutes({
  basePath: "/member-savings",
  table: "tblsctretargeting_member_savings",
  idField: "recID",
  fields: ["sppCode", "groupCode", "amount", "date", "sType"],
  label: "member saving",
});

registerCrudRoutes({
  basePath: "/meetings",
  table: "tblsctretargeting_meeting",
  idField: "meetID",
  fields: ["purpose", "meetingdate", "minutes", "groupCode"],
  label: "meeting",
});

registerCrudRoutes({
  basePath: "/meeting-attendance",
  table: "tblsctretargeting_meeting_attendance",
  idField: "id",
  fields: ["meetID", "groupCode", "sppCode"],
  label: "meeting attendance",
});

registerCrudRoutes({
  basePath: "/group-trainings",
  table: "tblsctretargeting_grouptrainings",
  idField: "TrainingID",
  fields: [
    "regionID",
    "districtID",
    "groupID",
    "TrainingTypeID",
    "StartDate",
    "FinishDate",
    "trainedBy",
    "Males",
    "Females",
  ],
  label: "group training",
});

router.get("/member-trainings", async (req, res) => {
  const table = "tblsctretargeting_member_training";

  try {
    let sql = `
      SELECT RecordID, groupID, sppCode, TrainingID, attendance, deleted
      FROM \`${table}\`
    `;
    const whereParts = [];
    const params = [];

    whereParts.push("deleted = '0'");

    if (req.query.trainingID) {
      whereParts.push("TrainingID = ?");
      params.push(req.query.trainingID);
    }

    if (req.query.groupID) {
      whereParts.push("groupID = ?");
      params.push(req.query.groupID);
    }

    if (req.query.sppCode) {
      whereParts.push("sppCode = ?");
      params.push(req.query.sppCode);
    }

    if (whereParts.length > 0) {
      sql += ` WHERE ${whereParts.join(" AND ")}`;
    }

    sql += " ORDER BY `RecordID` DESC";

    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (error) {
    console.error("Get member trainings error:", error);
    res.status(500).json({ message: "Failed to load member trainings" });
  }
});

router.post("/member-trainings", async (req, res) => {
  const table = "tblsctretargeting_member_training";

  try {
    const { groupID, sppCode, TrainingID, attendance } = req.body;

    if (!TrainingID) {
      return res.status(400).json({ message: "TrainingID is required" });
    }

    if (!sppCode) {
      return res.status(400).json({ message: "sppCode is required" });
    }

    const sql = `
      INSERT INTO \`${table}\` (\`groupID\`, \`sppCode\`, \`TrainingID\`, \`attendance\`)
      VALUES (?, ?, ?, ?)
    `;

    const [result] = await db.query(sql, [
      groupID || null,
      sppCode,
      TrainingID,
      attendance ?? "1",
    ]);

    res.status(201).json({
      message: "member training created successfully",
      id: result.insertId || null,
    });
  } catch (error) {
    console.error("Create member training error:", error);
    res.status(500).json({ message: "Failed to create member training" });
  }
});

registerCrudRoutes({
  basePath: "/group-igas",
  table: "tblsctretargeting_group_iga",
  idField: "recID",
  fields: [
    "groupID",
    "districtID",
    "bus_category",
    "type",
    "no_male",
    "no_female",
    "amount_invested",
    "imonth",
    "iyear",
  ],
  label: "group IGA",
});

registerCrudRoutes({
  basePath: "/member-igas",
  table: "tblsctretargeting_member_iga",
  idField: "recID",
  fields: [
    "groupID",
    "districtID",
    "sppCode",
    "bus_category",
    "type",
    "amount_invested",
    "imonth",
    "iyear",
  ],
  label: "member IGA",
});

router.get("/training-types", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT trainingTypeID, training_name, description
      FROM tbltraining_types
      ORDER BY training_name, trainingTypeID
      `,
    );

    res.json(rows);
  } catch (error) {
    console.error("Get training types error:", error);
    res.status(500).json({ message: "Failed to load training types" });
  }
});

router.get("/training-types/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT trainingTypeID, training_name, description
      FROM tbltraining_types
      WHERE trainingTypeID = ?
      LIMIT 1
      `,
      [req.params.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Training type not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get training type by id error:", error);
    res.status(500).json({ message: "Failed to load training type" });
  }
});

router.get("/training-facilitators", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT facilitatorID, title
      FROM tblfacilitator
      ORDER BY title, facilitatorID
      `,
    );

    res.json(rows);
  } catch (error) {
    console.error("Get training facilitators error:", error);
    res.status(500).json({ message: "Failed to load training facilitators" });
  }
});

router.get("/training-facilitators/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT facilitatorID, title
      FROM tblfacilitator
      WHERE facilitatorID = ?
      LIMIT 1
      `,
      [req.params.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Training facilitator not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get training facilitator by id error:", error);
    res.status(500).json({ message: "Failed to load training facilitator" });
  }
});

router.get("/business-categories", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT categoryID, catname
      FROM tblbusines_category
      ORDER BY catname, categoryID
      `,
    );

    res.json(rows);
  } catch (error) {
    console.error("Get business categories error:", error);
    res.status(500).json({ message: "Failed to load business categories" });
  }
});

router.get("/business-categories/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT categoryID, catname
      FROM tblbusines_category
      WHERE categoryID = ?
      LIMIT 1
      `,
      [req.params.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Business category not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get business category by id error:", error);
    res.status(500).json({ message: "Failed to load business category" });
  }
});

router.get("/iga-types", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT ID, categoryID, name, description
      FROM tbliga_types
      ORDER BY name, ID
      `,
    );

    res.json(rows);
  } catch (error) {
    console.error("Get IGA types error:", error);
    res.status(500).json({ message: "Failed to load IGA types" });
  }
});

router.get("/iga-types/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT ID, categoryID, name, description
      FROM tbliga_types
      WHERE ID = ?
      LIMIT 1
      `,
      [req.params.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "IGA type not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get IGA type by id error:", error);
    res.status(500).json({ message: "Failed to load IGA type" });
  }
});

router.get("/savings-types", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT TypeID, savings_name, description
      FROM tblsavings_types
      ORDER BY savings_name
      `,
    );
    res.json(rows);
  } catch (error) {
    console.error("Get savings types error:", error);
    res.status(500).json({ message: "Failed to load savings types" });
  }
});

router.get("/savings-types/:id", async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT TypeID, savings_name, description
      FROM tblsavings_types
      WHERE TypeID = ?
      LIMIT 1
      `,
      [req.params.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Savings type not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error("Get savings type by id error:", error);
    res.status(500).json({ message: "Failed to load savings type" });
  }
});

module.exports = router;
