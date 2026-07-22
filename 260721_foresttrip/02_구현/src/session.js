// 세션 열기: 예약 메인 페이지를 받아 세션쿠키 + _csrf 토큰을 확보한다.
// 이 쿠키/토큰은 NetFunnel 게이트가 없는 JSON 엔드포인트 호출에 쓴다.

import { BASE, ENDPOINTS, UA } from "./constants.js";

/** @returns {Promise<{cookie: string, csrf: string}>} */
export async function openSession() {
  const res = await fetch(BASE + ENDPOINTS.main, {
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9" },
  });
  if (!res.ok) throw new Error(`메인 페이지 로드 실패: HTTP ${res.status}`);

  const cookie = extractCookies(res);
  const html = await res.text();
  const csrf = html.match(/_csrf=([0-9a-f-]{36})/)?.[1];
  if (!csrf) throw new Error("_csrf 토큰을 페이지에서 찾지 못했습니다.");

  return { cookie, csrf };
}

/** Set-Cookie 헤더에서 "name=value" 쌍만 뽑아 Cookie 헤더 문자열로 만든다. */
function extractCookies(res) {
  const list =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  return list.map((c) => c.split(";")[0]).join("; ");
}

/** JSON ajax 엔드포인트 공통 호출기 (X-Ajax-call 헤더 필수) */
export async function ajaxGet(session, path, params = {}) {
  const qs = new URLSearchParams({ _csrf: session.csrf, ...params }).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: {
      "User-Agent": UA,
      Cookie: session.cookie,
      "X-Ajax-call": "true",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
    },
  });
  if (!res.ok) throw new Error(`${path} 실패: HTTP ${res.status}`);
  return res.json();
}
