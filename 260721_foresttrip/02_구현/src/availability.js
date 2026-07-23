// 예약가능(잔여) 조회 — NetFunnel 게이트 통과가 필요한 부분.
// 순수 HTTP(curl/fetch)로는 "정상적인 접근" 검증에서 302 → alert.do 로 튕긴다.
// 그래서 실제 브라우저(Playwright)로 페이지를 띄워 netfunnel.js 가 정상적으로
// netfunnel_key 를 발급받게 한 뒤, 사이트 자체 검색 함수(fn_top_goSearch)를 호출한다.

import { mkdir, writeFile } from "node:fs/promises";
import { BASE, ENDPOINTS, UA } from "./constants.js";
import { getBrowser } from "./browser.js";
import { withOpenYear } from "./openYear.js";

// 결과 목록 DOM에서 휴양림 목록을 추출한다. (page.evaluate 로 브라우저 컨텍스트에서 실행)
//   각 .rc_item = 휴양림 하나
//     .rc_ti i   → "[예약가능]/[예약불가]" 등 상태
//     .rc_ti b   → "[공립](홍천군)가리산자연휴양림"
//     .stay_info → "[객실] N개"
// ※ goods.extractRooms() 와 같은 패턴의 "순수 파서"다 — 셀렉터가 여기 한 곳에 격리되어야
//   사이트 개편 시 파서 회귀 테스트(test/parser.test.mjs)가 정확히 이 함수를 짚어준다.
export function extractForests() {
  const parseType = (s) => (s.match(/^\[(국립|공립|사립)\]/) || [])[1] ?? null;
  return [...document.querySelectorAll(".rc_item")].map((item) => {
    const status = item.querySelector(".rc_ti i")?.textContent?.replace(/[\[\]]/g, "").trim() ?? null;
    const rawName = item.querySelector(".rc_ti b")?.textContent?.trim() ?? "";
    const rooms = item.querySelector(".stay_info")?.textContent?.match(/\[객실\]\s*(\d+)개/)?.[1] ?? null;
    return {
      name: rawName.replace(/^\[(국립|공립|사립)\]/, ""),
      type: parseType(rawName),
      status,
      available: status === "예약가능",
      rooms: rooms ? Number(rooms) : null,
    };
  });
}

/**
 * 지역(시/도) + 날짜로 예약가능 휴양림 목록을 조회한다.
 * @param {object} opts
 * @param {string} opts.sido      시/도 코드 (예: "2" 강원)
 * @param {string} opts.checkin   입실일 YYYYMMDD
 * @param {string} opts.checkout  퇴실일 YYYYMMDD
 * @param {number} [opts.nofpr]   인원수 (기본 2)
 * @param {boolean} [opts.saveArtifacts]  결과 HTML/스크린샷 저장 여부 (기본 false)
 */
export async function searchRegionAvailability(opts) {
  const { sido, checkin, checkout, nofpr = 2, saveArtifacts = false } = opts;

  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: "ko-KR",
    viewport: { width: 1360, height: 960 },
  });
  const page = await ctx.newPage();

  try {
    await page.goto(BASE + ENDPOINTS.main, { waitUntil: "networkidle" });

    // 지역만 선택(특정 휴양림 미지정) → 지역 예약가능 목록 조회
    await page.evaluate((p) => {
      const set = (sel, val) => {
        const el = document.querySelector(sel);
        if (el) el.value = val;
      };
      set("#srchInsttArcd", p.sido);
      set("#srchInsttId", "");
      set("#rsrvtBgDt", p.checkin);
      set("#rsrvtEdDt", p.checkout);
      set("#calPicker", p.checkin);
      const n = document.querySelector("#stng_nofpr");
      if (n) n.innerHTML = String(p.nofpr);
    }, { sido, checkin, checkout, nofpr });

    // 결과 페이지로의 네비게이션을 걸어두고 사이트 검색을 트리거(NetFunnel 키 발급 포함).
    const nav = page.waitForURL(
      (url) => /fcfsRsrvtRcrfrDtlDetls\.do|com\/alert\.do/.test(url.toString()),
      { timeout: 25000 }
    );
    await page.evaluate(() => {
      if (typeof fn_top_goSearch === "function") fn_top_goSearch();
      else document.querySelector("form[name='srch_frm']")?.submit();
    });
    await nav.catch(() => {});

    const url = page.url();
    const ok = /fcfsRsrvtRcrfrDtlDetls\.do/.test(url);

    // 결과 목록은 innerFcfsRcrfrDtlDetls.do 가 AJAX로 채운다. .rc_item 이 뜰 때까지 대기.
    if (ok) await page.waitForSelector(".rc_item", { timeout: 15000 }).catch(() => {});

    if (saveArtifacts) {
      await mkdir("artifacts", { recursive: true });
      await writeFile("artifacts/result.html", await page.content(), "utf8");
      await page.screenshot({ path: "artifacts/result.png", fullPage: true });
    }

    // 결과 항목 파싱(순수 파서는 위 extractForests 로 분리 — 회귀 테스트 대상)
    const forests = await page.evaluate(extractForests);

    // 국립 휴양림에 한해 개장연도(openYear)/신축여부(isNew) 부착
    const enriched = forests.map(withOpenYear);
    return { ok, url, count: enriched.length, forests: enriched };
  } finally {
    await ctx.close(); // 브라우저는 재사용, 컨텍스트(세션)만 정리
  }
}
