import { db } from "./db.js";
import { readFileSync, existsSync } from "node:fs";
import { withOpenYear } from "./openYear.js";

export function populateForests() {
  const rawPath = "data/all-forests-raw.json";
  if (!existsSync(rawPath)) {
    console.warn(`${rawPath} not found. Skipping forest population.`);
    return;
  }
  
  try {
    const rawData = JSON.parse(readFileSync(rawPath, "utf8"));
    const now = new Date().toISOString();
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO forest (instt_id, name, sido_code, instt_tp_cd, type, open_year, is_new, lat, lng, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    for (const item of rawData) {
      const type = item.insttTpCd === '01' ? '국립' : item.insttTpCd === '02' ? '공립' : '사립';
      const meta = withOpenYear({ name: item.insttNm });
      insertStmt.run(
        item.insttId,
        item.insttNm,
        item.sidoCode,
        item.insttTpCd,
        type,
        meta.openYear,
        meta.isNew ? 1 : 0,
        null, // lat
        null, // lng
        now
      );
    }
    console.log(`Successfully populated ${rawData.length} forests into SQLite DB.`);
  } catch (e) {
    console.error("Failed to populate forests table:", e);
  }
}
