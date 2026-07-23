// 파서 회귀 테스트 (오프라인) — 사이트 개편으로 파서가 깨지는 것을 조기에 잡는다.
//
//   node --test test/parser.test.mjs      (또는 npm test)
//
// test/fixtures/ 의 저장 DOM(파서가 읽는 리스트 영역만 잘라둔 것)에 실제 파서를 돌려
// 결과를 검증한다. 네트워크·로그인 불필요, 결정적. 셀렉터가 바뀌면 카운트가 0으로 떨어져
// 즉시 실패하며, 어느 파서가 깨졌는지 이름으로 짚어준다.
//
// fixture 는 실측 시점의 스냅샷이라 값이 고정이다. 사이트 구조가 바뀌어 파서를 고치면
// `node test/make-fixtures.mjs` 로 fixture 를 재생성한 뒤 아래 스냅샷 수치를 갱신한다.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractForests } from "../src/availability.js";
import { extractRooms } from "../src/goods.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => pathToFileURL(join(HERE, "fixtures", name)).href;

let browser, page;
before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  // 저장 DOM이 참조하는 원격 이미지/스크립트는 파싱에 불필요하고 멈추므로 차단
  await page.route("**/*", (r) => (r.request().resourceType() === "document" ? r.continue() : r.abort()));
});
after(async () => { await browser?.close(); });

async function parse(fixtureName, fn) {
  await page.goto(fixture(fixtureName), { waitUntil: "domcontentloaded" });
  return page.evaluate(fn);
}

const STATUS = new Set(["예약가능", "대기가능", null]);
const TYPE = new Set(["국립", "공립", "사립", null]);

// ── 가용성 파서 (.rc_item) ─────────────────────────────────────────────────
test("availability: .rc_item 셀렉터가 휴양림을 파싱한다", async () => {
  const forests = await parse("availability.html", extractForests);

  assert.ok(forests.length > 0, ".rc_item 을 하나도 못 찾음 — 셀렉터 개편 의심");
  assert.equal(forests.length, 31, "휴양림 수 스냅샷 불일치");

  for (const f of forests) {
    assert.ok(f.name && f.name.length > 0, `name 비어있음: ${JSON.stringify(f)}`);
    assert.doesNotMatch(f.name, /^\[(국립|공립|사립)\]/, "type 접두어가 name 에서 제거되지 않음");
    assert.ok(TYPE.has(f.type), `type enum 위반: ${f.type}`);
    assert.equal(f.available, f.status === "예약가능", "available 파생이 status 와 불일치");
    // rooms = "[객실] N개" (0 = 만실도 유효). null 은 stay_info 부재.
    assert.ok(f.rooms === null || (Number.isInteger(f.rooms) && f.rooms >= 0), `rooms 형식 위반: ${f.rooms}`);
  }

  // 상태 분포 스냅샷 (예약가능/예약불가 둘 다 존재해야 파서가 두 경우를 구분함을 보장)
  const avail = forests.filter((f) => f.available).length;
  assert.equal(avail, 24, "예약가능 수 스냅샷 불일치");
  assert.equal(forests.filter((f) => f.status === "예약불가").length, 7, "예약불가 수 스냅샷 불일치");

  // 첫 항목 정확 일치 (파싱 세부까지 고정)
  assert.deepEqual(forests[0], {
    name: "(홍천군)가리산자연휴양림", type: "공립",
    status: "예약가능", available: true, rooms: 39,
  });

  // type 3종이 모두 파싱되는지 (접두어 파싱 회귀 방지)
  const types = new Set(forests.map((f) => f.type));
  for (const t of ["국립", "공립", "사립"]) assert.ok(types.has(t), `type '${t}' 이 하나도 안 나옴`);
});

// ── 객실 파서 (.goods_list_area .list_box) ─────────────────────────────────
test("goods: .list_box 셀렉터가 객실을 파싱한다", async () => {
  const rooms = await parse("goods.html", extractRooms);

  assert.ok(rooms.length > 0, ".list_box 를 하나도 못 찾음 — 셀렉터 개편 의심");
  assert.equal(rooms.length, 10, "객실 수 스냅샷 불일치");

  for (const r of rooms) {
    assert.match(r.goodsId, /^G\d+$/, `goodsId 형식 위반(.item[data-value]): ${r.goodsId}`);
    assert.ok(r.facility, `facility 비어있음(.opt1 [분류] 파싱): ${JSON.stringify(r)}`);
    assert.ok(r.detail && r.detail.length > 0, "detail 비어있음");
    assert.match(r.capacity, /\d+\/\d+인/, `capacity 형식 위반(.opt2): ${r.capacity}`);
    assert.ok(r.price && /원/.test(r.price), `price 형식 위반(.opt3): ${r.price}`);
    assert.ok(STATUS.has(r.status), `status enum 위반: ${r.status}`);
    // 상태 파생(.btn_group .defBtn 의 txtRsrvt/txtWtng display)이 일관적인지
    assert.equal(r.available, r.status === "예약가능", "available 파생 불일치");
    assert.equal(r.waitable, r.status === "대기가능", "waitable 파생 불일치");
    if (r.status === "대기가능") assert.match(r.waitRank, /\d+순위/, `대기가능인데 순위 없음(.opt4): ${r.waitRank}`);
  }

  // 이 fixture 는 대기모드 스냅샷 → 10개 전부 대기가능 + 순위 존재
  assert.equal(rooms.filter((r) => r.status === "대기가능").length, 10, "대기가능 수 스냅샷 불일치");
  assert.equal(rooms.filter((r) => r.waitRank).length, 10, "waitRank 파싱 수 불일치");

  // 첫 객실 정확 일치
  assert.deepEqual(rooms[0], {
    facility: "야영데크",
    detail: "[야영데크]야영데크(101) 6/6인실(13㎡)",
    capacity: "6/6인실(13㎡)",
    price: "1박(주말)16,500원",
    status: "대기가능",
    waitRank: "2순위",
    available: false,
    waitable: true,
    goodsId: "G01110200200300139",
  });

  // goodsId 는 방마다 유일해야 한다(dedup 전제)
  const ids = rooms.map((r) => r.goodsId);
  assert.equal(new Set(ids).size, ids.length, "goodsId 중복 — dedup 전제 위반");
});
