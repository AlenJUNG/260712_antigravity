# Google Antigravity (AGY) 커스텀 상태 표시줄(statusLine) 설정 가이드

이 문서는 Antigravity CLI(`agy`)의 하단 상태 바에 **Context 사용량**, **Session 한도**, **Week 한도**를 미려한 게이지 바 형태로 모니터링할 수 있도록 연동하는 가이드입니다. 

다른 기기(맥북, 윈도우 등)에서 새로 설정할 때 이 문서를 따라 신속하게 설치하실 수 있습니다.

---

## 💻 상태 표시줄 렌더링 예시
```text
Context ▌░░░░░░░░░ 8%  ·  Session ██░░░░░░░░ 20% ↻10:30am  ·  Week ████░░░░░░ 41% ↻Jul 12 12pm (KST)
```

---

## 🛠️ 설치 및 연동 단계

### 1단계: Python 스크립트 작성 (`statusline.py`)
`agy`로부터 파이프라인(`stdin`)으로 들어오는 에이전트 실시간 상태 JSON 데이터를 파싱하여 하단 바 문구를 렌더링하는 스크립트입니다. 

각 운영체제별 설정 폴더에 스크립트 파일을 생성하고 아래 코드를 저장합니다.

*   **윈도우 저장 경로**: `C:\Users\<사용자명>\.gemini\antigravity-cli\statusline.py`
*   **맥/리눅스 저장 경로**: `~/.gemini/antigravity-cli/statusline.py`

#### 📄 `statusline.py` 소스 코드
```python
#!/usr/bin/env python3
import sys
import json
from datetime import datetime, timedelta, timezone

# Windows UTF-8 stdout 인코딩 꼬임 및 CP949 에러 방지
if sys.platform.startswith('win'):
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

RESET = '\033[0m'
BOLD = '\033[1m'
DIM = '\033[2m'
GREEN = '\033[32m'
YELLOW = '\033[33m'
RED = '\033[31m'
BAR_WIDTH = 10

def get_bar_color(pct):
    if pct >= 80: return RED
    if pct >= 50: return YELLOW
    return GREEN

def make_bar(pct):
    units = pct / (100 / BAR_WIDTH)
    full = int(units)
    half = '▌' if (units - full) >= 0.5 else ''
    visual = '█' * full + half
    empty = '░' * max(0, BAR_WIDTH - (full + (1 if half else 0)))
    return f"{get_bar_color(pct)}{visual}{DIM}{empty}{RESET}"

def format_reset(epoch, with_date=False):
    try:
        # UTC Epoch 초를 KST(UTC+9) 시간대로 조정
        kst_time = datetime.fromtimestamp(epoch, tz=timezone.utc) + timedelta(hours=9)
        ampm = "pm" if kst_time.hour >= 12 else "am"
        hr = 12 if kst_time.hour % 12 == 0 else kst_time.hour % 12
        time_str = f"{hr}{ampm}" if kst_time.minute == 0 else f"{hr}:{kst_time.minute:02d}{ampm}"
        return f"{kst_time.strftime('%b')} {kst_time.day} {time_str}" if with_date else time_str
    except Exception:
        return "N/A"

def make_part(label, win, with_date=False):
    if not win or 'used_percentage' not in win:
        return f"{BOLD}{label}{RESET} {DIM}대기중{RESET}"
    pct = win['used_percentage']
    s = f"{BOLD}{label}{RESET} {make_bar(pct)} {round(pct)}%"
    if 'resets_at' in win:
        s += f" {DIM}↻{format_reset(win['resets_at'], with_date)}{RESET}"
    return s

def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        sys.stdout.write(f"{DIM}사용량 정보 없음{RESET}")
        return

    # 1. Context Usage 파싱 및 구성
    tokens = data.get('tokens', {})
    if tokens and tokens.get('total', 0) > 0:
        used = tokens.get('used', 0)
        total = tokens['total']
        pct = (used / total) * 100
        context_win = {'used_percentage': pct}
    else:
        context_win = None

    # 2. Rate Limits (Session / Week) 파싱 및 구성
    rl = data.get('rate_limits')
    if not rl:
        if context_win:
            sys.stdout.write(f"{make_part('Context', context_win, False)}  {DIM}·{RESET}  {DIM}사용량 정보 대기 중{RESET}")
        else:
            sys.stdout.write(f"{DIM}사용량 정보 대기 중{RESET}")
        return

    # 3. 레이아웃 조립 출력
    line = (
        f"{make_part('Context', context_win, False)}  {DIM}·{RESET}  "
        f"{make_part('Session', rl.get('five_hour'), False)}  {DIM}·{RESET}  "
        f"{make_part('Week', rl.get('seven_day'), True)}  {DIM}(KST){RESET}"
    )
    sys.stdout.write(line)

if __name__ == '__main__':
    main()
```

---

### 2단계: 에이전트 환경 설정 (`settings.json`) 수정
Antigravity CLI가 위의 스크립트를 주기적으로 실행하여 하단에 상태바를 그릴 수 있게 설정 파일을 열어 연동 정보를 추가합니다.

*   **설정 파일 위치**:
    *   **윈도우**: `C:\Users\<사용자명>\.gemini\antigravity-cli\settings.json`
    *   **맥/리눅스**: `~/.gemini/antigravity-cli/settings.json`
*   **추가할 JSON 코드**:
    `settings.json` 파일의 루트 브라켓(`{ }`) 안에 아래와 같이 `"statusLine"` 설정을 추가합니다. (이미 해당 키가 존재한다면 내용을 덮어씁니다.)

```json
{
  "statusLine": {
    "type": "",
    "command": "python C:/Users/YOUR_USER_NAME/.gemini/antigravity-cli/statusline.py",
    "enabled": true
  }
}
```
*(맥북/리눅스 환경에서는 `"command"` 부분을 `"python3 ~/.gemini/antigravity-cli/statusline.py"`로 수정해 주시면 됩니다.)*

---

### 3단계: 로컬 실행 및 렌더링 검증 방법
설치 후 스크립트가 잘 작동하는지 쉘(터미널)에서 아래 모의 데이터를 전달하는 일회성 테스트 명령어를 실행해 볼 수 있습니다.

#### 윈도우 PowerShell 검증 명령어
```powershell
python -c "import subprocess; p = subprocess.Popen(['python', r'C:\Users\YOUR_USER_NAME\.gemini\antigravity-cli\statusline.py'], stdin=subprocess.PIPE, stdout=subprocess.PIPE); out, err = p.communicate(b'{\"tokens\":{\"used\":15000,\"total\":200000},\"rate_limits\":{\"five_hour\":{\"used_percentage\":20,\"resets_at\":1751592600},\"seven_day\":{\"used_percentage\":41,\"resets_at\":1751857200}}}'); print(out.decode('utf-8'))"
```

#### 맥북 / 리눅스 Bash 검증 명령어
```bash
echo '{"tokens":{"used":15000,"total":200000},"rate_limits":{"five_hour":{"used_percentage":20,"resets_at":1751592600},"seven_day":{"used_percentage":41,"resets_at":1751857200}}}' | python3 ~/.gemini/antigravity-cli/statusline.py
```

---

## 💡 유용한 팁
1.  **적용 및 리스타트**:
    설정 완료 후 실행 중인 `agy` CLI 창을 종료하고 새로 띄워 한 번이라도 에이전트와 질문/대답(API 통신)을 주고받으면 하단 상태바에 즉각 데이터가 로드됩니다.
2.  **화면 토글**:
    터미널 HUD 창 내에서 **`/statusline`** 명령어를 입력하면 커스텀 상태 바를 실시간으로 끄거나 켤 수 있습니다.
3.  **폰트 깨짐 대책**:
    상태 바가 네모난 상자(`ㅁ`)로 깨져 나오는 경우, 해당 터미널의 폰트 설정에서 CJK 가독성이 높은 **'D2Coding'**, **'Cascadia Code'**, 혹은 **'Nerd Font'** 계열 폰트로 변경해 주시면 이쁜 특수문자(`█`, `░`)가 깔끔하게 렌더링됩니다.
