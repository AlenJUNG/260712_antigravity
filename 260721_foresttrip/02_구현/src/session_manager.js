import { getBrowser } from "./browser.js";
import { db, decryptPassword } from "./db.js";
import { createLoggedInContext } from "./login.js";
import { pushToOwner } from "./push.js";
import { nowIso } from "./dates.js";
import { UA } from "./constants.js";

// 로그인은 절대 동시에 두 번 돌면 안 된다(비밀번호 5회 오류 = 계정 잠금).
// 스케줄러 폴링과 REST 온디맨드가 동시에 세션을 요구할 수 있으므로 뮤텍스로 직렬화한다.
let loginInFlight = null;

/**
 * 로그인된 Playwright 컨텍스트를 돌려준다.
 * 저장된 세션(storageState)이 유효하면 재사용하고, 아니면 저장 자격증명으로 자동 재로그인한다.
 */
export async function getSessionContext() {
  const session = db.prepare(`SELECT * FROM forest_session WHERE id = 1`).get();
  const browser = await getBrowser();

  if (session && session.valid && !session.needs_relogin && session.storage_state) {
    try {
      return await browser.newContext({
        userAgent: UA,
        locale: "ko-KR",
        viewport: { width: 1360, height: 1000 },
        storageState: JSON.parse(session.storage_state),
      });
    } catch (e) {
      console.error("저장된 세션 복원 실패, 재로그인 시도:", e.message);
    }
  }

  if (session && session.needs_relogin) {
    throw new Error("자동 재로그인이 차단된 상태입니다(직전 로그인 실패 — 계정 잠금 방지). 앱에서 재로그인하세요.");
  }

  // 동시 진입 직렬화: 이미 로그인 중이면 그 결과를 기다렸다가 세션을 다시 읽는다.
  if (loginInFlight) {
    await loginInFlight.catch(() => {});
    const refreshed = db.prepare(`SELECT * FROM forest_session WHERE id = 1`).get();
    if (refreshed && refreshed.valid && refreshed.storage_state) {
      return await browser.newContext({
        userAgent: UA, locale: "ko-KR", viewport: { width: 1360, height: 1000 },
        storageState: JSON.parse(refreshed.storage_state),
      });
    }
    throw new Error("자동 재로그인 실패(동시 요청). 앱에서 재로그인하세요.");
  }

  loginInFlight = doLogin();
  try {
    return await loginInFlight;
  } finally {
    loginInFlight = null;
  }
}

async function doLogin() {
  const cred = db.prepare(`SELECT * FROM forest_credential WHERE id = 1`).get();
  if (!cred) throw new Error("자격증명이 등록되지 않았습니다. 먼저 POST /v1/auth/forest-login 을 호출하세요.");

  const password = decryptPassword(cred.enc_password);
  if (!password) {
    // 키 교체·손상 → 재시도해봐야 계속 실패하므로 재로그인 요구로 전환
    markNeedsRelogin("저장된 자격증명을 복호화할 수 없습니다(ENCRYPTION_KEY 변경?).");
    throw new Error("자격증명 복호화 실패. 앱에서 재로그인하세요.");
  }

  console.log("숲나들e 자동 로그인 시도...");
  try {
    const ctx = await createLoggedInContext({ id: cred.login_id, pw: password });
    const storageState = await ctx.storageState();
    const now = nowIso();
    db.prepare(`
      INSERT INTO forest_session (id, storage_state, established_at, last_checked, valid, needs_relogin)
      VALUES (1, ?, ?, ?, 1, 0)
      ON CONFLICT(id) DO UPDATE SET
        storage_state = excluded.storage_state,
        established_at = excluded.established_at,
        last_checked = excluded.last_checked,
        valid = 1, needs_relogin = 0
    `).run(JSON.stringify(storageState), now, now);
    console.log("자동 로그인 성공, 세션 저장됨.");
    return ctx;
  } catch (err) {
    // ADR-0002: 5회 오류 시 계정 잠금 → 실패하면 **재시도하지 않고** 소유자에게 알린다.
    console.error("자동 로그인 실패:", err.message);
    markNeedsRelogin(err.message);
    throw new Error("자동 로그인 실패: " + err.message);
  }
}

/**
 * 재로그인 필요 상태로 전환 + 소유자 푸시.
 * storage_state 는 **지우지 않는다** — 일시적 실패로 멀쩡한 세션까지 파기하면
 * 복구 가능한 상황을 영구 장애로 만든다.
 */
function markNeedsRelogin(reason) {
  const now = nowIso();
  const exists = db.prepare(`SELECT needs_relogin FROM forest_session WHERE id = 1`).get();
  if (exists) {
    db.prepare(`UPDATE forest_session SET valid = 0, needs_relogin = 1, last_checked = ? WHERE id = 1`).run(now);
  } else {
    db.prepare(`
      INSERT INTO forest_session (id, storage_state, established_at, last_checked, valid, needs_relogin)
      VALUES (1, '', ?, ?, 0, 1)
    `).run(now, now);
  }
  if (!exists || !exists.needs_relogin) {
    pushToOwner({
      title: "[숲나들e] 재로그인이 필요합니다",
      body: `자동 로그인이 실패해 감시가 중단됐습니다. 앱에서 다시 로그인하세요. (${reason})`,
      payload: { kind: "needs_relogin" },
    }).catch(() => {});
  }
}

/**
 * 세션이 죽었다고 표시한다(예: goods 조회가 로그인 화면을 반환).
 * needs_relogin 은 켜지 않으므로 다음 요청에서 저장 자격증명으로 1회 재로그인을 시도한다.
 */
export function invalidateSession(reason = "") {
  db.prepare(`UPDATE forest_session SET valid = 0, last_checked = ? WHERE id = 1`).run(nowIso());
  console.warn(`세션 무효화: ${reason}`);
}

/** 현재 컨텍스트가 여전히 로그인 상태인지 확인한다. */
export async function validateSession(ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.foresttrip.go.kr/com/index.do", { waitUntil: "networkidle" });
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const loggedIn = text.includes("로그아웃");
    if (!loggedIn) {
      db.prepare(`UPDATE forest_session SET valid = 0 WHERE id = 1`).run();
      return false;
    }
    db.prepare(`UPDATE forest_session SET last_checked = ? WHERE id = 1`).run(nowIso());
    return true;
  } catch {
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}
