# REST API 계약 초안 — 숲나들e 알림 앱 (Phase 0+1)

> 앱↔백엔드 계약. 앱·백엔드 병렬 개발의 기준면. 기존 `server.js`를 확장한다.
> 모든 응답 `application/json; charset=utf-8`. 날짜는 `YYYYMMDD`. 시각은 ISO-8601(KST).
> 버전 프리픽스 `/v1`. **인증: 모든 `/v1/*`에 Bearer 토큰 필수**(헤더 `Authorization: Bearer <appToken>`).
> 백엔드는 집PC이고 앱은 LAN 밖에서 접속하므로 인터넷 노출이 전제 → **무인증 fallback 없음**(ADR-0005).
> 앱↔백엔드 전 구간 TLS(아웃바운드 터널 내장). 토큰 무효·누락은 `401`.

---

## 0. 공통

- 오류 응답: `{ "error": { "code": "STRING", "message": "..." } }` + 적절한 HTTP status.
- 인증: 위 서두 — 모든 엔드포인트 `Authorization: Bearer <appToken>`, 무효·누락은 `401`.
- 페이지네이션(목록): `?limit=&cursor=` (Phase 1은 소규모라 선택).
- 신선도(2차원, ADR-0003/0006): 스냅샷 응답은 신선도 타임스탬프를 **차원별로** 포함한다.
  값싼 휴양림 단위 가용성은 광역으로 신선하게 유지 가능(`availSnapshotAt`)하나, 비싼 방 단위 대기
  집계는 **감시된 target만 warm**(`waitSnapshotAt`)하고 그 외엔 stale이거나 null이다.

---

## 1. 헬스/카탈로그

### `GET /v1/health`
→ `200 { "ok": true, "session": { "loggedIn": true, "valid": true, "lastLoginAt": "..." } }`

### `GET /v1/sido`
시/도 코드 목록. (기존 `catalog.getSidoList`)
→ `200 [ { "code": "2", "name": "강원" }, ... ]`

### `GET /v1/forests?sido={code}`
시/도별 휴양림 목록 + 메타. (기존 `getInsttList` + `openYear` + type)
→ `200`
```json
[
  { "insttId": "0111", "name": "(강릉시)대관령자연휴양림", "type": "국립",
    "openYear": 1989, "isNew": false }
]
```
- `type`: 국립/공립/사립 (insttTpCd 01/02/04 매핑). `openYear`/`isNew`는 국립만, 그 외 null.

### `GET /v1/forests/{insttId}/calendar`
휴양림 달력(휴무/추첨/최대숙박). (기존 `getFacilityCalendar`)
→ `200`
```json
{
  "insttId": "0111", "maxNights": 3, "cycleType": "WEEK",
  "dates": [
    { "date": "20260801", "kind": "추첨", "name": "주말 추첨" },
    { "date": "20260805", "kind": "휴무", "name": "정기휴무일" }
  ]
}
```
- `kind`: `선착순 | 추첨 | 휴무` (dtCd 01=휴무, 02=추첨 등에서 파생. 그 외 날짜는 선착순).

---

## 2. 인증 (소유자 숲나들e 로그인, ADR-0002)

### `POST /v1/auth/forest-login`
소유자가 숲나들e 자격증명 1회 입력. 백엔드가 로그인→세션 확보→자격증명 암호화 저장.
```json
// req
{ "loginId": "...", "loginPwd": "..." }
// res 200
{ "loggedIn": true, "valid": true, "lastLoginAt": "2026-07-22T10:00:00+09:00" }
// res 401  { "error": { "code": "LOGIN_FAILED", "message": "..." } }
```
- 서버는 **비밀번호를 로깅하지 않는다.** 실패해도 재시도는 클라이언트가 신중히(계정잠금 5회).

### `GET /v1/auth/status`
→ `200 { "loggedIn": true, "valid": true, "lastLoginAt": "...", "needsRelogin": false }`
- 자동 재로그인 실패로 `needsRelogin=true`면 앱이 재로그인 유도.

### `DELETE /v1/auth/forest-login`
저장 자격증명·세션 삭제(로그아웃).

---

## 3. 전국/지역 조회 (스냅샷 + 온디맨드, ADR-0003)

### `GET /v1/search?date=&nights=&nofpr=&sido=`
스냅샷 기반 휴양림 단위 결과(예약가능/대기가능 요약). `sido` 생략 시 전국.
→ `200`
```json
{
  "date": "20260819", "nights": 1, "nofpr": 2, "sido": "2",
  "availSnapshotAt": "2026-07-22T09:55:00+09:00",
  "waitSnapshotAt": "2026-07-22T09:40:00+09:00",
  "refreshing": { "avail": false, "wait": true },
  "dayKind": "선착순",
  "forests": [
    { "insttId": "0111", "name": "(강릉시)대관령자연휴양림", "type": "국립",
      "openYear": 1989, "isNew": false,
      "reservable": true, "reservableRooms": 4, "roomCount": 36,
      "waitable": true, "waitableRooms": 12,
      "waitCovered": true, "waitSnapshotAt": "2026-07-22T09:40:00+09:00" }
  ]
}
```
- **두 차원의 신선도가 다르다(ADR-0003/0006, 설계서 §9 H3):**
  - `reservable`/`reservableRooms`: 휴양림 단위 가용성(로그인 불필요·시도당 1req). 광역으로 값싸게
    최신 유지 → `availSnapshotAt`. 부족 시 `refreshing.avail=true`로 백그라운드 스캔 큐잉.
  - `waitable`/`waitableRooms`: 방 단위 대기 집계(로그인·휴양림당 1req·고비용). **감시된 target만
    warm** → 미감시 휴양림은 `waitCovered:false` + `waitable`/`waitableRooms:null`일 수 있다.
    앱은 이를 "대기 정보 미수집(탭하면 온디맨드)"으로 표시하고, 사용자가 탭하면
    `GET /forests/{id}/rooms`로 실시간 확정한다.
- `refreshing`은 차원별 객체다(`avail`/`wait` 각각 boolean).

### `POST /v1/search/refresh`
해당 (날짜,인원,지역) 스냅샷 강제 갱신 요청(백그라운드).
```json
// req { "date":"20260819", "nights":1, "nofpr":2, "sido":"2" }
// res 202 { "jobId": "..." }
```

### `GET /v1/forests/{insttId}/rooms?date=&nights=&nofpr=&includeWait=1`
**온디맨드 실시간** 객실 단위 조회(탭 시). (기존 `goods.searchForestGoods`)
→ `200`
```json
{
  "insttId": "0111", "date": "20260819", "nights": 1, "nofpr": 2,
  "fetchedAt": "2026-07-22T10:01:00+09:00",
  "rooms": [
    { "goodsId": "G12345", "facility": "휴양관",
      "detail": "[휴양관]1차산림휴양관 101호 (구상나무) 4/4인실(23㎡)",
      "capacity": "4/4인실(23㎡)", "price": "1박(평일)102,000원",
      "status": "예약가능", "reservable": true, "waitable": false, "waitRank": null }
  ]
}
```
- `status`: `예약가능 | 대기가능 | null`. `waitRank`: 대기 모드에서 "2순위" 등.
- **페이지네이션(확정, 설계서 §6-bis):** 백엔드가 예약·대기 각 모드의 `fn_goPage` **전 페이지를
  순회·누적**해 `rooms`에 전량 반환한다(모드별 페이지당 ~10개, 대형 휴양림은 2–3페이지). 응답에
  `pagesTraversed`(모드별 순회 페이지수)와 `complete: true/false`(순회 실패 시 false)를 포함.

---

## 4. 디바이스/푸시

### `POST /v1/devices`
```json
// req
{ "deviceId": "uuid", "fcmToken": "...", "platform": "android" }
// res 200 { "deviceId": "uuid" }
```

### `PATCH /v1/devices/{deviceId}`
알림 환경설정.
```json
{ "dndStart": "23:00", "dndEnd": "07:00",
  "urgentBypassDnd": true, "notifyRankImprove": false }
```

---

## 5. 감시(Watch)

### `GET /v1/watches?deviceId=`
해당 디바이스 감시 목록(현재 상태 요약 포함).

### `POST /v1/watches`
```json
// req (숙소상세 감시, 단일 날짜)
{ "deviceId":"uuid", "type":"room",
  "insttId":"0111", "goodsId":"G12345",
  "roomLabel":"[숲속의집]2차숲속의집 5동 (화개산) (6인/48㎡)",
  "date":"20260819", "nights":1, "nofpr":6,
  "priority":"normal", "notifyGrades":["예약가능","대기가능"] }

// req (휴양림 "아무 방이나", 희망기간)  ※ 희망기간은 Phase 2지만 계약은 미리 확정
{ "deviceId":"uuid", "type":"forest",
  "insttId":"0111",
  "rangeStart":"20260810", "rangeEnd":"20260820",
  "nights":2, "nofpr":4, "weekdayFilter":"weekend",
  "priority":"urgent", "notifyGrades":["예약가능"] }

// res 201 { "id": "W789", ...(생성된 감시 전체) }
```
- `type`: `room | forest`. `room`이면 `goodsId`(+`roomLabel` 백업) 필수.
- 날짜: `date`(단일) **또는** `rangeStart`/`rangeEnd`(희망기간, 박수 고정) 중 하나.
- `weekdayFilter`: `any | weekday | weekend`(Phase 2).
- `priority`: `normal | urgent`(폴링 가중).
- 서버가 `waitDeadline`(D-2) 계산해 반환.

### `GET /v1/watches/{id}`
감시 상세 + 현재 상태 + 최근 이벤트 요약.
```json
{ "id":"W789", "type":"room", "insttId":"0111", "goodsId":"G12345",
  "date":"20260819", "nights":1, "nofpr":6,
  "active":true, "paused":false, "priority":"normal",
  "waitDeadline":"20260817",
  "currentStatus":"대기가능", "currentWaitRank":"3순위",
  "lastCheckedAt":"2026-07-22T10:05:00+09:00",
  "lastNotifiedState":"대기가능",
  "recentEvents":[
    { "type":"opened", "state":"대기가능", "at":"2026-07-22T09:40:00+09:00" }
  ] }
```

### `PATCH /v1/watches/{id}`
일시정지/재개/우선순위/알림등급 변경. `{ "paused": true }` 등.

### `DELETE /v1/watches/{id}`
감시 삭제.

### `GET /v1/watches/{id}/events`  (타임라인, Phase 1부터 적재)
열림/닫힘/순위변경 이벤트 시계열(놓친 알림 타임라인).

---

## 6. 상태값 표준 (앱↔백엔드 공통 enum)

| 필드 | 값 |
|---|---|
| status | `예약가능` \| `대기가능` \| `null`(불가) |
| type(휴양림) | `국립` \| `공립` \| `사립` |
| dayKind | `선착순` \| `추첨` \| `휴무` |
| watch.type | `room` \| `forest` |
| priority | `normal` \| `urgent` |
| notify grade | `예약가능`(긴급) \| `대기가능`(일반) |

> **와이어 값 안정성(수집계층 어댑터 책임, M2):** 위 한국어 값은 앱↔백엔드 계약값이며, 사이트에서
> 긁은 원문 텍스트를 그대로 흘려보내지 않는다. 수집계층 어댑터(작업분해 §0.2)가 파싱 결과를 이 표의
> 값으로 **정규화**해 사이트 표시문구 변경이 계약으로 새지 않게 격리한다. 영문 코드화·i18n이
> 필요해지면 이 어댑터 한 곳만 바꾼다.

---

## 7. Phase별 엔드포인트 편입

- **Phase 0/1:** §1~§5 전부(단, `weekdayFilter`·`rangeStart/End`는 계약만 두고 동작은 Phase 2).
  **Bearer 토큰(ADR-0005)·검색 신선도 2차원(§3, H3)은 Phase 0/1 필수.**
- **Phase 2:** 희망기간/요일필터 실동작, 히트맵용 `GET /v1/forests/{insttId}/heatmap?rangeStart=&rangeEnd=&nofpr=`.
- **Phase 3:** `GET /v1/forests/{insttId}/patterns`(명당시간), watch 응답에 `waitSuccessProb`.
- **Phase 4:** `POST /v1/watches` 에 `type:"query"`(광역 조건 감시).
