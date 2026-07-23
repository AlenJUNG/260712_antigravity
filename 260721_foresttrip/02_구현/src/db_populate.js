import { db } from "./db.js";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withOpenYear } from "./openYear.js";
import { nowIso } from "./dates.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 카탈로그 캐시 적재: 휴양림 메타 + 달력(휴무/추첨).
 *
 * data/all-forests-raw.json 에는 186곳의 specialDates(정기휴무·추첨)와 maxNights 가
 * 이미 들어 있다. 예전 코드는 이걸 두고 REST 요청마다 사이트를 다시 긁으면서
 * 존재하지도 않는 필드(useDtList/hldtList)를 참조해 달력이 늘 비어 있었다.
 */
export function populateForests() {
  const rawPath = join(ROOT, "data", "all-forests-raw.json");
  if (!existsSync(rawPath)) {
    console.warn(`${rawPath} 없음. 휴양림 카탈로그 적재를 건너뜁니다.`);
    return { forests: 0, calendarDates: 0 };
  }

  try {
    const rawData = JSON.parse(readFileSync(rawPath, "utf8"));
    const now = nowIso();

    const insertForest = db.prepare(`
      INSERT INTO forest (instt_id, name, sido_code, instt_tp_cd, type, open_year, is_new,
                          lat, lng, max_nights, cycle_type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instt_id) DO UPDATE SET
        name = excluded.name, sido_code = excluded.sido_code, instt_tp_cd = excluded.instt_tp_cd,
        type = excluded.type, open_year = excluded.open_year, is_new = excluded.is_new,
        max_nights = excluded.max_nights, cycle_type = excluded.cycle_type,
        updated_at = excluded.updated_at
    `);
    const insertCal = db.prepare(`
      INSERT INTO forest_calendar (instt_id, date, kind, name, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(instt_id, date) DO UPDATE SET
        kind = excluded.kind, name = excluded.name, updated_at = excluded.updated_at
    `);

    let dateCount = 0;
    for (const item of rawData) {
      const type = item.insttTpCd === "01" ? "국립" : item.insttTpCd === "02" ? "공립" : "사립";
      const meta = withOpenYear({ name: item.insttNm });
      insertForest.run(
        item.insttId, item.insttNm, item.sidoCode, item.insttTpCd, type,
        meta.openYear ?? null, meta.isNew ? 1 : 0,
        null, null,
        item.maxNights ?? null, item.cycleType ?? null,
        now
      );

      for (const sd of item.specialDates || []) {
        // dtCd 01 = 정기휴무, 그 외(02 등) = 추첨. 명시되지 않은 날짜는 선착순으로 해석한다.
        insertCal.run(item.insttId, sd.date, sd.code === "01" ? "휴무" : "추첨", sd.name ?? null, now);
        dateCount++;
      }
    }
    console.log(`카탈로그 적재 완료: 휴양림 ${rawData.length}곳, 달력 특일 ${dateCount}건.`);
    return { forests: rawData.length, calendarDates: dateCount };
  } catch (e) {
    console.error("휴양림 카탈로그 적재 실패:", e);
    return { forests: 0, calendarDates: 0 };
  }
}
