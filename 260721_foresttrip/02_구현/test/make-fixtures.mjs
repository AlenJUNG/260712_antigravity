// 파서 회귀 테스트용 fixture 생성기 (재실행용, 수동).
//
//   node test/make-fixtures.mjs
//
// artifacts/ 의 저장 DOM에서 **파서가 읽는 리스트 영역만** 잘라 test/fixtures/ 에 넣는다.
// 헤더/네비를 통째로 커밋하면 로그인 페이지의 개인정보가 샐 수 있으므로, .rc_item /
// .goods_list_area 서브트리만 추출하고 PII 마커(로그아웃/마이페이지 등)가 없는지 가드한다.
//
// artifacts/ 는 .gitignore 대상이라 커밋되지 않는다. fixtures/ 는 커밋되는 테스트 자산이다.
// 사이트 개편으로 파서를 고칠 때 새 DOM을 artifacts/ 에 저장한 뒤 이 스크립트를 다시 돌린다.

import { chromium } from "playwright";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, "..", "..", "artifacts");
const OUT = join(HERE, "fixtures");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const wrap = (title, frag) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head><body>\n${frag}\n</body></html>\n`;

// 헤더/네비의 개인정보가 새지 않았는지 확인하는 안전 가드
const PII_MARKERS = ["로그아웃", "마이페이지", "회원탈퇴", "myCont_btn"];
function assertClean(name, html) {
  const hit = PII_MARKERS.filter((m) => html.includes(m));
  if (hit.length) throw new Error(`${name}: 개인정보 마커 발견 ${JSON.stringify(hit)} — fragment 추출 실패`);
}

const b = await chromium.launch({ headless: true });
const page = await b.newPage();
// 저장 DOM은 원격 이미지/스크립트를 참조한다. 파싱에는 불필요하고 네트워크로 멈추므로 차단한다.
await page.route("**/*", (route) => {
  const t = route.request().resourceType();
  route[t === "document" ? "continue" : "abort"]();
});

async function load(file) {
  const src = join(ART, file);
  if (!existsSync(src)) throw new Error(`저장 DOM 없음: ${src} (먼저 라이브 실행으로 artifacts 를 만드세요)`);
  await page.goto(pathToFileURL(src).href, { waitUntil: "domcontentloaded" });
}

// 모든 .rc_item 을 이어붙인다(가용성 목록).
async function allRcItems(file) {
  await load(file);
  const html = await page.evaluate(() =>
    [...document.querySelectorAll(".rc_item")].map((n) => n.outerHTML).join("\n") || null);
  if (!html) throw new Error(`${file} 에서 .rc_item 을 찾지 못함`);
  return html;
}

// 실제 방(.list_box 안에 .opt1 이 있는)을 가장 많이 가진 .goods_list_area 하나를 고른다.
// 저장 DOM에는 빈/모바일용 .goods_list_area 가 섞여 있어 첫 요소가 비어 있을 수 있다.
async function richestGoodsArea(file) {
  await load(file);
  const html = await page.evaluate(() => {
    const areas = [...document.querySelectorAll(".goods_list_area")];
    let best = null, bestN = 0;
    for (const a of areas) {
      const n = a.querySelectorAll(".list_box .opt1").length;
      if (n > bestN) { bestN = n; best = a; }
    }
    return best && bestN > 0 ? best.outerHTML : null;
  });
  if (!html) throw new Error(`${file} 에서 방이 담긴 .goods_list_area 를 찾지 못함`);
  return html;
}

const specs = [
  { out: "availability.html", title: "fixture: availability .rc_item",
    build: async () => `<div class="rc_list">\n${await allRcItems("result.html")}\n</div>` },
  { out: "goods.html", title: "fixture: goods rooms",
    build: async () => richestGoodsArea("goods-wtng.html") },
];

for (const s of specs) {
  const html = wrap(s.title, await s.build());
  assertClean(s.out, html);
  writeFileSync(join(OUT, s.out), html, "utf8");
  console.log(`  ${s.out.padEnd(22)} ${(html.length / 1024).toFixed(1)}KB, PII 없음`);
}
console.log("fixtures 생성 완료.");
await b.close();
