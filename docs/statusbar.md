## 요약

**Python 기반 환경(ZSH, Tmux 등 범용 CLI 연동 가능) 표준**. VS Code Jupyter Notebook(`.ipynb`)에서 단계별로 복사하여 테스트할 수 있도록 셀 단위로 코드를 나누었으며, 마지막에 최종 병합 스크립트와 검증 방법을 배치했습니다.

---

## Python 기반 상태줄 재현 스크립트 (단계별 .ipynb 구성)

### 1단계: 모듈 임포트 및 상수 정의

```python
import sys
import json
from datetime import datetime, timedelta, timezone

# ANSI 색상 코드 정의
RESET = '\033[0m'
BOLD = '\033[1m'
DIM = '\033[2m'
GREEN = '\033[32m'
YELLOW = '\033[33m'
RED = '\033[31m'

BAR_WIDTH = 10  # 미니 바 폭 (1칸 = 10%)

```

### 2단계: 색상 및 프로그레스 바 생성 함수

```python
def get_bar_color(pct):
    if pct >= 80:
        return RED
    if pct >= 50:
        return YELLOW
    return GREEN

def make_bar(pct):
    units = pct / (100 / BAR_WIDTH)
    full = int(units)
    half = '▌' if (units - full) >= 0.5 else ''
    visual = '█' * full + half

    # 빈 칸 계산 (절반 칸이 있으면 1칸을 차지하는 것으로 처리)
    has_half = 1 if half else 0
    empty_count = max(0, BAR_WIDTH - (full + has_half))
    empty = '░' * empty_count

    return f"{get_bar_color(pct)}{visual}{DIM}{empty}{RESET}"

```

### 3단계: KST 기준 시간 포맷팅 함수

```python
def format_reset(epoch, with_date=False):
    # Epoch 초를 UTC 기준으로 읽은 뒤 KST(UTC+9)로 변환
    kst_time = datetime.fromtimestamp(epoch, tz=timezone.utc) + timedelta(hours=9)

    ampm = "pm" if kst_time.hour >= 12 else "am"
    hr = kst_time.hour % 12
    hr = 12 if hr == 0 else hr

    if kst_time.minute == 0:
        time_str = f"{hr}{ampm}"
    else:
        time_str = f"{hr}:{kst_time.minute:02d}{ampm}"

    if with_date:
        month_str = kst_time.strftime('%b')  # Jan, Feb, Mar...
        return f"{month_str} {kst_time.day} {time_str}"
    return time_str

```

### 4단계: 컴팩트 한 줄 레이아웃 조립 함수

```python
def make_part(label, win, with_date=False):
    if not win or 'used_percentage' not in win:
        return f"{BOLD}{label}{RESET} {DIM}대기중{RESET}"

    pct = win['used_percentage']
    s = f"{BOLD}{label}{RESET} {make_bar(pct)} {round(pct)}%"

    if 'resets_at' in win and isinstance(win['resets_at'], (int, float)):
        s += f" {DIM}↻{format_reset(win['resets_at'], with_date)}{RESET}"
    return s

```

### 5단계: 모의 데이터(Mock) 검증 및 출력 테스트

```python
# 가상의 Claude 상태 JSON 데이터
mock_input = '{"rate_limits":{"five_hour":{"used_percentage":20,"resets_at":1751592600},"seven_day":{"used_percentage":41,"resets_at":1751857200}}}'

def render_status_line(json_str):
    try:
        data = json.loads(json_str) if json_str.strip() else {}
    except json.JSONDecodeError:
        return f"{DIM}사용량 정보 없음{RESET}"

    rl = data.get('rate_limits')
    if not rl:
        return f"{DIM}사용량 정보 대기 중 (첫 API 응답 후 표시){RESET}"

    line = (
        make_part('Session', rl.get('five_hour'), False) +
        f"  {DIM}·{RESET}  " +
        make_part('Week', rl.get('seven_day'), True) +
        f"  {DIM}(KST){RESET}"
    )
    return line

print(render_status_line(mock_input))

```

---

## 최종 파일 합치기 및 실행 (CLI 표준 연동형)

위의 검증된 로직을 로컬 환경 내부나 터미널 파이프라인(`stdin`)에서 직접 호출할 수 있도록 하나로 묶은 파이썬 파일용 코드입니다.

### 1. 스크립트 파일 저장 (`~/.claude/statusline.py`)

```python
#!/usr/bin/env python3
import sys
import json
from datetime import datetime, timedelta, timezone

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
    kst_time = datetime.fromtimestamp(epoch, tz=timezone.utc) + timedelta(hours=9)
    ampm = "pm" if kst_time.hour >= 12 else "am"
    hr = 12 if kst_time.hour % 12 == 0 else kst_time.hour % 12
    time_str = f"{hr}{ampm}" if kst_time.minute == 0 else f"{hr}:{kst_time.minute:02d}{ampm}"
    return f"{kst_time.strftime('%b')} {kst_time.day} {time_str}" if with_date else time_str

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

    rl = data.get('rate_limits')
    if not rl:
        sys.stdout.write(f"{DIM}사용량 정보 대기 중 (첫 API 응답 후 표시){RESET}")
        return

    line = f"{make_part('Session', rl.get('five_hour'), False)}  {DIM}·{RESET}  {make_part('Week', rl.get('seven_day'), True)}  {DIM}(KST){RESET}"
    sys.stdout.write(line)

if __name__ == '__main__':
    main()

```

### 2. 터미널 연동 테스트 및 확인 방법

```bash
echo '{"rate_limits":{"five_hour":{"used_percentage":20,"resets_at":1751592600},"seven_day":{"used_percentage":41,"resets_at":1751857200}}}' | python3 ~/.claude/statusline.py

```
