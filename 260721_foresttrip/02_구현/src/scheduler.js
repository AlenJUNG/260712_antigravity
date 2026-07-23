// 폴링 스케줄러 — poll_target 큐 + 적응형 주기 + 전역 레이트버짓 (ADR-0006)
//
// 설계상 주의점 3가지가 여기 모여 있다.
//  1) 폴 1건은 20~40초(2모드 × N페이지 × NetFunnel)라 틱 간격보다 훨씬 길다.
//     재진입 가드 없이 setInterval 로 돌리면 **같은 target 을 동시에 여러 번** 긁어
//     단일 계정이 소프트밴당한다. → inFlight 플래그 + 선점 즉시 next_due_at 갱신.
//  2) 실패는 침묵시키지 않는다. scan(ok=0) 을 남기고 백오프하되 target 을 죽이지 않는다.
//  3) 모든 스크래핑은 rateBudget 을 통과한다(온디맨드 포함).

import { db } from "./db.js";
import { searchForestGoods } from "./goods.js";
import { getSessionContext, invalidateSession } from "./session_manager.js";
import { searchRegionAvailability } from "./availability.js";
import { SIDO } from "./constants.js";
import { todayYmd, addDays, daysUntil, nowIso, nowHourKst } from "./dates.js";
import { tryConsume, settle, GOODS_POLL_COST, MIN_POLL_INTERVAL_SEC, maxTargets, budgetState } from "./rateBudget.js";
import { ingestScan, recordScan, consecutiveFailures } from "./transitions.js";
import { pushToOwner } from "./push.js";

const MAX_BACKOFF_SEC = 30 * 60;
const HEALTH_FAIL_THRESHOLD = 5;   // 연속 실패 임계 (M5)

let inFlight = false;              // 폴 재진입 가드
let healthAlerted = false;         // 건전성 알림 중복 방지
let coverageAlerted = false;       // 커버리지 상한 알림 중복 방지

// ── 가용성 갱신 잡 큐 (백그라운드) ─────────────────────────────────────────
// /v1/search 는 스냅샷만 즉시 반환하고(ADR-0003), 부족하면 여기에 잡을 넣는다.
// 요청 스레드에서 라이브 스크래핑을 돌리면 UX·레이트버짓 양쪽이 무너진다.
const availJobs = new Map();       // jobId → { id, sido, date, nights, nofpr, status, queuedAt, finishedAt, error }
const availQueue = [];
let jobSeq = 0;

/**
 * (시도, 날짜, 인원) 가용성 갱신을 예약한다. sido 생략 시 전국(9개 시도) 전부.
 * @returns {string} jobId
 */
export function enqueueAvailabilityRefresh({ sido, date, nights = 1, nofpr = 2 }) {
  const sidos = sido ? [String(sido)] : Object.keys(SIDO);
  const id = `job_${Date.now().toString(36)}_${++jobSeq}`;
  const job = { id, sidos, date, nights, nofpr, status: "queued", queuedAt: nowIso(), pending: [...sidos] };
  availJobs.set(id, job);
  for (const s of sidos) availQueue.push({ jobId: id, sido: s, date, nights, nofpr });
  return id;
}

export function getAvailabilityJob(jobId) {
  return availJobs.get(jobId) || null;
}

/**
 * 큐에 이미 같은 (시도,날짜,인원) 잡이 있는지 — 중복 큐잉 방지.
 * sido 를 생략하면 해당 (날짜,인원)에 대해 대기 중인 잡이 하나라도 있으면 true.
 */
export function isRefreshQueued({ sido, date, nofpr }) {
  return availQueue.some((q) =>
    q.date === date && q.nofpr === Number(nofpr) && (!sido || q.sido === String(sido))
  );
}

/** 이름 정규화: availability 결과는 "[공립]" 접두어가 제거된 형태로 온다. */
function normName(s) {
  return (s || "").replace(/^\[(국립|공립|사립)\]/, "").replace(/\s+/g, "");
}

let forestNameIndex = null;
function insttIdByName(name) {
  if (!forestNameIndex) {
    forestNameIndex = new Map();
    for (const r of db.prepare(`SELECT instt_id, name FROM forest`).all()) {
      forestNameIndex.set(normName(r.name), r.instt_id);
    }
  }
  return forestNameIndex.get(normName(name)) || null;
}
export function resetForestNameIndex() { forestNameIndex = null; }

/** 큐에서 잡 1건(=시도 1개) 처리. 예산을 못 얻으면 아무것도 하지 않는다. */
async function runAvailabilityJob() {
  if (availQueue.length === 0) return false;
  if (!tryConsume(1)) return false;

  const item = availQueue.shift();
  const job = availJobs.get(item.jobId);
  if (job) job.status = "running";

  const checkout = addDays(item.date, item.nights);
  try {
    const r = await searchRegionAvailability({
      sido: item.sido, checkin: item.date, checkout, nofpr: item.nofpr,
    });
    const at = nowIso();
    const insertAvail = db.prepare(`
      INSERT INTO forest_availability (instt_id, date, nofpr, status, reservable, room_count, scanned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let matched = 0, unmatched = 0;
    for (const f of r.forests || []) {
      const insttId = insttIdByName(f.name);
      if (!insttId) { unmatched++; continue; }
      matched++;
      insertAvail.run(insttId, item.date, item.nofpr, f.status ?? null, f.available ? 1 : 0, f.rooms ?? null, at);
    }
    if (unmatched > 0) console.warn(`가용성 갱신: 이름 매칭 실패 ${unmatched}건 (시도 ${item.sido})`);
    console.log(`가용성 갱신 완료 — 시도 ${item.sido} ${item.date} ${item.nofpr}인: ${matched}곳`);
  } catch (err) {
    console.error(`가용성 갱신 실패(시도 ${item.sido}):`, err.message);
    if (job) job.error = err.message;
  } finally {
    if (job) {
      job.pending = job.pending.filter((s) => s !== item.sido);
      if (job.pending.length === 0) {
        job.status = job.error ? "failed" : "done";
        job.finishedAt = nowIso();
      }
    }
  }
  return true;
}

// ── 감시 → poll_target 파생/정리 (M3) ──────────────────────────────────────

/**
 * 활성 감시에서 poll_target 을 재파생하고 고아를 정리한다.
 * 날짜 비교는 반드시 todayYmd()(KST YYYYMMDD)로 한다 — 예전엔 ISO 문자열을
 * slice(0,8) 해서 "2026-07-" 로 비교하는 바람에 같은 해 과거 날짜가 전부
 * 필터를 통과하고 reaper 도 동작하지 않았다.
 */
export function reconcilePollTargets() {
  const today = todayYmd();
  const now = nowIso();

  // 1) 날짜가 지난 감시 종료
  db.prepare(`UPDATE watch SET active = 0 WHERE active = 1 AND date IS NOT NULL AND date < ?`).run(today);

  // 2) 대기 전용 감시는 D-2(대기신청 마감) 경과 시 자동 종료. 예약 감시는 D-day까지 유지.
  const withDeadline = db.prepare(`
    SELECT id, notify_grades, wait_deadline FROM watch
    WHERE active = 1 AND wait_deadline IS NOT NULL AND wait_deadline < ?
  `).all(today);
  const deactivate = db.prepare(`UPDATE watch SET active = 0 WHERE id = ?`);
  for (const w of withDeadline) {
    let grades;
    try { grades = JSON.parse(w.notify_grades); } catch { grades = []; }
    if (!grades.includes("예약가능")) deactivate.run(w.id);   // 대기 전용
  }

  // 3) 남은 활성 감시에서 target 파생·병합.
  //
  //    **min-nofpr 병합 (ADR-0006 §4, 2026-07-23 실측으로 확정):**
  //    사이트 가용성은 인원에 대해 단조 감소한다 — 낮은 인원의 결과가 높은 인원 결과의
  //    상위집합이다(강원 9/9/7/5, 수도권 16/16/9로 확인, 새로 등장하는 항목 0건).
  //    따라서 (휴양림,날짜,박수)를 **최소 인원으로 1회만** 폴링하고, 인원별 차이는
  //    방의 `capacity`로 다운스트림 필터한다(transitions.roomFitsParty).
  //    인원 변형마다 target을 쪼개면 예산이 그만큼 파편화된다.
  const groups = db.prepare(`
    SELECT instt_id, date, nights,
           MIN(nofpr) AS nofpr,
           MAX(nofpr) AS max_nofpr,
           MAX(CASE WHEN priority = 'urgent' THEN 1 ELSE 0 END) AS has_urgent
    FROM watch
    WHERE active = 1 AND paused = 0 AND date IS NOT NULL AND date >= ?
    GROUP BY instt_id, date, nights
  `).all(today);

  // 재파생 방식의 GC: 일단 전부 내리고, 파생된 것만 다시 올린다.
  // (upsert 는 next_due_at 을 건드리지 않으므로 살아남는 target 의 스케줄은 보존된다.)
  // 중간에 실패하면 모든 target 이 꺼진 채 다음 reconcile 까지 폴링이 멈추므로 트랜잭션으로 묶는다.
  const upsert = db.prepare(`
    INSERT INTO poll_target (instt_id, date, nofpr, nights, next_due_at, interval_sec, priority, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(instt_id, date, nofpr, nights) DO UPDATE SET
      priority = excluded.priority,
      active = 1
  `);
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE poll_target SET active = 0 WHERE active = 1`).run();
    for (const g of groups) {
      const priority = g.has_urgent ? "urgent" : "normal";
      upsert.run(g.instt_id, g.date, g.nofpr, g.nights, now, MIN_POLL_INTERVAL_SEC, priority);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // 4) 날짜 경과 target 비활성(위에서 재파생되지 않았다면 이미 0이지만 방어적으로)
  db.prepare(`UPDATE poll_target SET active = 0 WHERE active = 1 AND date < ?`).run(today);

  checkCoverage();
}

/** 커버리지 상한(N_max) 근접 여부를 표면화한다 (ADR-0006 §2). */
export function coverageState() {
  const active = db.prepare(`SELECT count(*) AS n FROM poll_target WHERE active = 1`).get().n;
  const nMax = maxTargets();
  return {
    activeTargets: active,
    nMax,
    degraded: active > nMax,
    nearLimit: active > nMax * 0.8,
    budget: budgetState(),
  };
}

function checkCoverage() {
  const c = coverageState();
  if (c.degraded && !coverageAlerted) {
    coverageAlerted = true;
    console.warn(`커버리지 저하: 활성 target ${c.activeTargets} > N_max ${c.nMax}. 일부 감시가 제때 폴링되지 않습니다.`);
    pushToOwner({
      title: "[숲나들e] 감시 커버리지 저하",
      body: `활성 감시 대상 ${c.activeTargets}개가 레이트버짓 상한(${c.nMax}개)을 넘었습니다. 일부 감시의 폴링이 지연됩니다.`,
      payload: { kind: "coverage_degraded", ...c },
    }).catch(() => {});
  } else if (!c.degraded) {
    coverageAlerted = false;
  }
}

// ── 적응형 주기 (M4: 외생 prior 우선) ──────────────────────────────────────

/**
 * 취소多 신호(watch_event)는 폴링의 산물이라 자기참조 위험이 있어 Phase 1에선 쓰지 않는다.
 * D-day 근접 · 피크시간대 같은 외생 prior만 사용한다.
 */
export function calculateAdaptiveInterval(target) {
  let interval = 600;                                   // 기본 10분
  if (target.priority === "urgent") interval = 300;     // 긴급 5분

  const d = daysUntil(target.date);
  if (d >= 0 && d <= 2) interval = Math.min(interval, 180);   // 임박 3분

  const hour = nowHourKst();
  if (hour >= 9 && hour < 18) interval = Math.min(interval, 300);   // 취소 다발 시간대

  // 레이트버짓 바닥선 아래로는 내려가지 않는다(N_max 산출 기준과 동일한 값).
  return Math.max(interval, MIN_POLL_INTERVAL_SEC);
}

/** 이 target 의 최근 연속 실패 수 → 백오프 배수 */
function targetFailures(target) {
  const rows = db.prepare(`
    SELECT ok FROM scan
    WHERE instt_id = ? AND date = ? AND nofpr = ?
    ORDER BY id DESC LIMIT 5
  `).all(target.instt_id, target.date, target.nofpr);
  let n = 0;
  for (const r of rows) { if (r.ok) break; n++; }
  return n;
}

function rescheduleTarget(target, { failed }) {
  const base = calculateAdaptiveInterval(target);
  const fails = failed ? targetFailures(target) : 0;
  const interval = failed
    ? Math.min(base * Math.pow(2, Math.max(0, fails)), MAX_BACKOFF_SEC)
    : base;
  db.prepare(`
    UPDATE poll_target SET last_polled_at = ?, next_due_at = ?, interval_sec = ?
    WHERE id = ?
  `).run(nowIso(), new Date(Date.now() + interval * 1000).toISOString(), interval, target.id);
  return interval;
}

// ── 폴 실행 ────────────────────────────────────────────────────────────────

export async function pollNextTarget() {
  if (inFlight) return false;               // 재진입 금지: 폴 1건이 틱 간격보다 훨씬 길다

  // 예산은 실제로 돌릴 target 이 있을 때만 소비한다(빈 큐에서 예산을 태우지 않도록).
  const target = db.prepare(`
    SELECT * FROM poll_target
    WHERE active = 1 AND next_due_at <= ?
    ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, next_due_at ASC
    LIMIT 1
  `).get(nowIso());
  if (!target) return false;
  if (!tryConsume(GOODS_POLL_COST)) return false;

  inFlight = true;
  // 선점 즉시 다음 예정 시각을 밀어 다른 경로가 같은 target 을 다시 집지 않게 한다.
  db.prepare(`UPDATE poll_target SET next_due_at = ? WHERE id = ?`)
    .run(new Date(Date.now() + target.interval_sec * 1000).toISOString(), target.id);

  const forest = db.prepare(`SELECT sido_code, name FROM forest WHERE instt_id = ?`).get(target.instt_id);
  let sessionCtx = null;
  let failed = true;

  try {
    if (!forest) throw new Error(`forest 테이블에 ${target.instt_id} 없음 — 카탈로그를 먼저 채우세요.`);
    sessionCtx = await getSessionContext();
    const checkout = addDays(target.date, target.nights);

    console.log(`폴링: ${forest.name} (${target.instt_id}) ${target.date} ${target.nofpr}인`);
    const result = await searchForestGoods({
      sido: forest.sido_code,
      insttId: target.instt_id,
      checkin: target.date,
      checkout,
      nofpr: target.nofpr,
      context: sessionCtx,
      includeWait: true,
    });

    // 실제 요청 수 = 페이지 순회 수 + 진입/검색/대기전환 오버헤드
    settle(GOODS_POLL_COST, (result.pagesTraversed || 2) + 1);

    if (result.needLogin) {
      // 세션이 죽었다 → 다음 요청에서 저장 자격증명으로 1회 재로그인 시도
      invalidateSession("goods 조회가 로그인 화면을 반환");
      throw new Error("세션 만료(로그인 필요)");
    }
    if (!result.ok) throw new Error(`goods 페이지 도달 실패 (${result.url})`);

    const { sent } = await ingestScan({
      insttId: target.instt_id,
      date: target.date,
      nofpr: target.nofpr,
      nights: target.nights,
      source: "watch",
      rooms: result.rooms,
    });
    failed = false;
    healthAlerted = false;
    if (sent > 0) console.log(`알림 ${sent}건 발송`);
    if (!result.complete) console.warn("페이지 순회가 불완전합니다(일부 방 누락 가능).");
  } catch (err) {
    console.error(`폴링 실패 (target ${target.id}):`, err.message);
    // 실패도 반드시 기록한다 — scan.ok 는 소프트밴/세션사망 탐지의 유일한 신호원(M5)
    recordScan({
      insttId: target.instt_id, date: target.date, nofpr: target.nofpr,
      nights: target.nights, source: "watch", ok: 0,
    });
  } finally {
    if (sessionCtx) await sessionCtx.close().catch(() => {});
    inFlight = false;
  }

  // 실패해도 target 을 죽이지 않는다(예전엔 active=0 으로 감시가 조용히 사라졌다).
  // 대신 지수 백오프로 간격만 늘린다.
  const interval = rescheduleTarget(target, { failed });
  if (failed) console.warn(`백오프: ${interval}초 후 재시도 (target ${target.id})`);

  checkHealth();
  return true;
}

/** 살아 있는데 전 스캔이 실패하는 상황(소프트밴/세션사망)을 소유자에게 알린다 (M5). */
function checkHealth() {
  const fails = consecutiveFailures(HEALTH_FAIL_THRESHOLD * 2);
  if (fails >= HEALTH_FAIL_THRESHOLD && !healthAlerted) {
    healthAlerted = true;
    pushToOwner({
      title: "[숲나들e] 스캔이 연속 실패 중입니다",
      body: `최근 ${fails}회 연속으로 조회에 실패했습니다. 세션 만료나 사이트 차단일 수 있습니다.`,
      payload: { kind: "scan_unhealthy", consecutiveFailures: fails },
    }).catch(() => {});
  }
}

/**
 * 스케줄러 1틱. 가용성 갱신 잡을 우선 처리하고(값싸고 사용자가 대기 중),
 * 없으면 감시 폴링을 1건 수행한다.
 */
export async function schedulerTick() {
  if (await runAvailabilityJob()) return;
  await pollNextTarget();
}
