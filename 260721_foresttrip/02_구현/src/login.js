// 숲나들e 로그인 → 로그인된 Playwright 컨텍스트 반환.
// 자격증명은 .env 의 ID / PW (또는 FOREST_ID/FOREST_PW) 로만 받는다.
// 코드는 값을 저장/로깅하지 않는다.
//
//   node src/poc.js rooms ...   (.env 자동 로드)
//
// 주의: 비밀번호 5회 오류 시 계정이 잠긴다. 실패하면 재시도하지 말고 자격증명을 확인할 것.

import { mkdir, writeFile } from "node:fs/promises";
import { BASE, UA } from "./constants.js";
import { getBrowser } from "./browser.js";

const LOGIN_PAGE = "/com/login.do?targetUrl=%2Fcom%2Findex.do";

// 로그인 실패/이상 시 진단용으로 현재 화면을 남긴다(개인정보 주의 — 로컬에만 저장).
async function saveLoginDebug(page) {
  try {
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/login.html", await page.content(), "utf8");
    await page.screenshot({ path: "artifacts/login.png", fullPage: true });
  } catch { /* 무시 */ }
}

/** @returns {Promise<import('playwright').BrowserContext>} 로그인된 컨텍스트 */
export async function createLoggedInContext({
  id = process.env.ID ?? process.env.FOREST_ID,
  pw = process.env.PW ?? process.env.FOREST_PW,
} = {}) {
  if (!id || !pw) throw new Error(".env 의 ID / PW (또는 FOREST_ID / FOREST_PW) 가 필요합니다.");

  const browser = await getBrowser();
  const ctx = await browser.newContext({ userAgent: UA, locale: "ko-KR", viewport: { width: 1360, height: 1000 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + LOGIN_PAGE, { waitUntil: "networkidle" });
    await page.fill("#mmberId", id);
    await page.fill("#gnrlMmberPssrd", pw);

    const nav = page.waitForNavigation({ timeout: 20000 }).catch(() => {});
    await page.evaluate(() => {
      if (typeof fn_goLogin === "function") fn_goLogin();
      else document.fripPotForm?.submit();
    });
    await nav;
    await page.waitForLoadState("networkidle").catch(() => {});

    // 성공 판정: 로그인 비밀번호 입력칸이 사라졌는지 + 실패 문구 부재
    const url = page.url();
    const stillHasPwField = await page.$("#gnrlMmberPssrd");
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const failed =
      /\/com\/login/.test(url) ||
      stillHasPwField ||
      /일치하지|존재하지\s*않|비밀번호.*오류|아이디.*확인|로그인에?\s*실패|잠금|정상적인 접근/.test(text);
    if (failed) {
      await saveLoginDebug(page);
      throw new Error(`로그인 실패 (도착 URL: ${url}) — .env 의 ID/PW 확인. 5회 오류 시 계정 잠금 주의. artifacts/login.png 참고`);
    }

    await page.close();
    return ctx;
  } catch (e) {
    await saveLoginDebug(page);
    await ctx.close();
    throw e;
  }
}
