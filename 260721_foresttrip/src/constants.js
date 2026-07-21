// 숲나들e 내부 엔드포인트/상수 모음
// (실제 사이트 fcfsRsrvtMain.do 의 인라인 JS를 분석해 확인한 값들)

export const BASE = "https://www.foresttrip.go.kr";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// selectSiDoList.do 응답 기준 시/도 코드 매핑
export const SIDO = {
  "1": "서울/인천/경기",
  "2": "강원",
  "3": "충북",
  "4": "대전/충남",
  "5": "전북",
  "6": "전남광주",
  "7": "대구/경북",
  "8": "부산/경남",
  "9": "제주",
};

export const ENDPOINTS = {
  // 예약 메인 페이지: 세션쿠키(JSESSIONID/WMONID) + _csrf 토큰 발급, netfunnel.js 로드
  main: "/rep/or/fcfsRsrvtMain.do?hmpgId=FRIP&menuId=001001",

  // --- NetFunnel 게이트 없음: 순수 HTTP(fetch)로 조회 가능 ---
  sidoList: "/rep/or/selectSiDoList.do",              // 시/도 목록
  insttList: "/rep/or/selectInsttListForSearch.do",   // 시/도별 휴양림 목록 (?srchSido=)
  fcltInfo: "/rep/or/selectFcFsRcfrsFcltInfo.do",     // 휴양림별 휴무·추첨·최대숙박 달력 (?insttId=)

  // --- NetFunnel 게이트 있음: 실제 "예약가능 잔여" 조회. 헤드리스 브라우저 필요 ---
  regionAvail: "/rep/or/fcfsRsrvtRcrfrDtlDetls.do",           // 지역+날짜 → 예약가능 휴양림 목록
  goodsAvail: "/rep/or/sssn/fcfsRsrvtPssblGoodsDetls.do",     // 휴양림+날짜 → 예약가능 객실
};
