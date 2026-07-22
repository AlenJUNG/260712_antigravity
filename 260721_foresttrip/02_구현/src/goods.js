// 휴양림 단위보다 한 단계 깊은 "객실(시설) 단위" 예약가능 조회.
// 특정 휴양림 + 날짜 → fcfsRsrvtPssblGoodsDetls.do (NetFunnel 게이트 + 로그인 필요)
// 로 이동해 숙박시설 종류(휴양관/숲속의집…)·객실 상세·예약/대기 가능여부를 얻는다.
//
// ※ 이 페이지는 로그인 세션이 있어야 객실 목록이 보인다. login.js 로 만든
//    로그인 컨텍스트를 context 로 넘겨야 한다. (없으면 로그인 화면이 반환됨)

import { mkdir, writeFile } from "node:fs/promises";
import { BASE, ENDPOINTS, UA } from "./constants.js";
import { getBrowser } from "./browser.js";

// 객실 상세 페이지 DOM에서 방 목록을 추출한다. (page.evaluate 로 브라우저 컨텍스트에서 실행)
//   각 .list_box = 방 하나
//     .opt1 → "[휴양관]서어나무(2층)"  (숙박시설 [분류] + 방이름)
//     .opt2 → "5/5인실(31㎡)"          (인원/면적)
//     .opt3 → "1박(평일)102,000원"     (가격)
//     .btn_group .defBtn 의 txtRsrvt(예약하기)/txtWtng(대기신청) 중 display!=none 인 것 = 상태
export function extractRooms() {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  return [...document.querySelectorAll(".goods_list_area .list_box")].map((box) => {
    const goodsId = box.querySelector(".item")?.getAttribute("data-value") || null;

    const opt1 = box.querySelector(".opt1");
    let name = "";
    if (opt1) {
      const c = opt1.cloneNode(true);
      c.querySelectorAll(".icon_group").forEach((n) => n.remove()); // 아이콘/'사용가능 시설' 제거
      name = clean(c.textContent);
    }
    const facility = (name.match(/^\[([^\]]+)\]/) || [])[1] || null; // 숙박시설: 휴양관/숲속의집…
    const capacity = clean(box.querySelector(".opt2")?.textContent); // 5/5인실(31㎡)
    const price = clean(box.querySelector(".opt3")?.textContent);

    const rsrvt = box.querySelector(".btn_group .defBtn .txtRsrvt");
    const wtng = box.querySelector(".btn_group .defBtn .txtWtng");
    const canReserve = !!rsrvt && rsrvt.style.display !== "none";
    const canWait = !!wtng && wtng.style.display !== "none";
    const status = canReserve ? "예약가능" : canWait ? "대기가능" : null;

    // 대기 모드에서는 .opt4 에 대기 순번("2순위"/"3순위")이 들어온다.
    const waitRank = clean(box.querySelector(".opt4")?.textContent) || null;

    return {
      facility,                                   // 숙박시설
      detail: clean(`${name} ${capacity}`),       // 시설상세
      capacity, price, status,
      waitRank,                                   // 대기 순번(예: "2순위")
      available: canReserve, waitable: canWait,
      goodsId,
    };
  });
}

export async function searchForestGoods(opts) {
  const { sido, insttId, checkin, checkout, nofpr = 2, saveArtifacts = false, context = null, includeWait = false } = opts;

  const ctx = context || (await (await getBrowser()).newContext({ userAgent: UA, locale: "ko-KR", viewport: { width: 1360, height: 1200 } }));
  const ownCtx = !context; // 우리가 만든 컨텍스트면 우리가 닫는다
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + ENDPOINTS.main, { waitUntil: "networkidle" });
    await page.evaluate((p) => {
      const set = (s, v) => { const el = document.querySelector(s); if (el) el.value = v; };
      set("#srchInsttArcd", p.sido);
      set("#srchInsttId", p.insttId); // 특정 휴양림 지정 → goods detail 경로
      set("#rsrvtBgDt", p.checkin);
      set("#rsrvtEdDt", p.checkout);
      set("#calPicker", p.checkin);
      const n = document.querySelector("#stng_nofpr"); if (n) n.innerHTML = String(p.nofpr);
    }, { sido, insttId, checkin, checkout, nofpr });

    const nav = page.waitForURL((u) => /fcfsRsrvtPssblGoodsDetls\.do|com\/alert\.do|com\/login/.test(u.toString()), { timeout: 25000 });
    await page.evaluate(() => { if (typeof fn_top_goSearch === "function") fn_top_goSearch(); });
    await nav.catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1500);

    const url = page.url();
    const ok = /fcfsRsrvtPssblGoodsDetls\.do/.test(url);
    const needLogin = /com\/login/.test(url) || !!(await page.$("#gnrlMmberPssrd"));

    if (saveArtifacts) {
      await mkdir("artifacts", { recursive: true });
      await writeFile("artifacts/goods.html", await page.content(), "utf8");
      await writeFile("artifacts/goods.txt", await page.evaluate(() => document.body.innerText).catch(() => ""), "utf8");
      await page.screenshot({ path: "artifacts/goods.png", fullPage: true });
    }

    if (needLogin) return { ok: false, url, needLogin: true, rooms: [] };

    // 예약가능(rsrvtWtngSctin=01) 모드 파싱 (페이지네이션 순회)
    let reserveRooms = [];
    let pagesTraversed = 0;
    let complete = true;
    try {
      const totalPages = await page.evaluate(() => {
        const pag = document.querySelector(".paging_count");
        if (!pag) return 1;
        const match = pag.textContent.match(/\(\s*\d+\s*\/\s*(\d+)\s*\)/);
        return match ? parseInt(match[1], 10) : 1;
      });
      pagesTraversed += 1;
      reserveRooms = reserveRooms.concat(await page.evaluate(extractRooms));
      for (let p = 2; p <= totalPages; p++) {
        await page.evaluate((pageNum) => { if (typeof fn_goPage === "function") fn_goPage(String(pageNum)); }, p);
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000);
        pagesTraversed += 1;
        reserveRooms = reserveRooms.concat(await page.evaluate(extractRooms));
      }
    } catch (e) {
      complete = false;
    }
    let rooms = reserveRooms;

    // 대기가능(02) 모드 추가 조회: 사이트의 fn_wtng_goSrch()로 "대기 가능한 방" 재조회 (페이지네이션 순회)
    if (includeWait) {
      try {
        await page.evaluate(() => { if (typeof fn_wtng_goSrch === "function") fn_wtng_goSrch(); });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1500);
        if (saveArtifacts) await writeFile("artifacts/goods-wtng.html", await page.content(), "utf8");
        
        let waitRooms = [];
        const totalPages = await page.evaluate(() => {
          const pag = document.querySelector(".paging_count");
          if (!pag) return 1;
          const match = pag.textContent.match(/\(\s*\d+\s*\/\s*(\d+)\s*\)/);
          return match ? parseInt(match[1], 10) : 1;
        });
        pagesTraversed += 1;
        waitRooms = waitRooms.concat(await page.evaluate(extractRooms));
        for (let p = 2; p <= totalPages; p++) {
          await page.evaluate((pageNum) => { if (typeof fn_goPage === "function") fn_goPage(String(pageNum)); }, p);
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1000);
          pagesTraversed += 1;
          waitRooms = waitRooms.concat(await page.evaluate(extractRooms));
        }
        
        const seen = new Set(reserveRooms.map((r) => r.goodsId));
        rooms = reserveRooms.concat(waitRooms.filter((r) => r.goodsId && !seen.has(r.goodsId)));
      } catch (e) {
        complete = false;
      }
    }
    return { ok, url, needLogin: false, rooms, pagesTraversed, complete };
  } finally {
    await page.close();
    if (ownCtx) await ctx.close();
  }
}
