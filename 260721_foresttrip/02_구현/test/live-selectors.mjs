// 라이브 셀렉터 헬스 체크 (온디맨드, 네트워크 필요) — 사이트 개편 감지.
//
//   node test/live-selectors.mjs
//
// 실제 사이트에 붙어 파서가 의존하는 엔드포인트/셀렉터가 아직 유효한지 점검한다.
// 오프라인 parser.test.mjs 가 "파서 로직"을 지킨다면, 이 스크립트는 "사이트 구조"를 지킨다.
// 각 항목을 개별로 PASS/FAIL 보고하므로 개편 시 어디가 깨졌는지 바로 짚어준다.
//
// - 무게이트 카탈로그(시도/휴양림/달력)는 로그인 없이 점검.
// - 가용성 페이지(.rc_item)는 NetFunnel 게이트만 통과(로그인 불필요).
// - goods 페이지(.goods_list_area/.list_box)는 로그인 세션이 있을 때만 점검(auth.json).
//
// 종료코드: 하나라도 FAIL 이면 1 (CI/스케줄 잡에서 감지 가능).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, ajaxGet } from "../src/session.js";
import { getSidoList, getInsttList, getFacilityCalendar } from "../src/catalog.js";
import { searchRegionAvailability } from "../src/availability.js";
import { getBrowser, closeBrowser } from "../src/browser.js";
import { BASE, ENDPOINTS, UA } from "../src/constants.js";
import { todayYmd, addDays, ymdToDate } from "../src/dates.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const results = [];
// 세션 만료·재고 없음처럼 "셀렉터 개편이 아닌" 이유로 판정 불가일 때 던지는 신호.
class Skip extends Error {}

function record(name, outcome, detail = "") {
  results.push({ name, outcome, detail });
  const tag = outcome === "pass" ? "  PASS" : outcome === "skip" ? "  SKIP" : "**FAIL**";
  console.log(`${tag}  ${name}${detail ? `  → ${detail}` : ""}`);
}
async function check(name, fn) {
  try {
    record(name, "pass", await fn());
  } catch (e) {
    record(name, e instanceof Skip ? "skip" : "fail", e.message);
  }
}

// 평일(선착순) 날짜를 골라야 가용성 결과가 의미있다(금·토·공휴일 전날은 추첨 → 늘 불가)
function weekdayDate(offset = 21) {
  let d = addDays(todayYmd(), offset);
  const dow = (x) => new Date(ymdToDate(x).getTime() + 9 * 3600e3).getUTCDay();
  while ([0, 5, 6].includes(dow(d))) d = addDays(d, 1);
  return d;
}

console.log("=== 라이브 셀렉터 헬스 체크 ===\n");
console.log("[1] 무게이트 카탈로그 엔드포인트 (로그인 불필요)");

let session, sidos, forests;
await check("openSession(): _csrf 토큰 발급", async () => {
  session = await openSession();
  if (!session.csrf) throw new Error("_csrf 없음");
  return `csrf ${session.csrf.slice(0, 8)}…`;
});

await check("GET selectSiDoList: 시/도 목록", async () => {
  sidos = await getSidoList(session);
  if (!Array.isArray(sidos) || sidos.length === 0) throw new Error("빈 목록");
  if (!sidos[0].code || !sidos[0].name) throw new Error(`필드 형식 변경: ${JSON.stringify(sidos[0])}`);
  return `${sidos.length}개 시도`;
});

await check("GET selectInsttListForSearch: 휴양림 목록", async () => {
  forests = await getInsttList(session, "2"); // 강원
  if (!Array.isArray(forests) || forests.length === 0) throw new Error("빈 목록");
  const f = forests[0];
  if (!f.insttId || !f.insttNm || !("insttTpCd" in f)) throw new Error(`필드 형식 변경: ${JSON.stringify(f)}`);
  return `강원 ${forests.length}곳`;
});

await check("GET selectFcFsRcfrsFcltInfo: 휴양림 달력 메타", async () => {
  const cal = await getFacilityCalendar(session, "0111"); // 대관령
  if (!("maxNights" in cal) || !Array.isArray(cal.specialDates)) throw new Error(`형식 변경: ${JSON.stringify(cal).slice(0, 120)}`);
  return `maxNights=${cal.maxNights}, 특일 ${cal.specialDates.length}건`;
});

console.log("\n[2] 가용성 페이지 (.rc_item, NetFunnel 게이트)");
const date = weekdayDate();
await check(`searchRegionAvailability: 강원 ${date}`, async () => {
  const r = await searchRegionAvailability({ sido: "2", checkin: date, checkout: addDays(date, 1), nofpr: 2 });
  if (!r.ok) throw new Error(`페이지 도달 실패(NetFunnel?): ${r.url}`);
  if (r.count === 0) throw new Error(".rc_item 0개 — 셀렉터 개편 의심");
  const f = r.forests[0];
  if (!f.name || !("status" in f)) throw new Error(`파싱 필드 변경: ${JSON.stringify(f)}`);
  const avail = r.forests.filter((x) => x.available).length;
  return `${r.count}곳 파싱(예약가능 ${avail}), 첫 항목 "${f.name}"`;
});

console.log("\n[3] goods 페이지 (.goods_list_area/.list_box, 로그인 필요)");
const authPath = join(HERE, "..", "auth.json");
if (!existsSync(authPath)) {
  record("goods 셀렉터 점검", "skip", "auth.json 없음(로그인 필요) → 셀렉터 판정 불가");
} else {
  await check("goods 페이지 구조(.goods_list_area/.item/.opt1)", async () => {
    const browser = await getBrowser();
    const ctx = await browser.newContext({
      userAgent: UA, locale: "ko-KR", viewport: { width: 1360, height: 1000 },
      storageState: JSON.parse(readFileSync(authPath, "utf8")),
    });
    const page = await ctx.newPage();
    try {
      await page.goto(BASE + ENDPOINTS.main, { waitUntil: "networkidle" });
      await page.evaluate((p) => {
        const s = (q, v) => { const e = document.querySelector(q); if (e) e.value = v; };
        s("#srchInsttArcd", p.sido); s("#srchInsttId", p.insttId);
        s("#rsrvtBgDt", p.checkin); s("#rsrvtEdDt", p.checkout); s("#calPicker", p.checkin);
        const n = document.querySelector("#stng_nofpr"); if (n) n.innerHTML = String(p.nofpr);
      }, { sido: "2", insttId: "0111", checkin: date, checkout: addDays(date, 1), nofpr: 2 });
      const nav = page.waitForURL((u) => /GoodsDetls\.do|com\/alert\.do|com\/login/.test(u.toString()), { timeout: 25000 });
      await page.evaluate(() => { if (typeof fn_top_goSearch === "function") fn_top_goSearch(); });
      await nav.catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(1500);

      const url = page.url();
      // 세션 만료는 셀렉터 개편이 아니다 → SKIP(auth.json 갱신 후 재실행 필요)
      if (/com\/login/.test(url) || (await page.$("#gnrlMmberPssrd"))) throw new Skip("세션 만료 — auth.json 갱신 후 재실행");
      if (!/GoodsDetls\.do/.test(url)) throw new Error(`goods 페이지 미도달: ${url}`);

      // 구조 점검: 컨테이너와 파서가 읽는 셀렉터가 존재하는지(재고 0이어도 컨테이너는 있어야 함)
      const probe = await page.evaluate(() => ({
        area: document.querySelectorAll(".goods_list_area").length,
        listBox: document.querySelectorAll(".goods_list_area .list_box").length,
        withItem: document.querySelectorAll(".goods_list_area .list_box .item[data-value]").length,
        withOpt1: document.querySelectorAll(".goods_list_area .list_box .opt1").length,
        defBtn: document.querySelectorAll(".goods_list_area .list_box .btn_group .defBtn").length,
        paging: !!document.querySelector(".paging_count"),
      }));
      if (probe.area === 0) throw new Error(".goods_list_area 없음 — 컨테이너 셀렉터 개편");
      if (probe.listBox > 0 && probe.withItem === 0) throw new Error(".item[data-value](goodsId) 셀렉터 개편");
      if (probe.listBox > 0 && probe.withOpt1 === 0) throw new Error(".opt1 셀렉터 개편");
      if (probe.listBox > 0 && probe.defBtn === 0) throw new Error(".btn_group .defBtn(상태) 셀렉터 개편");
      return `area ${probe.area}, list_box ${probe.listBox}, item ${probe.withItem}, opt1 ${probe.withOpt1}, paging ${probe.paging}`;
    } finally {
      await page.close().catch(() => {});
      await ctx.close().catch(() => {});
    }
  });
}

await closeBrowser();

const pass = results.filter((r) => r.outcome === "pass").length;
const skip = results.filter((r) => r.outcome === "skip");
const failed = results.filter((r) => r.outcome === "fail");
console.log(`\n=== PASS ${pass} · SKIP ${skip.length} · FAIL ${failed.length} (총 ${results.length}) ===`);
if (skip.length) console.log(`건너뜀: ${skip.map((r) => r.name).join(", ")}`);
if (failed.length) {
  console.log(`실패: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);   // 실제 셀렉터 개편만 비정상 종료 → CI/스케줄 잡이 감지
}
