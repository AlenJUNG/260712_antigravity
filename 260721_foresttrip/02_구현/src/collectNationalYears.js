// 국립 자연휴양림 개장연도 수집기.
// 산림청 국립자연휴양림관리소 '일반현황' 페이지의 "각 휴양림 현황" 표
// (휴양림명 · 지정년도 · 조성년도 · 개장년도 · 위치 …) 를 긁어
// data/national-open-years.json 으로 저장한다. 연 1회 정도 갱신하면 충분.
//
//   npm run collect

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { UA } from "./constants.js";
import { normalizeKey } from "./openYear.js";

const SRC =
  "https://huyang.forest.go.kr/kfsweb/kfi/kfs/cms/cmsView.do?mn=HUYG_01_03&cmsId=FC_000762";
const OUT = fileURLToPath(new URL("../data/national-open-years.json", import.meta.url));
const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

const yr = (s) => (/^\d{4}$/.test(s) ? Number(s) : null);

export async function collectNationalYears() {
  const res = await fetch(SRC, { headers: { "User-Agent": UA, "Accept-Language": "ko-KR" } });
  if (!res.ok) throw new Error(`일반현황 로드 실패: HTTP ${res.status}`);
  const html = await res.text();

  // "각 휴양림 현황" 표 구간만 잘라낸다.
  const start = html.indexOf("각 휴양림 현황");
  if (start < 0) throw new Error("‘각 휴양림 현황’ 표를 찾지 못함 (페이지 구조 변경?)");
  const section = html.slice(start, html.indexOf("</table>", start));

  const forests = [];
  for (const row of section.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      c[1].replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim()
    );
    if (cells.length < 4) continue; // 헤더(<th>)·빈 행 스킵
    const [name, designated, built, opened, location] = cells;
    if (!name || !/^\d{4}$/.test(opened)) continue;
    forests.push({
      name,
      key: normalizeKey(name),
      designated: yr(designated),
      built: yr(built),
      opened: yr(opened),
      location: location || null,
    });
  }
  if (!forests.length) throw new Error("파싱된 행이 0 (페이지 구조 변경 의심)");

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OUT, JSON.stringify({ source: SRC, count: forests.length, forests }, null, 2), "utf8");
  return forests;
}

// 직접 실행 시 수집
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectNationalYears()
    .then((f) => console.log(`국립 개장연도 ${f.length}곳 수집 완료 → data/national-open-years.json`))
    .catch((e) => { console.error("수집 실패:", e.message); process.exit(1); });
}
