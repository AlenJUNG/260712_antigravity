// 전역 레이트버짓 (ADR-0006)
//
// 모든 스크래핑(폴링·온디맨드·가용성 갱신)이 단일 숲나들e 계정 세션 하나를 공유하므로
// 요청 총량을 한 곳에서 상한한다. 스케줄러뿐 아니라 REST 온디맨드 경로도 반드시
// 이 모듈을 통과해야 한다 — 예전엔 /v1/search 가 버짓 밖에서 라이브 조회를 돌렸다.
//
// 비용 단위: "goods 페이지 1회 로드" ≈ 1. goods 폴 1건은 예약/대기 2모드 × N페이지라
// 최소 2, 보통 2~4다. 착수 시 추정치로 선차감하고 실제 pagesTraversed 로 사후 정산한다.

import "./env.js";   // 반드시 첫 임포트 — 아래 값들을 모듈 스코프에서 읽는다

const WINDOW_MS = 60 * 1000;

/**
 * R req/min — 전역 상한.
 *
 * 근거(2026-07-23 정리): PoC 의 `scan-nation` 이 **CONCURRENCY=6 병렬로 전국 스캔을
 * 5–7분에 완료하면서 세션오류 0**을 실측했다(코드설계서 §12, 조사보고서). 휴양림당
 * 약 3요청 × 130~190곳 ≈ 400~560요청 / 6분 = **65~90 req/min 버스트를 무사통과**한 셈이다.
 * 여기에 더해 단건 요청 지연이 5~6.5초(2026-07-23 실측)라 단일 워커의 자연 상한은 ~10/min이다.
 *
 * 다만 **버스트 통과 ≠ 24/7 지속 안전**이므로 실측 버스트의 약 1/4인 20 을 기본값으로 둔다.
 * 상향은 작업분해 "24h 지속 폴링 무잠금" 게이트를 통과한 뒤에만 한다.
 *
 * ※ "차단될 때까지 올려보는" 방식으로 상한을 재지 않는다 — 소유자의 실계정 하나로
 *    소프트밴/잠금을 유발하는 실험이라 ADR-0006 이 막으려는 사고를 스스로 일으키는 꼴이다.
 */
export const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 20);

/**
 * goods 폴 1건의 선차감 추정 비용.
 * 실제 요청 수 = 메인 진입 1 + 검색 네비 1 + 대기모드 전환 1 + (추가 페이지 수)
 *            = `pagesTraversed + 1` (1페이지/1페이지면 3). 사후 settle() 로 정산한다.
 */
export const GOODS_POLL_COST = Number(process.env.GOODS_POLL_COST || 3);

/** 폴링 최소 주기(초). 적응형 주기의 바닥선이자 N_max 산출의 기준. */
export const MIN_POLL_INTERVAL_SEC = Number(process.env.MIN_POLL_INTERVAL_SEC || 180);

const hits = []; // 소비 타임스탬프(비용 1당 1개)

function prune(now) {
  while (hits.length > 0 && now - hits[0] > WINDOW_MS) hits.shift();
}

/** 현재 창의 사용량/잔량 */
export function budgetState() {
  prune(Date.now());
  return {
    limit: RATE_LIMIT_PER_MIN,
    used: hits.length,
    remaining: Math.max(0, RATE_LIMIT_PER_MIN - hits.length),
  };
}

/**
 * cost 만큼 예산을 소비하려 시도한다. 부족하면 아무것도 쓰지 않고 false.
 * @returns {boolean} 소비 성공 여부
 */
export function tryConsume(cost = 1) {
  const now = Date.now();
  prune(now);
  if (hits.length + cost > RATE_LIMIT_PER_MIN) return false;
  for (let i = 0; i < cost; i++) hits.push(now);
  return true;
}

/** 사후 정산: 추정보다 실제 비용이 컸을 때 차액을 추가로 차감한다(초과 허용). */
export function settle(estimated, actual) {
  const extra = Math.max(0, Math.round(actual) - Math.round(estimated));
  if (extra <= 0) return;
  const now = Date.now();
  for (let i = 0; i < extra; i++) hits.push(now);
}

/**
 * 신뢰 커버 가능한 활성 poll_target 수 상한 (ADR-0006 §2).
 * 최소 주기 안에 모든 target을 한 번씩 돌 수 있어야 하므로
 *   N_max = (R req/min × 최소주기[min]) / 폴당 비용
 */
export function maxTargets() {
  const perWindow = RATE_LIMIT_PER_MIN * (MIN_POLL_INTERVAL_SEC / 60);
  return Math.max(1, Math.floor(perWindow / GOODS_POLL_COST));
}
