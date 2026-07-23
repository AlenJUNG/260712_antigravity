// 스캔 결과 적재 · 상태전이 판정 · 감시 매칭 · 알림 발송.
//
// ※ 이 모듈은 스케줄러(폴링)와 REST(온디맨드) 양쪽에서 공유한다.
//   예전엔 같은 로직이 scheduler.js 와 server.js 에 복붙돼 있었고, 그 과정에서
//   scheduler 쪽만 `scan_id != ?` 조건이 빠져 **직전 상태 대신 방금 넣은 자기 행**을
//   읽는 바람에 전이가 영원히 검출되지 않았다(= 폴링 알림 0건). 사본을 만들지 말 것.

import { db } from "./db.js";
import { nowIso, todayYmd } from "./dates.js";
import { isMuted, sendPush } from "./push.js";
import { MIN_POLL_INTERVAL_SEC } from "./rateBudget.js";

/**
 * 계속 열려 있는 방을 재알림하는 최소 간격(분). 기획서 §4.2 "계속 열려있으면 X분당 1회".
 *
 * ⚠ 이 값은 **폴링 주기보다 확실히 커야** 한다. 스로틀이 폴 간격과 비슷하면(예전 10분,
 *   normal 폴 주기도 10분) 매 폴마다 "막 X분이 지났다"가 성립해 스로틀이 무력화된다
 *   — 소크 테스트에서 계속 열린 방이 폴마다 재알림돼 확인됨(22:25→22:35 = 617초 > 600초).
 *   그래서 기본값을 넉넉히 30분으로 두고, 폴 주기가 그보다 길면 그 주기에 맞춘다.
 */
const REMIND_MIN = Number(
  process.env.NOTIFY_THROTTLE_MIN || Math.max(30, Math.ceil((MIN_POLL_INTERVAL_SEC / 60) * 2))
);

/** 알림 대상이 되는 상태값 (API계약 §6) */
const NOTIFIABLE = new Set(["예약가능", "대기가능"]);

/** scan 1행 기록. 실패 스캔(ok=0)도 반드시 남긴다 — 건전성 모니터(M5)의 유일한 신호원. */
export function recordScan({ insttId, date, nofpr, nights, source, ok, scannedAt = nowIso() }) {
  const info = db.prepare(`
    INSERT INTO scan (instt_id, date, nofpr, nights, scanned_at, source, ok)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(insttId, date, nofpr, nights, scannedAt, source, ok ? 1 : 0);
  return info.lastInsertRowid;
}

/** 스캔 시점의 방 단위 상태 적재 */
export function saveRoomStates(scanId, insttId, date, rooms, scannedAt = nowIso()) {
  const stmt = db.prepare(`
    INSERT INTO room_state (scan_id, instt_id, date, goods_id, room_label, facility,
                            capacity, price, status, reservable, waitable, wait_rank, scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const room of rooms) {
    stmt.run(
      scanId, insttId, date, room.goodsId, room.detail, room.facility,
      room.capacity, room.price, room.status,
      room.available ? 1 : 0, room.waitable ? 1 : 0, room.waitRank, scannedAt
    );
  }
}

/** "2순위" → 2 */
function parseRank(rank) {
  const m = /(\d+)/.exec(rank || "");
  return m ? Number(m[1]) : null;
}

/**
 * "4/6인실(50㎡)" → 6 (최대 수용인원). 파싱 불가면 null.
 *
 * 실측(artifacts/rooms-region.json, 방 1376개): `기준/최대인` 형식이 **100%**이고
 * 기준 > 최대인 사례는 **0건**이라 둘째 숫자를 최대인원으로 봐도 안전하다.
 * "인실"이 아닌 "인"만 붙는 야영데크류(9건)까지 덮도록 `인실`이 아니라 `인`으로 끊는다.
 */
export function parseMaxCapacity(capacity) {
  const m = /(\d+)\s*\/\s*(\d+)\s*인/.exec(capacity || "");
  return m ? Number(m[2]) : null;
}

/**
 * 이 방이 요청 인원을 수용하는가. (min-nofpr 병합의 다운스트림 필터 — ADR-0006 §4)
 *
 * poll_target 을 최소 인원으로 병합해 폴링하므로, 결과에는 더 큰 인원 감시가 쓸 수 없는
 * 작은 방이 섞여 온다. 여기서 걸러낸다.
 * **파싱 실패 시 통과시킨다(fail-open)** — 잘못 걸러 취소표를 놓치는 것보다,
 * 과알림 후 사용자가 사이트에서 확인하는 편이 제품 가치상 훨씬 낫다.
 */
export function roomFitsParty(room, nofpr) {
  const max = parseMaxCapacity(room.capacity);
  if (max === null) return true;
  return max >= nofpr;
}

/**
 * 직전 스캔 대비 상태 전이를 watch_event 로 적재한다.
 * 반드시 saveRoomStates() 이후에 호출하되, scanId 를 넘겨 자기 자신을 제외해야 한다.
 */
export function processRoomTransitions({ insttId, date, rooms, scanId, occurredAt = nowIso() }) {
  const prevStmt = db.prepare(`
    SELECT status, wait_rank FROM room_state
    WHERE instt_id = ? AND date = ? AND goods_id = ? AND scan_id != ?
    ORDER BY scanned_at DESC, id DESC LIMIT 1
  `);
  const insertEvent = db.prepare(`
    INSERT INTO watch_event (instt_id, date, goods_id, event_type, from_state, to_state, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const events = [];
  for (const room of rooms) {
    const prev = prevStmt.get(insttId, date, room.goodsId, scanId);
    const fromStatus = prev ? prev.status : undefined;   // undefined = 최초 관측(전이 아님)
    const fromRank = prev ? prev.wait_rank : null;
    const toStatus = room.status ?? null;
    const toRank = room.waitRank ?? null;

    if (fromStatus === undefined) continue;              // 처음 본 방은 전이로 치지 않는다
    if (fromStatus === toStatus && fromRank === toRank) continue;

    let eventType = null;
    if (toStatus !== null && fromStatus !== toStatus) eventType = "opened";
    else if (toStatus === null && fromStatus !== null) eventType = "closed";
    else if (toStatus === "대기가능" && fromStatus === "대기가능" && toRank !== fromRank) eventType = "rank_changed";

    if (!eventType) continue;
    insertEvent.run(insttId, date, room.goodsId, eventType, fromStatus, toStatus, occurredAt);
    events.push({ goodsId: room.goodsId, eventType, fromStatus, toStatus, fromRank, toRank });
  }
  return events;
}

/**
 * 현재 상태를 감시에 매칭해 알림을 보낸다.
 *
 * 전이(opened)에만 걸지 않고 **매 스캔의 현재 상태**를 평가한다. 기획서 §4.2 의
 * "계속 열려 있으면 X분당 1회 재알림 / 사라졌다 재등장하면 재알림"을 스로틀로 구현하기
 * 위해서다. 덕분에 DND 로 억눌린 알림도 DND 해제 후 다음 폴에서 자연히 다시 나간다.
 */
export async function evaluateNotifications({ insttId, date, rooms, events = [] }) {
  const now = nowIso();
  const today = todayYmd();

  const watches = db.prepare(`
    SELECT * FROM watch
    WHERE instt_id = ? AND date = ? AND active = 1 AND paused = 0
  `).all(insttId, date);
  if (watches.length === 0) return 0;

  // 이번 스캔에서 닫힘이 관측된 방 — 스로틀 우회(사라졌다 재등장) 판정에 쓴다
  const closedNow = new Set(events.filter((e) => e.eventType === "closed").map((e) => e.goodsId));
  const rankImproved = new Map(
    events.filter((e) => e.eventType === "rank_changed")
      .map((e) => [e.goodsId, parseRank(e.toRank) !== null && parseRank(e.fromRank) !== null
        && parseRank(e.toRank) < parseRank(e.fromRank)])
  );

  const lastNotifStmt = db.prepare(`
    SELECT sent_at FROM notification
    WHERE watch_id = ? AND goods_id = ? AND state = ?
    ORDER BY sent_at DESC LIMIT 1
  `);
  const closedSinceStmt = db.prepare(`
    SELECT 1 FROM watch_event
    WHERE instt_id = ? AND date = ? AND goods_id = ? AND event_type = 'closed' AND occurred_at > ?
    LIMIT 1
  `);
  const insertNotif = db.prepare(`
    INSERT INTO notification (watch_id, device_id, grade, state, date, goods_id, sent_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateNotified = db.prepare(`
    UPDATE watch SET last_notified_state = ?, last_notified_at = ? WHERE id = ?
  `);
  const updateSeen = db.prepare(`
    UPDATE watch SET last_status = ?, last_wait_rank = ?, last_checked_at = ? WHERE id = ?
  `);

  let sent = 0;
  for (const w of watches) {
    const device = db.prepare(`SELECT * FROM device WHERE device_id = ?`).get(w.device_id);
    let grades;
    try { grades = JSON.parse(w.notify_grades); } catch { grades = ["예약가능"]; }

    // 감시 대상 방 추리기: room 감시는 지정 goodsId, forest 감시는 "아무 방이나".
    // 폴링은 (휴양림,날짜,박수)당 **최소 인원 1회**로 병합되므로(ADR-0006 §4),
    // 여기서 감시의 실제 인원으로 다시 걸러야 한다.
    const targets = (w.type === "room"
      ? rooms.filter((r) => r.goodsId && r.goodsId === w.goods_id)
      : rooms
    ).filter((r) => roomFitsParty(r, w.nofpr));

    // 알림 여부와 무관하게 현재 상태를 감시에 반영한다(앱의 currentStatus/lastCheckedAt).
    const best = targets.find((r) => r.status === "예약가능")
      || targets.find((r) => r.status === "대기가능")
      || null;
    updateSeen.run(best?.status ?? null, best?.waitRank ?? null, now, w.id);

    for (const room of targets) {
      const status = room.status ?? null;
      if (!NOTIFIABLE.has(status)) continue;
      if (!grades.includes(status)) continue;

      // 대기신청은 숙박일 D-2 마감 → 그 이후의 대기가능 알림은 무의미
      if (status === "대기가능" && w.wait_deadline && today > w.wait_deadline) continue;

      const urgent = status === "예약가능";
      if (isMuted(device, urgent)) continue;   // DND — 억제만 하고 로그를 남기지 않아 해제 후 재평가된다

      // 재알림 스로틀: 같은 (감시, 방, 상태)는 REMIND_MIN 분당 1회.
      // 단 마지막 알림 이후 닫힘이 관측됐다면 "사라졌다 재등장"이므로 즉시 재알림한다.
      const last = lastNotifStmt.get(w.id, room.goodsId, status);
      if (last) {
        const withinWindow = Date.now() - new Date(last.sent_at).getTime() < REMIND_MIN * 60 * 1000;
        const reopened = closedNow.has(room.goodsId) || !!closedSinceStmt.get(insttId, date, room.goodsId, last.sent_at);
        if (withinWindow && !reopened) continue;
      }

      const grade = urgent ? "예약가능(긴급)" : "대기가능(일반)";
      const rankTxt = status === "대기가능" && room.waitRank ? ` (대기 ${room.waitRank})` : "";
      const payload = {
        // 딥링크는 프리필 불가 → 선착순 검색 진입 페이지 착지 + 카드가 검색값을 대신 표기 (설계서 §6)
        deepLink: "https://www.foresttrip.go.kr/rep/or/fcfsRsrvtMain.do?hmpgId=FRIP&menuId=001001",
        watchId: w.id, insttId, date, nights: w.nights, nofpr: w.nofpr,
        goodsId: room.goodsId, roomLabel: room.detail,
        capacity: room.capacity, price: room.price,
        status, waitRank: room.waitRank ?? null,
      };

      insertNotif.run(w.id, w.device_id, grade, status, date, room.goodsId, now, JSON.stringify(payload));
      updateNotified.run(status, now, w.id);
      await sendPush(device, {
        title: `[숲나들e] ${status}${rankTxt}`,
        body: `${room.detail} — ${date} ${w.nights}박 ${w.nofpr}인 · ${room.price || "가격미상"}`,
        payload, urgent,
      });
      sent++;

      if (w.type === "forest") break;   // 휴양림 감시는 "아무 방이나" 1건이면 충분
    }

    // 대기순위 개선 알림(옵션)
    if (device?.notify_rank_improve && w.type === "room" && rankImproved.get(w.goods_id)) {
      const room = rooms.find((r) => r.goodsId === w.goods_id);
      if (room && !isMuted(device, false)) {
        const payload = { watchId: w.id, insttId, date, goodsId: w.goods_id, waitRank: room.waitRank };
        insertNotif.run(w.id, w.device_id, "순위개선", "대기가능", date, w.goods_id, now, JSON.stringify(payload));
        await sendPush(device, {
          title: `[숲나들e] 대기순위 개선 — ${room.waitRank}`,
          body: `${room.detail} — ${date}`,
          payload, urgent: false,
        });
        sent++;
      }
    }
  }
  return sent;
}

/** 스캔 성공 1건을 통째로 반영: 적재 → 전이 → 알림 */
export async function ingestScan({ insttId, date, nofpr, nights, source, rooms }) {
  const at = nowIso();
  const scanId = recordScan({ insttId, date, nofpr, nights, source, ok: 1, scannedAt: at });
  saveRoomStates(scanId, insttId, date, rooms, at);
  const events = processRoomTransitions({ insttId, date, rooms, scanId, occurredAt: at });
  const sent = await evaluateNotifications({ insttId, date, rooms, events });
  return { scanId, events, sent };
}

/**
 * 스캔 건전성(M5): 최근 스캔의 연속 실패 수. 임계 초과 시 소유자에게 알린다.
 * 프로세스는 살아 있는데 전 스캔이 실패하는 소프트밴/세션사망을 조기에 잡는다.
 */
export function consecutiveFailures(limit = 10) {
  const rows = db.prepare(`SELECT ok FROM scan ORDER BY id DESC LIMIT ?`).all(limit);
  let n = 0;
  for (const r of rows) {
    if (r.ok) break;
    n++;
  }
  return n;
}
