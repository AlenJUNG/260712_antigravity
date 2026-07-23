# NAS MCP에 HTML 저장 기능 추가하기 — 정석 가이드

> 기존 시놀로지 MCP 서버(도구: `save_markdown` 하나)에 **`.html` 파일 저장 기능**을 더하는 절차서입니다.
> 전제 구성은 [[MCP설정1]]과 동일합니다: **FastMCP(Python) + Synology Docker + HTTPS 역방향 프록시 + Google OAuth + claude.ai 커스텀 커넥터.**

---

## 0. 이 문서가 하는 일

현재 서버는 `save_markdown(title, content)` 하나뿐이라 확장자가 `.md`로 고정되어 HTML을 저장할 수 없습니다.
여기에 **`save_html(title, content)`** 도구를 추가해, 완성된 HTML 문서를 NAS에 진짜 `.html`로 저장하게 만듭니다.

**바꾸는 건 딱 3가지뿐입니다:**

```
① server.py 에 도구 1개 추가
② 컨테이너 재빌드 (⚠️ 단순 재시작 아님)
③ claude.ai 커넥터 도구 새로고침
```

> ✅ `.env` · `docker-compose.yml` · 역방향 프록시 · Google OAuth · Let's Encrypt 인증서는 **전혀 손대지 않습니다.**
> ✅ 추가 파이썬 의존성(`requirements.txt`) **변경 없음** (표준 라이브러리만 사용).

---

## 1. [0단계] 백업

문제 발생 시 즉시 롤백할 수 있도록 원본을 남깁니다.

- NAS `File Station`에서 `nas-notes-mcp/server.py` 복사 → `server.py.bak` 로 보관.

---

## 2. [1단계] `server.py` 편집

편집 방법(택1):

- **File Station** → `server.py` 우클릭 → 텍스트 편집기로 열기 (가장 간단)
- **SSH** 접속 후 `nano /volume1/docker/nas-notes-mcp/server.py`
- **로컬**에서 편집 → File Station으로 덮어쓰기

기존 `save_markdown` 도구 **아래에** 다음을 추가합니다. (기존 코드 스타일 그대로 `@mcp.tool`, `_safe_slug`, `NOTES_DIR` 재사용)

```python
# ── 추가: 확장자 화이트리스트 (보안: 임의 확장자/실행파일 차단) ──
ALLOWED_EXT = {"md", "html", "txt", "csv", "json"}

def _save_text(title: str, content: str, ext: str, subdir: str = "") -> str:
    ext = ext.lower().lstrip(".")
    if ext not in ALLOWED_EXT:
        raise ValueError(f"허용되지 않은 확장자: {ext}")
    ts = datetime.now().strftime("%Y%m%d_%H%M")
    target_dir = (NOTES_DIR / subdir) if subdir else NOTES_DIR
    target_dir.mkdir(parents=True, exist_ok=True)          # 하위 폴더 없으면 생성
    filename = f"{ts}_{_safe_slug(title)}.{ext}"
    path = target_dir / filename
    path.write_text(content, encoding="utf-8")             # UTF-8 고정(한글 안전)
    return f"저장 완료: {path.relative_to(NOTES_DIR)} ({len(content)}자)"

@mcp.tool
def save_html(title: str, content: str) -> str:
    """완성된 HTML 문서를 .html 파일로 NAS의 html/ 하위 폴더에 저장한다."""
    return _save_text(title, content, "html", subdir="html")
```

> **왜 `html/` 하위 폴더에?** `NOTES_DIR`는 Obsidian 볼트(`/volume1/notes`)입니다.
> 완결형 HTML을 노트와 같은 폴더에 두면 Obsidian 미리보기와 섞이므로 `notes/html/`로 분리하는 게 깔끔합니다.
> (완전히 다른 공유폴더에 두고 싶을 때만 `docker-compose.yml`에 볼륨을 하나 더 추가.)

### (선택·권장) 중복 제거 리팩터링

기존 `save_markdown`도 같은 헬퍼를 쓰도록 정리하면 유지보수가 쉬워집니다.

```python
@mcp.tool
def save_markdown(title: str, content: str) -> str:
    """대화 정리 내용을 마크다운(.md) 파일로 NAS 폴더에 저장한다."""
    return _save_text(title, content, "md")
```

> `datetime`, `NOTES_DIR`, `_safe_slug`는 이미 파일 상단에 정의돼 있으므로 **추가 import 불필요**.

---

## 3. [2단계] 컨테이너 재빌드 & 재시작 ⚠️ 가장 중요

Dockerfile이 코드를 이미지에 `COPY` 하므로, **단순 재시작이 아니라 재빌드**해야 새 코드가 반영됩니다.

**Container Manager → 프로젝트 → `nas-notes-mcp` 선택:**

1. **중지(Stop)**
2. **빌드(Build)** — 또는 작업 메뉴의 **"정리 후 빌드 / 다시 빌드"**
3. **시작(Start)**

> 코드를 바인드 마운트(볼륨으로 `server.py`를 직접 연결)하도록 구성했다면 재시작만으로도 반영됩니다.
> 하지만 기본 Dockerfile은 `COPY` 방식이라 **재빌드가 정답**입니다. 헷갈리면 그냥 재빌드하세요(항상 안전).

---

## 4. [3단계] 정상 기동 확인

컨테이너 **로그** 탭에서:

- `Uvicorn running on http://0.0.0.0:8000` (또는 유사) 정상 출력
- 에러 트레이스백 없음 (특히 `save_html` 관련 `SyntaxError`/`IndentationError` 없어야 함)

에러가 나면 **0단계 백업으로 롤백**하고 들여쓰기(파이썬은 공백 4칸)를 확인하세요.

---

## 5. [4단계] claude.ai 커넥터 도구 새로고침

서버가 도구 목록을 새로 내보내므로, 클라이언트가 그걸 다시 읽게 해야 합니다.

- claude.ai **설정 → 커넥터 → `NAS 노트`** → **도구 목록 새로고침** (또는 커넥터를 **껐다 켜기 / 재연결**)
- 새 대화를 열면 목록에 **`save_html`** 이 `save_markdown`과 함께 보이면 성공.

> OAuth 재로그인이 뜨면 Google 계정으로 다시 허용하면 됩니다.
> URL·인증서·프록시는 그대로라 재설정 불필요.

---

## 6. [5단계] 테스트

1. 프로젝트 대화에서 "이 HTML을 NAS에 저장해" 요청
2. Claude가 `save_html` 호출 → `저장 완료: html/20260724_xxxx_제목.html (…자)` 회신
3. File Station에서 `/volume1/notes/html/`에 `.html` 확인
4. 브라우저로 열면 페이지가 정상 렌더링

---

## 7. 문제 해결 (Troubleshooting)

| 증상 | 해결 |
| --- | --- |
| `save_html`이 도구 목록에 안 뜸 | 재빌드 안 하고 재시작만 했을 가능성 → **재빌드**. 이후 커넥터 **새로고침/재연결** |
| 컨테이너가 안 뜸(로그 에러) | `server.py` 들여쓰기·오타 확인, 안 되면 `server.py.bak`로 롤백 |
| 저장은 되는데 폴더에 없음 | `html/`은 `NOTES_DIR` 하위 → `/volume1/notes/html/` 확인. 컨테이너 쓰기 권한 확인 |
| 한글 파일명/내용 깨짐 | `encoding="utf-8"` 유지 확인 |
| 커넥터 "연결 실패" | (구성 변경 안 했으면 발생 드묾) 컨테이너 실행 상태·역방향 프록시 포트(8000) 확인 |

---

## 8. 보안 메모

- **확장자 화이트리스트 유지**: `ALLOWED_EXT`로 `.exe` 등 임의 확장자 생성을 차단합니다. 새 확장자가 필요할 때만 신중히 추가.
- **파일명 새니타이즈**: 기존 `_safe_slug()`가 경로 탈출/위험문자를 그대로 막아줍니다.
- **기밀 문서 금지**: 이 경로로 저장하면 내용이 커넥터를 거쳐 나갑니다. 감사·규정·사내 대화에는 사용 금지(개인 자료 전용) — [[MCP설정1]] 보안 체크리스트와 동일.

---

## 9. 요약 (한 장)

```
1. server.py 백업 (server.py.bak)
2. server.py 에 _save_text() + @mcp.tool save_html() 추가
3. Container Manager 에서 프로젝트 중지 → 재빌드 → 시작
4. 로그에서 정상 기동 확인
5. claude.ai 커넥터 도구 새로고침 (save_html 노출 확인)
6. "HTML을 NAS에 저장해" 로 테스트 → /volume1/notes/html/ 확인
```

*문서 생성: Claude Code · 관련: [[MCP설정1]] · 작성일 2026-07-24*
