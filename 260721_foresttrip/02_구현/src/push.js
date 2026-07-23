// 푸시 발송 지점 + DND 판정.
//
// FCM Admin SDK 는 아직 미연결(작업분해 §0.4). 지금은 발송 시도를 로그로 남기고,
// 실제 연결 시 sendPush() 내부 한 곳만 교체하면 되도록 격리해 둔다.

import { appendFileSync, mkdirSync } from "node:fs";
import { db } from "./db.js";
import { nowIso, nowHmKst } from "./dates.js";

const PUSH_LOG = "data/pushes.log";

/**
 * DND(방해금지) 시간대에 걸리는지 판정한다. (기획서 §4.2)
 * - urgent(예약가능) 알림은 디바이스가 urgent_bypass_dnd 면 DND를 관통한다.
 * - dnd_start > dnd_end (예: 23:00~07:00) 인 자정 넘김 구간을 지원한다.
 */
export function isMuted(device, urgent, at = new Date()) {
  if (!device) return false;
  if (urgent && device.urgent_bypass_dnd) return false;
  const start = device.dnd_start, end = device.dnd_end;
  if (!start || !end) return false;

  const hm = nowHmKst(at);
  if (start === end) return false;          // 빈 구간으로 취급
  if (start < end) return hm >= start && hm < end;
  return hm >= start || hm < end;           // 자정 넘김
}

/**
 * 실제 발송. 현재는 로그 스텁.
 * @param {object} device device 테이블 행
 * @param {{title:string, body:string, payload?:object, urgent?:boolean}} msg
 */
export async function sendPush(device, { title, body, payload = {}, urgent = false }) {
  const line = JSON.stringify({
    at: nowIso(),
    deviceId: device?.device_id ?? null,
    fcmToken: device?.fcm_token ? "(설정됨)" : null,   // 토큰 원문은 로그에 남기지 않는다
    channel: urgent ? "urgent" : "normal",
    title, body, payload,
  });
  try {
    mkdirSync("data", { recursive: true });
    appendFileSync(PUSH_LOG, line + "\n");
  } catch { /* 로그 실패로 폴링을 죽이지 않는다 */ }
  console.log(`[PUSH:${urgent ? "긴급" : "일반"}] ${title} — ${body}`);
  // TODO(작업분해 §0.4): firebase-admin messaging().send({ token: device.fcm_token, ... })
  return true;
}

/**
 * 소유자(등록된 모든 디바이스)에게 운영 알림을 보낸다.
 * 세션 사망·재로그인 필요·스캔 연속실패 등 "조용히 죽는" 상황을 표면화하는 용도라
 * DND를 관통한다(설계서 §5.4, 위험표 M5).
 */
export async function pushToOwner({ title, body, payload = {} }) {
  const devices = db.prepare(`SELECT * FROM device`).all();
  if (devices.length === 0) {
    console.warn(`[OWNER] 등록된 디바이스가 없어 알림을 보내지 못함: ${title} — ${body}`);
    return 0;
  }
  for (const d of devices) {
    await sendPush(d, { title, body, payload, urgent: true });
  }
  return devices.length;
}
