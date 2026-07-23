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

/** 현재 렌더된 목록의 지문(goodsId 나열) — 페이지 전환이 실제로 일어났는지 판정용 */
function listSignature() {
  return [...document.querySelectorAll(".goods_list_area .list_box .item")]
    .map((el) => el.getAttribute("data-value") || "")
    .join(",");
}

/**
 * ".paging_count" 의 "(cur/total)" 을 읽는다. 없으면 1/1.
 *
 * ※ cur 를 반드시 함께 읽어야 한다. `fn_wtng_goSrch()` 로 대기 모드에 들어가면 사이트가
 *   **예약 모드에서 보던 페이지 번호를 그대로 물려준다**(실측: 예약 2페이지에서 전환하면
 *   대기 결과도 "(2/5)" 로 시작). 1페이지에서 시작한다고 가정하면 그 페이지를 통째로 놓친다.
 */
function readPaging() {
  const pag = document.querySelector(".paging_count");
  if (!pag) return { cur: 1, total: 1 };
  const m = pag.textContent.match(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)/);
  return m ? { cur: parseInt(m[1], 10), total: parseInt(m[2], 10) } : { cur: 1, total: 1 };
}

/**
 * 한 모드(예약 01 / 대기 02)의 전 페이지를 순회하며 방을 누적한다. (설계서 §6-bis)
 *
 * ※ goodsId 로 dedup 하는 게 핵심이다. fn_goPage 가 조용히 실패하거나 AJAX 가 늦으면
 *   같은 1페이지를 다시 파싱하게 되는데, dedup 없이 concat 하면 중복 방이 room_state 에
 *   쌓여 대기 방 수가 부풀고 전이 판정까지 오염된다. 변화가 없으면 순회를 중단하고
 *   complete=false 로 보고한다(조용한 절단 금지).
 */
async function collectModePages(page) {
  const rooms = new Map(); // goodsId → room
  const noId = [];         // goodsId 를 못 읽은 방(드묾) — dedup 불가라 그대로 보존
  let pages = 0;
  let complete = true;

  const absorb = (list) => {
    let fresh = 0;
    for (const r of list) {
      if (!r.goodsId) { noId.push(r); fresh++; continue; }
      if (!rooms.has(r.goodsId)) { rooms.set(r.goodsId, r); fresh++; }
    }
    return fresh;
  };

  // 목록이 렌더될 때까지 대기(모드 전환 직후엔 아직 비어 있을 수 있다)
  await page.waitForSelector(".goods_list_area .list_box", { timeout: 15000 }).catch(() => {});

  const { cur, total: totalPages } = await page.evaluate(readPaging);
  pages = 1;
  absorb(await page.evaluate(extractRooms));

  // 현재 페이지를 뺀 나머지 전부를 방문한다 — 시작 페이지가 1이라는 보장이 없다.
  const todo = [];
  for (let i = 1; i <= totalPages; i++) if (i !== cur) todo.push(i);

  for (const p of todo) {
    const before = await page.evaluate(listSignature);

    // ※ `fn_goPage(n)` 을 evaluate 로 직접 부르지 않는다. 전역 함수이긴 하나 모드 전환 직후
    //   호출하면 위젯이 준비되기 전에 발사돼 조용히 무시된다(대기 모드에서 실측). 사이트가
    //   실제로 쓰는 경로 = 페이지 앵커의 inline onclick 이므로 **앵커를 클릭**한다.
    //   앵커의 존재 자체가 "위젯 준비 완료" 신호 역할도 한다.
    const clicked = await page
      .waitForFunction((n) => {
        const a = [...document.querySelectorAll(".page_list a")].find((x) => x.textContent.trim() === String(n));
        if (!a) return false;
        a.click();
        return true;
      }, p, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);

    if (!clicked) {
      console.warn(`페이지 ${p}/${totalPages} 앵커를 찾지 못했습니다 — 순회 중단(complete=false).`);
      complete = false;
      break;
    }

    // 페이징은 내부 AJAX(innerFcfsRsrvtPssblGoodsDetls.do)라 load 이벤트가 안 뜬다.
    // 목록 지문이 실제로 바뀔 때까지 기다린다.
    const changed = await page
      .waitForFunction((prev) => {
        const sig = [...document.querySelectorAll(".goods_list_area .list_box .item")]
          .map((el) => el.getAttribute("data-value") || "").join(",");
        return sig !== "" && sig !== prev;
      }, before, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);

    if (!changed) {
      console.warn(`페이지 ${p}/${totalPages} 전환 실패 — 순회를 중단합니다(complete=false).`);
      complete = false;
      break;
    }
    pages += 1;
    if (absorb(await page.evaluate(extractRooms)) === 0) {
      // 지문은 바뀌었는데 새 방이 없다 = 예상 밖 → 무한루프 방지
      complete = false;
      break;
    }
  }

  return { rooms: [...rooms.values(), ...noId], pages, complete, totalPages };
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

    // 예약가능(rsrvtWtngSctin=01) 모드 — 전 페이지 순회 + goodsId dedup
    let reserveRooms = [];
    let pagesTraversed = 0;
    let complete = true;
    try {
      const r = await collectModePages(page);
      reserveRooms = r.rooms;
      pagesTraversed += r.pages;
      complete = complete && r.complete;
    } catch (e) {
      console.warn("예약(01) 모드 순회 실패:", e.message);
      complete = false;
    }
    let rooms = reserveRooms;

    // 대기가능(02) 모드 추가 조회: 사이트의 fn_wtng_goSrch()로 "대기 가능한 방" 재조회
    if (includeWait) {
      try {
        await page.evaluate(() => { if (typeof fn_wtng_goSrch === "function") fn_wtng_goSrch(); });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2500);   // 대기 목록·페이징 위젯 렌더 여유(1.5초는 부족했다)
        if (saveArtifacts) await writeFile("artifacts/goods-wtng.html", await page.content(), "utf8");

        const w = await collectModePages(page);
        pagesTraversed += w.pages;
        complete = complete && w.complete;

        // 모드 간 합치기: 예약 모드에 이미 잡힌 방은 그 상태를 우선한다(예약가능 > 대기가능)
        const seen = new Set(reserveRooms.map((r) => r.goodsId).filter(Boolean));
        rooms = reserveRooms.concat(w.rooms.filter((r) => r.goodsId && !seen.has(r.goodsId)));
      } catch (e) {
        console.warn("대기(02) 모드 순회 실패:", e.message);
        complete = false;
      }
    }
    return { ok, url, needLogin: false, rooms, pagesTraversed, complete };
  } finally {
    await page.close();
    if (ownCtx) await ctx.close();
  }
}
