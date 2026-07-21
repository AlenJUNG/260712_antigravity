import { openSession, ajaxGet } from "./src/session.js";
import { ENDPOINTS, SIDO } from "./src/constants.js";
import { lookupOpenYear } from "./src/openYear.js";
import { writeFile } from "node:fs/promises";

const TYPE = { "01": "국립", "02": "공립", "04": "사립" };

async function main() {
  try {
    console.log("세션 오픈 중...");
    const session = await openSession();
    console.log("세션 오픈 성공. 시도별 휴양림 목록 조회 중...");

    const allForests = [];
    for (const [sidoCode, sidoName] of Object.entries(SIDO)) {
      const data = await ajaxGet(session, ENDPOINTS.insttList, { srchSido: sidoCode });
      const list = data.insttList ?? [];
      console.log(`- ${sidoName} (${sidoCode}): ${list.length}개 휴양림 발견`);
      for (const item of list) {
        allForests.push({
          sidoCode,
          sidoName,
          insttId: item.insttId,
          insttNm: item.insttNm,
          insttTpCd: item.insttTpCd,
          insttTpNm: TYPE[item.insttTpCd] || "기타",
        });
      }
    }

    console.log(`전체 ${allForests.length}개 휴양림 달력 정보 수집 중 (병렬 처리)...`);

    // 병렬로 달력 정보 수집 (Concurrency: 10)
    const concurrency = 10;
    const results = [];
    let activeCount = 0;
    let index = 0;

    async function worker() {
      while (index < allForests.length) {
        const itemIndex = index++;
        const item = allForests[itemIndex];
        try {
          // 달력 API 호출
          const data = await ajaxGet(session, ENDPOINTS.fcltInfo, { insttId: item.insttId });
          const maxNights = data.rcfrsFcltInfo?.[0]?.mxmmStngDayCnt ?? null;
          const cycleType = data.RsrvtRgstnAvailVO?.rsrvtCycleTpeCd ?? null;
          const specialDates = (data.hldtList ?? []).map((h) => ({
            date: h.dt,
            code: h.dtCd,
            name: h.dtNm,
          }));

          // 국립휴양림 메타데이터 매칭
          const openYearInfo = lookupOpenYear(item.insttNm);

          results.push({
            ...item,
            maxNights,
            cycleType,
            specialDates,
            designated: openYearInfo?.designated ?? null,
            built: openYearInfo?.built ?? null,
            opened: openYearInfo?.opened ?? null,
            location: openYearInfo?.location ?? null,
          });
          
          if (results.length % 20 === 0 || results.length === allForests.length) {
            console.log(`수집 진행 상황: ${results.length}/${allForests.length}`);
          }
        } catch (err) {
          console.error(`에러 발생 (${item.insttNm}):`, err.message);
          results.push({
            ...item,
            maxNights: null,
            cycleType: null,
            specialDates: [],
            designated: null,
            built: null,
            opened: null,
            location: null,
            error: err.message,
          });
        }
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    await writeFile("data/all-forests-raw.json", JSON.stringify(results, null, 2), "utf8");
    console.log("성공적으로 data/all-forests-raw.json 파일에 저장 완료.");
  } catch (e) {
    console.error("수집 스크립트 실행 오류:", e);
  }
}

main();
