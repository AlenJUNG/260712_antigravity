// 날짜 유틸 — 사이트가 쓰는 날짜(YYYYMMDD)는 전부 KST 기준이다.
//
// ※ Date#toISOString() 은 UTC라 KST 자정 근처에서 하루가 밀린다. 예전 코드가
//   `new Date().toISOString().slice(0, 8)` 로 오늘 날짜를 만들었는데 이건
//   "2026-07-" 라는 8글자(YYYYMMDD 아님)여서 같은 해 과거 날짜가 전부 필터를
//   통과했다. 날짜 비교/생성은 반드시 이 모듈만 쓸 것.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Date → KST 기준 YYYYMMDD */
export function toYmd(dt) {
  const k = new Date(dt.getTime() + KST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}${p(k.getUTCMonth() + 1)}${p(k.getUTCDate())}`;
}

/** 지금(KST) 기준 오늘 YYYYMMDD */
export function todayYmd() {
  return toYmd(new Date());
}

/** YYYYMMDD 가 형식에 맞는지 */
export function isYmd(s) {
  return typeof s === "string" && /^\d{8}$/.test(s);
}

/** YYYYMMDD → 그 날 00:00(KST)에 해당하는 Date */
export function ymdToDate(ymd) {
  const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6) - 1, d = +ymd.slice(6, 8);
  return new Date(Date.UTC(y, m, d) - KST_OFFSET_MS);
}

/** YYYYMMDD + days → YYYYMMDD */
export function addDays(ymd, days) {
  return toYmd(new Date(ymdToDate(ymd).getTime() + days * 86400000));
}

/** 오늘(KST)로부터 대상일까지 남은 일수. 오늘이면 0, 어제면 -1 */
export function daysUntil(ymd) {
  return Math.round((ymdToDate(ymd) - ymdToDate(todayYmd())) / 86400000);
}

/** 현재 KST 기준 "HH:MM" */
export function nowHmKst(dt = new Date()) {
  const k = new Date(dt.getTime() + KST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

/** 현재 KST 기준 시(0-23) */
export function nowHourKst(dt = new Date()) {
  return new Date(dt.getTime() + KST_OFFSET_MS).getUTCHours();
}

/** 저장/응답용 타임스탬프(ISO-8601). 저장은 UTC ISO로 통일하고 표시만 KST로 해석한다. */
export function nowIso() {
  return new Date().toISOString();
}
