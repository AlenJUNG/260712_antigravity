// NetFunnel 게이트가 없는 카탈로그/메타 조회 (순수 HTTP)
//  - 시/도 목록
//  - 시/도별 휴양림 목록
//  - 휴양림별 달력 메타(정기휴무일 / 주말 추첨일 / 최대 숙박일수)

import { ENDPOINTS } from "./constants.js";
import { ajaxGet } from "./session.js";

/** 시/도 목록 [{detailCode, codeNm}] */
export async function getSidoList(session) {
  const rows = await ajaxGet(session, ENDPOINTS.sidoList);
  return rows.map((r) => ({ code: r.detailCode, name: r.codeNm.trim() }));
}

/** 특정 시/도의 휴양림 목록 [{insttId, insttNm, insttTpCd}] */
export async function getInsttList(session, sidoCode) {
  const data = await ajaxGet(session, ENDPOINTS.insttList, { srchSido: sidoCode });
  return (data.insttList ?? []).map((r) => ({
    insttId: r.insttId,
    insttNm: r.insttNm,
    insttTpCd: r.insttTpCd, // 01=국립 등 구분코드
  }));
}

/**
 * 휴양림별 달력 메타.
 * hldtList 로 어떤 날짜가 "정기휴무일 / 주말 추첨 / 공휴일" 인지 구분할 수 있다.
 * 선착순(평일) 예약가능 조회 대상 날짜를 추리는 데 사용.
 */
export async function getFacilityCalendar(session, insttId) {
  const data = await ajaxGet(session, ENDPOINTS.fcltInfo, { insttId });
  return {
    maxNights: data.rcfrsFcltInfo?.[0]?.mxmmStngDayCnt ?? null,
    cycleType: data.RsrvtRgstnAvailVO?.rsrvtCycleTpeCd ?? null, // WEEK 등
    specialDates: (data.hldtList ?? []).map((h) => ({
      date: h.dt,        // YYYYMMDD
      code: h.dtCd,      // 01=정기휴무, 02=추첨 등
      name: h.dtNm,      // "정기휴무일" / "주말 추첨" / "추석" ...
    })),
  };
}
