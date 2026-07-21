// PoC 진입점(CLI)
//   node src/poc.js catalog [시도코드]              → 카탈로그/메타 조회 (브라우저 불필요)
//   node src/poc.js search <시도코드> <입실YYYYMMDD> <퇴실YYYYMMDD> [인원]
//                                                   → 예약가능 조회 (headful 브라우저)

import { writeFile, mkdir } from "node:fs/promises";
import { SIDO } from "./constants.js";
import { openSession } from "./session.js";
import { getSidoList, getInsttList, getFacilityCalendar } from "./catalog.js";

// 프로젝트 루트의 .env (FOREST_ID/FOREST_PW 등) 를 자동 로드
try { process.loadEnvFile(); } catch { /* .env 없으면 무시 */ }

const [cmd, a1, a2, a3, a4, a5] = process.argv.slice(2);
const TYPE = { "01": "국립", "02": "공립", "04": "사립" };

if (cmd === "catalog") {
  await runCatalog(a1);
} else if (cmd === "search") {
  await runSearch(a1, a2, a3, a4);
} else if (cmd === "rooms") {
  await runRooms(a1, a2, a3, a4, a5);
} else if (cmd === "rooms-region") {
  await runRoomsRegion(a1, a2, a3, a4);
} else if (cmd === "rooms-nation") {
  await runRoomsNation(a1, a2, a3);
} else if (cmd === "login-save") {
  await runLoginSave();
} else if (cmd === "scan-nation") {
  await runScanNation(a1, a2, a3);
} else {
  console.log(`사용법:
  node src/poc.js catalog [시도코드]
  node src/poc.js search <시도코드> <입실YYYYMMDD> <퇴실YYYYMMDD> [인원]
  node src/poc.js rooms <시도코드> <휴양림insttId> <입실> <퇴실> [인원]   (로그인)
  node src/poc.js rooms-region <시도코드> <입실> <퇴실> [인원]          (로그인, 지역 전체)
  node src/poc.js rooms-nation <입실> <퇴실> [인원]                     (로그인, 전국 전체)
  node src/poc.js login-save                                          (로그인 후 세션을 auth.json 에 저장)
  node src/poc.js scan-nation <입실> <퇴실> [인원]                      (auth.json 세션 재사용, 병렬, 재로그인 없음)

시도코드: ${Object.entries(SIDO).map(([k, v]) => `${k}=${v}`).join("  ")}`);
}

async function runCatalog(sido = "2") {
  const s = await openSession();
  console.log("세션 확보:", { csrf: s.csrf.slice(0, 8) + "…", cookie: s.cookie.split(";")[0] });

  const sidos = await getSidoList(s);
  console.log("\n[시/도 목록]");
  console.table(sidos);

  const forests = await getInsttList(s, sido);
  console.log(`\n[${SIDO[sido]}(${sido}) 휴양림 ${forests.length}곳]`);
  console.table(forests.slice(0, 15));

  if (forests[0]) {
    const cal = await getFacilityCalendar(s, forests[0].insttId);
    console.log(`\n[${forests[0].insttNm} 달력 메타] 최대숙박=${cal.maxNights}박, 주기=${cal.cycleType}`);
    console.table(cal.specialDates.slice(0, 12));
  }
}

async function runSearch(sido, checkin, checkout, nofpr = "2") {
  if (!sido || !checkin || !checkout) {
    console.error("인자 부족: search <시도코드> <입실YYYYMMDD> <퇴실YYYYMMDD> [인원]");
    process.exit(1);
  }
  const { searchRegionAvailability } = await import("./availability.js");
  const { closeBrowser } = await import("./browser.js");
  const res = await searchRegionAvailability({
    sido, checkin, checkout, nofpr: Number(nofpr),
    saveArtifacts: true,
  });
  await closeBrowser();
  console.log("\n[예약가능 조회 결과]");
  console.log(`성공 여부: ${res.ok} · 전체 ${res.count ?? 0}곳 · 예약가능 ${res.forests?.filter((f) => f.available).length ?? 0}곳`);
  console.table(res.forests);
}

async function runRooms(sido, insttId, checkin, checkout, nofpr = "2") {
  if (!sido || !insttId || !checkin || !checkout) {
    console.error("인자 부족: rooms <시도코드> <휴양림insttId> <입실YYYYMMDD> <퇴실YYYYMMDD> [인원]");
    process.exit(1);
  }
  // 멈춤(headful 대기) 방지: 명시하지 않으면 headless 로 실행
  if (process.env.HEADLESS === undefined) process.env.HEADLESS = "1";
  console.log(`[start] rooms sido=${sido} insttId=${insttId} ${checkin}~${checkout} (HEADLESS=${process.env.HEADLESS})`);

  const { createLoggedInContext } = await import("./login.js");
  const { searchForestGoods } = await import("./goods.js");
  const { closeBrowser } = await import("./browser.js");

  try {
    console.log("[1] 로그인 시도 (.env 의 ID/PW)…");
    const context = await createLoggedInContext();
    console.log("[2] 로그인 성공. 객실 상세 조회 중…");

    const res = await searchForestGoods({
      sido, insttId, checkin, checkout, nofpr: Number(nofpr),
      context, saveArtifacts: true, includeWait: true,
    });
    await context.close();

    if (res.needLogin) {
      console.log("[!] 여전히 로그인 화면 반환 — artifacts/goods.html 확인 필요.");
    } else {
      console.log(`\n[객실 단위 결과] 성공:${res.ok} · 파싱된 객실 후보 ${res.rooms.length}개`);
      console.table(res.rooms.slice(0, 30));
      console.log("\n※ 잠정 파서 결과. 정확 컬럼 확정은 artifacts/goods.html 기준.");
    }
  } catch (e) {
    console.error("[ERROR] rooms 실패:", e?.message || e);
    console.error("        진단: artifacts/login.png / login.html 을 확인하세요.");
  } finally {
    await (await import("./browser.js")).closeBrowser();
    console.log("[done]");
  }
}

async function runRoomsRegion(sido, checkin, checkout, nofpr = "2") {
  if (!sido || !checkin || !checkout) {
    console.error("인자 부족: rooms-region <시도코드> <입실YYYYMMDD> <퇴실YYYYMMDD> [인원]");
    process.exit(1);
  }
  if (process.env.HEADLESS === undefined) process.env.HEADLESS = "1";
  const { createLoggedInContext } = await import("./login.js");
  const { searchForestGoods } = await import("./goods.js");
  const { withOpenYear } = await import("./openYear.js");
  const { closeBrowser } = await import("./browser.js");

  console.log(`[start] rooms-region ${SIDO[sido]}(${sido}) ${checkin}~${checkout}`);
  const session = await openSession();
  const forests = await getInsttList(session, sido);
  console.log(`[1] ${SIDO[sido]} 휴양림 ${forests.length}곳`);

  const ctx = await createLoggedInContext();
  console.log(`[2] 로그인 성공. 각 휴양림 객실 조회 중… (다소 걸립니다)`);

  const rows = [];
  for (let i = 0; i < forests.length; i++) {
    const f = forests[i];
    try {
      const res = await searchForestGoods({ sido, insttId: f.insttId, checkin, checkout, nofpr: Number(nofpr), context: ctx });
      const hits = (res.rooms || []).filter((r) => r.status === "예약가능" || r.status === "대기가능");
      console.log(`  (${i + 1}/${forests.length}) ${f.insttNm}: ${res.needLogin ? "로그인필요" : `객실 ${res.rooms.length} · 예약/대기 ${hits.length}`}`);
      const oy = withOpenYear({ name: f.insttNm });
      for (const r of hits) {
        rows.push({
          시도: SIDO[sido],
          휴양림: `[${TYPE[f.insttTpCd] || f.insttTpCd}]${f.insttNm}`,
          개관연도: oy.openYear ?? "미상",
          신축: oy.openYear == null ? "-" : oy.isNew ? "O" : "X",
          숙박시설: r.facility,
          시설상세: r.detail,
          예약가능여부: r.status,
        });
      }
    } catch (e) {
      console.log(`  (${i + 1}/${forests.length}) ${f.insttNm}: 에러 ${e?.message || e}`);
    }
  }
  await ctx.close();
  await closeBrowser();

  console.log(`\n=== ${SIDO[sido]} ${checkin} 예약/대기 가능 시설 ${rows.length}건 ===`);
  console.table(rows);
  await writeFile("artifacts/rooms-region.json", JSON.stringify(rows, null, 2), "utf8");
  console.log("→ artifacts/rooms-region.json 저장 (전체 결과)");
}

async function runRoomsNation(checkin, checkout, nofpr = "2") {
  if (!checkin || !checkout) {
    console.error("인자 부족: rooms-nation <입실YYYYMMDD> <퇴실YYYYMMDD> [인원]");
    process.exit(1);
  }
  if (process.env.HEADLESS === undefined) process.env.HEADLESS = "1";
  const { createLoggedInContext } = await import("./login.js");
  const { searchForestGoods } = await import("./goods.js");
  const { withOpenYear } = await import("./openYear.js");
  const { closeBrowser } = await import("./browser.js");
  await mkdir("artifacts", { recursive: true });

  console.log(`[start] rooms-nation 전국 ${checkin}~${checkout}`);
  const session = await openSession();
  const all = [];
  for (const [code, name] of Object.entries(SIDO)) {
    const list = await getInsttList(session, code);
    for (const f of list) all.push({ ...f, sido: code, sidoName: name });
  }
  console.log(`[1] 전국 휴양림 ${all.length}곳 (약 ${Math.round((all.length * 6) / 60)}분 예상)`);

  const ctx = await createLoggedInContext();
  console.log(`[2] 로그인 성공. 전국 순회 시작…`);

  const rows = [];
  const save = () => writeFile("artifacts/rooms-region.json", JSON.stringify(rows, null, 2), "utf8");
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    try {
      const res = await searchForestGoods({ sido: f.sido, insttId: f.insttId, checkin, checkout, nofpr: Number(nofpr), context: ctx, includeWait: true, saveArtifacts: i === 0 });
      const hits = (res.rooms || []).filter((r) => r.status === "예약가능" || r.status === "대기가능");
      if (hits.length) {
        const nr = hits.filter((r) => r.status === "예약가능").length;
        const nw = hits.length - nr;
        console.log(`  (${i + 1}/${all.length}) [${f.sidoName}] ${f.insttNm}: 예약 ${nr} · 대기 ${nw}`);
      }
      else if ((i + 1) % 20 === 0) console.log(`  …진행 ${i + 1}/${all.length}`);
      const oy = withOpenYear({ name: f.insttNm });
      for (const r of hits) {
        rows.push({
          시도: f.sidoName,
          휴양림: `[${TYPE[f.insttTpCd] || f.insttTpCd}]${f.insttNm}`,
          개관연도: oy.openYear ?? "미상",
          신축: oy.openYear == null ? "-" : oy.isNew ? "O" : "X",
          숙박시설: r.facility,
          시설상세: r.detail,
          예약가능여부: r.status,
        });
      }
      if (hits.length || (i + 1) % 5 === 0) await save(); // 중간 저장(중단돼도 부분결과 보존)
    } catch (e) {
      console.log(`  (${i + 1}/${all.length}) [${f.sidoName}] ${f.insttNm}: 에러 ${e?.message || e}`);
    }
  }
  await ctx.close();
  await closeBrowser();
  await save();
  console.log(`\n=== 완료: 전국 ${checkin} 예약/대기 가능 시설 ${rows.length}건 → artifacts/rooms-region.json ===`);
  console.table(rows);
}

// 로그인 후 세션(쿠키)을 auth.json 에 저장. 이후 scan-nation 이 재로그인 없이 재사용.
async function runLoginSave() {
  if (process.env.HEADLESS === undefined) process.env.HEADLESS = "1";
  const { createLoggedInContext } = await import("./login.js");
  const { closeBrowser } = await import("./browser.js");
  console.log("[login-save] .env(ID/PW)로 로그인 중…");
  const ctx = await createLoggedInContext();
  await ctx.storageState({ path: "auth.json" });
  await ctx.close();
  await closeBrowser();
  console.log("[login-save] 완료 → auth.json 저장. 이제 재로그인 없이 scan-nation 사용 가능.");
}

// 저장된 세션(auth.json) 재사용 + 병렬로 전국 객실(예약+대기) 스캔. (비밀번호 입력 없음)
async function runScanNation(checkin, checkout, nofpr = "2") {
  if (!checkin || !checkout) { console.error("인자 부족: scan-nation <입실> <퇴실> [인원]"); process.exit(1); }
  if (process.env.HEADLESS === undefined) process.env.HEADLESS = "1";
  const { chromium } = await import("playwright");
  const { UA } = await import("./constants.js");
  const { searchForestGoods } = await import("./goods.js");
  const { withOpenYear } = await import("./openYear.js");
  const { existsSync } = await import("node:fs");
  if (!existsSync("auth.json")) { console.error("auth.json 없음 — 먼저 'login-save'를 실행하세요."); process.exit(1); }
  await mkdir("artifacts", { recursive: true });

  const session = await openSession();
  const all = [];
  for (const [code, name] of Object.entries(SIDO)) {
    const list = await getInsttList(session, code);
    for (const f of list) all.push({ ...f, sido: code, sidoName: name });
  }
  const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
  console.log(`[scan] 전국 ${all.length}곳 · 동시 ${CONCURRENCY}개 병렬 · ${checkin}~${checkout} (세션 재사용)`);

  const browser = await chromium.launch({ headless: process.env.HEADLESS === "1" });
  const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR", storageState: "auth.json" });

  const rows = [];
  const save = () => writeFile("artifacts/rooms-region.json", JSON.stringify(rows, null, 2), "utf8");
  let idx = 0, done = 0;
  async function worker() {
    while (idx < all.length) {
      const f = all[idx++];
      try {
        const res = await searchForestGoods({ sido: f.sido, insttId: f.insttId, checkin, checkout, nofpr: Number(nofpr), context: ctx, includeWait: true });
        const hits = (res.rooms || []).filter((r) => r.status === "예약가능" || r.status === "대기가능");
        const oy = withOpenYear({ name: f.insttNm });
        for (const r of hits) rows.push({ 시도: f.sidoName, 휴양림: `[${TYPE[f.insttTpCd] || f.insttTpCd}]${f.insttNm}`, 개관연도: oy.openYear ?? "미상", 신축: oy.openYear == null ? "-" : oy.isNew ? "O" : "X", 숙박시설: r.facility, 시설상세: r.detail, 예약가능여부: r.status, 대기순위: r.status === "대기가능" ? r.waitRank || "" : "" });
        if (hits.length) console.log(`  [${f.sidoName}] ${f.insttNm}: 예약 ${hits.filter((r) => r.status === "예약가능").length} 대기 ${hits.filter((r) => r.status === "대기가능").length}`);
      } catch (e) { console.log(`  ${f.insttNm}: 에러 ${e?.message || e}`); }
      if (++done % 5 === 0) await save();
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await ctx.close();
  await browser.close();
  await save();
  console.log(`\n=== 완료: 전국 ${checkin} 예약/대기 ${rows.length}건 → artifacts/rooms-region.json ===`);
}
