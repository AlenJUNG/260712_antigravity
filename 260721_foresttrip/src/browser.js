// Playwright 브라우저 싱글턴.
// 요청마다 Chromium 을 새로 띄우면 느리므로 한 번 띄워 재사용하고,
// 조회마다 격리된 컨텍스트(세션)만 새로 만든다.
//
// 기본은 headful(브라우저가 눈에 보임). HEADLESS=1 이면 창 없이 실행.

import { chromium } from "playwright";

let _browser = null;

export async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  _browser = await chromium.launch({
    headless: process.env.HEADLESS === "1",
    slowMo: process.env.HEADLESS === "1" ? 0 : 150,
  });
  return _browser;
}

export async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}
