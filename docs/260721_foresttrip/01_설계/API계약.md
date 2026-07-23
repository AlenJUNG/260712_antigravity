# REST API 계약 — 숲나들e 알림 앱 (Phase 0+1)

> 앱↔백엔드 계약. 앱·백엔드 병렬 개발의 기준면. 기존 `server.js`를 확장한다.
> 모든 응답 `application/json; charset=utf-8`. 날짜는 `YYYYMMDD`(KST). 시각은 ISO-8601.
> 버전 프리픽스 `/v1`. **인증: 모든 `/v1/*`에 Bearer 토큰 필수**(헤더 `Authorization: Bearer <appToken>`).
> 백엔드는 집PC이고 앱은 LAN 밖에서 접속하므로 인터넷 노출이 전제 → **무인증 fallback 없음**(ADR-0005).
> 앱↔백엔드 전 구간 TLS(아웃바운드 터널 내장). 토큰 무효·누락은 `401`.
>
> - 버전: 1.1 (2026-07-22 — Phase 0 구현 반영). 구현: `02_구현/src/server.js`.
> - **응답 필드는 전부 camelCase다.** DB 컬럼(snake_case)을 그대로 흘려보내지 않는다(§6 어댑터 책임).
> - **값을 지어내지 않는다.** 측정하지 못한 수치는 `0`이나 임의 상수가 아니라 **`null`**이다
>   (초기 구현이 `roomCount: 36`, `reservableRooms: 4`를 하드코딩해 응답한 적이 있다).

---

## 0. 공통

- 오류 응답: `{ "error": { "code": "STRING", "message": "..." } }` + 적절한 HTTP status.
- 인증: 위 서두 — 모든 `/v1/*`에 `Authorization: Bearer <appToken>`, 무효·누락은 `401`.
  토큰은 상수시간 비교하며, **기본값·개발용 토큰을 두지 않는다**(미설정 시 서버가 기동을 거부).
- 페이지네이션(목록): `?limit=&cursor=` (Phase 1은 소규모라 선택).
- 신선도(2차원, ADR-0003/0006): 스냅샷 응답은 신선도 타임스탬프를 **차원별로** 포함한다.
  값싼 휴양림 단위 가용성은 광역으로 신선하게 유지 가능(`availSnapshotAt`)하나, 비싼 방 단위 대기
  집계는 **감시된 target만 warm**(`waitSnapshotAt`)하고 그 외엔 stale이거나 null이다.

### 0.1 오류 코드

| code | status | 의미 |
|---|---|---|
| `UNAUTHORIZED` | 401 | Bearer 토큰 누락·불일치 |
| `BAD_REQUEST` | 400 | 필수 파라미터 누락·enum 위반·과거 날짜 감시 등 |
| `NOT_FOUND` | 404 | 알 수 없는 `insttId`/`watchId`/`deviceId`/`jobId` |
| `LOGIN_FAILED` | 401 | 숲나들e 로그인 실패(계정 잠금 주의 — 클라이언트가 재시도 자제) |
| `SESSION_EXPIRED` | 503 | 숲나들e 세션 만료. 앱이 재로그인 유도 |
| `RATE_BUDGET_EXHAUSTED` | 429 | 전역 레이트버짓 소진(ADR-0006). `Retry-After` 헤더 동반 |
| `FETCH_FAILED` | 502 | 사이트 조회 실패(NetFunnel/파싱) |
| `INTERNAL` | 500 | 그 외 |

> **429는 정상 동작이다.** 온디맨드 조회도 스케줄러와 **같은 전역 예산**을 쓴다. 예산 밖에서
> 도는 조회 경로를 만들면 ADR-0006이 무의미해진다(초기 구현의 `/v1/search`가 그랬다).

---

## 1. 헬스/카탈로그

### `GET /health` (인증 불필요)
프로세스 생존 확인 전용. **세션 정보를 노출하지 않는다.**
→ `200 { "ok": true }`

### `GET /v1/health`
→ `200`
```json
{
  "ok": true,
  "session": { "loggedIn": true, "valid": true, "needsRelogin": false, "lastLoginAt": "..." },
  "coverage": {
    "activeTargets": 4, "nMax": 6, "degraded": false, "nearLimit": false,
    "budget": { "limit": 6, "used": 2, "remaining": 4 }
  }
}
```
- `coverage`는 ADR-0006 §2의 **커버리지 상한을 1급 제약으로 노출**한 것이다.
  `nMax = (R req/min × 최소폴링주기[min]) / 폴당비용`. `degraded=true`면 앱이 감시 추가를
  경고·억제하고 "일부 감시가 지연 중"임을 표시한다.

### `GET /v1/sido`
시/도 코드 목록. (기존 `catalog.getSidoList`)
→ `200 [ { "code": "2", "name": "강원" }, ... ]`

### `GET /v1/forests?sido={code}`
시/도별 휴양림 목록 + 메타. `sido` 생략 시 전국. (DB 카탈로그 캐시에서 즉답)
→ `200`
```json
[
  { "insttId": "ID01030001", "name": "(강릉시)대관령자연휴양림", "type": "국립", "sido": "2",
    "openYear": 1989, "isNew": false, "maxNights": 3, "cycleType": "WEEK" }
]
```
- `type`: 국립/공립/사립 (insttTpCd 01/02/04 매핑). `openYear`/`isNew`는 국립만, 그 외 null.
- `maxNights`/`cycleType`: 휴양림별 최대 숙박일수·예약주기(DB스키마 v1.1). 미상이면 null.

### `GET /v1/forests/{insttId}/calendar`
휴양림 달력(휴무/추첨/최대숙박).
→ `200`
```json
{
  "insttId": "ID01030001", "maxNights": 3, "cycleType": "WEEK",
  "dates": [
    { "date": "20260801", "kind": "추첨", "name": "주말 추첨" },
    { "date": "20260805", "kind": "휴무", "name": "정기휴무일" }
  ]
}
```
- **`dates`는 "특일"만 담는다.** `kind`는 `추첨 | 휴무` 둘뿐이고, **배열에 없는 날짜는 선착순**이다.
  앱은 이 부재를 선착순으로 해석해야 한다(모든 날짜가 열거될 거라 가정하면 안 된다).
- 오늘 이후 날짜만 반환한다. 기동 시 `all-forests-raw.json`으로 전국이 미리 캐시되며,
  캐시가 비었을 때만 사이트를 조회한다.

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
**요청 스레드에서 사이트를 긁지 않는다** — DB 스냅샷만 즉시(수십 ms) 반환한다.
→ `200`
```json
{
  "date": "20260819", "nights": 1, "nofpr": 2, "sido": "2",
  "availSnapshotAt": "2026-07-22T09:55:00+09:00",
  "waitSnapshotAt": "2026-07-22T09:40:00+09:00",
  "refreshing": { "avail": true, "wait": false },
  "dayKind": "선착순",
  "coverage": { "activeTargets": 4, "nMax": 6, "degraded": false },
  "forests": [
    { "insttId": "ID01030001", "name": "(강릉시)대관령자연휴양림", "type": "국립",
      "openYear": 1989, "isNew": false, "dayKind": "선착순",
      "reservable": true, "reservableRooms": 4, "roomCount": 36,
      "waitable": true, "waitableRooms": 12,
      "waitCovered": true,
      "availSnapshotAt": "2026-07-22T09:55:00+09:00",
      "waitSnapshotAt": "2026-07-22T09:40:00+09:00" }
  ]
}
```
- **두 차원의 신선도가 다르다(ADR-0003/0006, 설계서 §9 H3):**
  - `reservable`: 휴양림 단위 가용성(로그인 불필요·시도당 1req). 광역으로 값싸게 최신 유지 →
    `availSnapshotAt`. 스냅샷이 없으면 **`null`**(false가 아니다 — "예약불가"와 "모른다"는 다르다).
  - `waitable`/`waitableRooms`/`reservableRooms`/`roomCount`: 방 단위 집계(로그인·휴양림당 1req·고비용).
    **감시된 target만 warm** → 미감시 휴양림은 `waitCovered:false` + 해당 수치 전부 `null`.
    앱은 "대기 정보 미수집(탭하면 온디맨드)"으로 표시하고, 탭 시 `GET /forests/{id}/rooms`로 확정한다.
- **타임스탬프는 실제 측정 시각이다.** 최상위 `availSnapshotAt`/`waitSnapshotAt`은 응답에 포함된
  스냅샷 중 **가장 오래된 시각**(보수적)이고, 해당 데이터가 하나도 없으면 `null`이다.
  갱신하지 않았으면서 "지금"을 적어 넣으면 안 된다(초기 구현이 `waitSnapshotAt: now`를 그렇게 넣었다).
- `refreshing.avail=true`는 **실제로 백그라운드 갱신 잡이 큐에 들어갔음**을 뜻한다(상수 false 금지).
  스냅샷이 `AVAIL_TTL_SEC`(기본 600초)보다 오래되면 자동 큐잉된다. `sido` 생략 시 9개 시도 전부.
- **`dayKind`는 휴양림별 필드가 정본이다.** 정기휴무일이 휴양림마다 달라 (날짜) 하나로 단일
  판정이 성립하지 않는다. 최상위 `dayKind`는 **결과 집합의 최빈값**일 뿐인 하위호환 필드이며
  앱은 휴양림별 `forests[].dayKind`를 써야 한다. (Phase 2에서 최상위 필드 제거 검토)
- `coverage`는 `/v1/health`와 동일한 축약본.

### `POST /v1/search/refresh`
해당 (날짜,인원,지역) 스냅샷 강제 갱신 요청(백그라운드). `sido` 생략 시 전국 9개 시도.
```json
// req { "date":"20260819", "nights":1, "nofpr":2, "sido":"2" }
// res 202 { "jobId": "job_..." }
```

### `GET /v1/search/refresh/{jobId}`
갱신 잡 진행 상태.
→ `200 { "jobId":"job_...", "status":"queued|running|done|failed", "queuedAt":"...", "finishedAt":null, "remaining": 3 }`
- `remaining`: 아직 처리되지 않은 시도 수. 잡은 레이트버짓을 소비하므로 즉시 끝나지 않는다.

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
  `pagesTraversed`(두 모드 합산 순회 페이지수)와 `complete: true/false`(순회 실패 시 false)를 포함.
  - 누적은 **`goodsId` 기준 dedup**이다. 페이징은 내부 AJAX라 load 이벤트가 없어, 전환 완료를
    **목록 지문(goodsId 나열) 변화**로 판정한다. dedup 없이 concat하면 전환 실패 시 1페이지가
    중복 적재돼 대기 방 수가 부풀고 전이 판정까지 오염된다.
  - 전환에 실패하면 **조용히 자르지 말고** 순회를 중단하고 `complete: false`로 보고한다.
- **이 엔드포인트도 전역 레이트버짓을 소비한다.** 예산 소진 시 `429 RATE_BUDGET_EXHAUSTED`
  (+`Retry-After`). 세션 만료 시 `503 SESSION_EXPIRED`.
- 조회 결과는 `scan`/`room_state`에 적재되고 전이·알림 판정을 거친다(폴링과 동일 경로).

---

## 4. 디바이스/푸시

### `POST /v1/devices`
```json
// req
{ "deviceId": "uuid", "fcmToken": "...", "platform": "android" }
// res 200 { "deviceId": "uuid" }
```

### `PATCH /v1/devices/{deviceId}`
알림 환경설정. 생략한 필드는 **기존 값을 유지**한다(부분 갱신).
```json
// req
{ "dndStart": "23:00", "dndEnd": "07:00",
  "urgentBypassDnd": true, "notifyRankImprove": false }
// res 200 (갱신 결과 반환)
{ "deviceId": "uuid", "dndStart": "23:00", "dndEnd": "07:00",
  "urgentBypassDnd": true, "notifyRankImprove": false }
```
- DND는 `"HH:MM"` KST. `dndStart > dndEnd`(예: 23:00~07:00)는 **자정 넘김 구간**으로 해석한다.
- `urgentBypassDnd`가 참이면 `예약가능`(긴급) 알림만 DND를 관통한다.
- **DND는 억제이지 소실이 아니다.** 억제된 알림은 로그를 남기지 않으므로, DND가 끝난 뒤 방이
  여전히 열려 있으면 다음 폴에서 자연히 다시 발송된다(§5 재알림 규칙 참조).

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

// res 201 — 생성된 감시 전체(GET /v1/watches/{id} 와 동일 형태)
```
- `type`: `room | forest`. `room`이면 `goodsId`(+`roomLabel` 백업) 필수.
- 날짜: `date`(단일) **또는** `rangeStart`/`rangeEnd`(희망기간, 박수 고정) 중 하나.
  Phase 1은 `date`만 동작하며 희망기간은 `400`으로 거절한다.
- `weekdayFilter`: `any | weekday | weekend`(Phase 2).
- `priority`: `normal | urgent`(폴링 가중).
- 서버가 `waitDeadline`(D-2) 계산해 반환.
- **응답은 반드시 `id`를 포함한다.** `{"success":true}`만 돌려주면 앱이 방금 만든 감시를
  PATCH·DELETE 할 수 없다. `id`는 충돌하지 않는 난수(`W` + 12 hex)이며, 생성 시 중복을 확인한다.
- **입력 검증(400):** 미등록 `deviceId` · 알 수 없는 `insttId` · `room`인데 `goodsId` 누락 ·
  과거 날짜 · `notifyGrades`가 `["예약가능","대기가능"]`의 부분집합이 아닌 경우.

### `GET /v1/watches/{id}`
감시 상세 + 현재 상태 + 최근 이벤트 요약.
```json
{ "id":"W7943DFF0AD88", "deviceId":"uuid", "type":"room",
  "insttId":"ID01030001", "goodsId":"G12345", "roomLabel":"[숲속의집]…",
  "date":"20260819", "rangeStart":null, "rangeEnd":null,
  "nights":1, "nofpr":6, "weekdayFilter":"any",
  "active":true, "paused":false, "priority":"normal",
  "notifyGrades":["예약가능","대기가능"],
  "waitDeadline":"20260817",
  "currentStatus":"대기가능", "currentWaitRank":"3순위",
  "lastCheckedAt":"2026-07-22T10:05:00+09:00",
  "lastNotifiedState":"대기가능", "lastNotifiedAt":"2026-07-22T09:41:00+09:00",
  "pollingDelayed": false, "lastPolledAt":"2026-07-22T10:05:00+09:00",
  "recentEvents":[
    { "type":"opened", "from":null, "state":"대기가능", "at":"2026-07-22T09:40:00+09:00" }
  ] }
```
- `currentStatus`/`currentWaitRank`/`lastCheckedAt`은 **알림 발송 여부와 무관하게** 매 스캔마다
  갱신된다(알림이 스로틀·DND로 억제돼도 현재 상태는 최신이어야 한다).
- **`pollingDelayed`(ADR-0006 §3):** 예산 부족·백오프로 폴링이 예정보다 밀리면 `true`.
  굶는 감시를 침묵시키지 않기 위한 필드이며, 앱은 "폴링 지연 중"으로 표시한다.
- `recentEvents`는 최근 20건. `room` 감시는 해당 `goodsId`, `forest` 감시는 그 휴양림 전체.

### `PATCH /v1/watches/{id}`
일시정지/재개/우선순위/알림등급 변경. `{ "paused": true }` 등.
→ `200` **갱신된 감시 전체**(GET과 동일 형태). 잘못된 enum은 `400`.

### `DELETE /v1/watches/{id}`
감시 삭제(연관 `notification` 로그도 함께 정리). → `200 { "success": true }`

### `GET /v1/watches/{id}/events`  (타임라인, Phase 1부터 적재)
열림/닫힘/순위변경 이벤트 시계열(놓친 알림 타임라인). 항목 형태는 `recentEvents`와 동일.

### 알림 발송 규칙 (백엔드 동작 명세)

앱이 기대할 수 있는 알림 타이밍을 계약으로 못박는다.

- 알림은 **전이 시점이 아니라 매 스캔의 현재 상태**로 평가한다. 기획서 §4.2의 "계속 열려 있으면
  X분당 1회 / 사라졌다 재등장하면 재알림"을 스로틀로 구현하기 위해서다. 전이(opened)에만 걸면
  DND·스로틀로 한 번 억제된 알림이 영원히 사라진다.
- 스로틀 단위는 (감시, 방, 상태). 계속 열려 있는 방의 재알림 간격은 `REMIND_MIN`으로,
  기본 `max(30분, 폴주기×2)`. 단 **마지막 알림 이후 `closed` 이벤트가 있었으면 즉시 재알림**한다
  (사라졌다 재등장). ⚠ **이 간격은 폴링 주기보다 확실히 커야 한다** — 비슷하면(예전 10분,
  normal 폴 주기도 10분) 매 폴마다 "막 X분 지났다"가 성립해 스로틀이 무력화된다.
  2026-07-22 소크에서 계속 열린 방이 폴마다 재알림돼(617초 > 600초) 실제로 확인됨.
- `대기가능` 알림은 `waitDeadline`(D-2)이 지나면 보내지 않는다. 대기 전용 감시는 그 시점에
  `active=false`로 자동 종료된다.
- `forest` 감시는 방 하나가 매치되면 그 스캔에서 1건만 보낸다(방 수만큼 쏟아내지 않는다).
- 페이로드는 §6의 핸드오프 카드 데이터(휴양림·날짜·박수·인원·방·가격·상태·대기순위)와
  착지 딥링크(`fcfsRsrvtMain.do`)를 담는다. 설계서 §6대로 **프리필은 불가**하다.

---

## 6. 상태값 표준 (앱↔백엔드 공통 enum)

| 필드 | 값 |
|---|---|
| status | `예약가능` \| `대기가능` \| `null`(불가) |
| type(휴양림) | `국립` \| `공립` \| `사립` |
| dayKind | `선착순` \| `추첨` \| `휴무` (달력에는 `추첨`/`휴무`만 저장, 부재 = `선착순`) |
| watch.type | `room` \| `forest` |
| priority | `normal` \| `urgent` |
| notify grade | `예약가능`(긴급) \| `대기가능`(일반) \| `순위개선`(옵션) |
| watch event type | `opened` \| `closed` \| `rank_changed` |
| refresh job status | `queued` \| `running` \| `done` \| `failed` |

> **와이어 값 안정성(수집계층 어댑터 책임, M2):** 위 한국어 값은 앱↔백엔드 계약값이며, 사이트에서
> 긁은 원문 텍스트를 그대로 흘려보내지 않는다. 수집계층 어댑터(작업분해 §0.2)가 파싱 결과를 이 표의
> 값으로 **정규화**해 사이트 표시문구 변경이 계약으로 새지 않게 격리한다. 영문 코드화·i18n이
> 필요해지면 이 어댑터 한 곳만 바꾼다.

---

## 7. Phase별 엔드포인트 편입

- **Phase 0/1:** §1~§5 전부(단, `weekdayFilter`·`rangeStart/End`는 계약만 두고 동작은 Phase 2).
  **Bearer 토큰(ADR-0005)·검색 신선도 2차원(§3, H3)·커버리지 노출(ADR-0006)은 Phase 0/1 필수.**
  구현 상태(2026-07-22): §1~§5 구현 완료, FCM 실발송만 스텁(작업분해 §0.4).
- **Phase 2:** 희망기간/요일필터 실동작, 히트맵용 `GET /v1/forests/{insttId}/heatmap?rangeStart=&rangeEnd=&nofpr=`.
- **Phase 3:** `GET /v1/forests/{insttId}/patterns`(명당시간), watch 응답에 `waitSuccessProb`.
- **Phase 4:** `POST /v1/watches` 에 `type:"query"`(광역 조건 감시).
