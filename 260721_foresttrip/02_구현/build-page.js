// rooms-region.json → 자체완결 HTML 대시보드(artifacts/page.html) 생성
// 원격에서 링크로 열어보는 결과 페이지. (Artifact 로 발행)

import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync("artifacts/rooms-region.json", "utf8"));
const stamp = new Date();
const pad = (n) => String(n).padStart(2, "0");
const stampStr = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;

const meta = {
  title: "전국 자연휴양림 예약·대기 현황",
  date: "2026-08-01 (토) · 1박 · 2인",
  stamp: stampStr,
  total: data.length,
  reserve: data.filter((r) => r.예약가능여부 === "예약가능").length,
  wait: data.filter((r) => r.예약가능여부 === "대기가능").length,
  forests: new Set(data.map((r) => r.휴양림)).size,
};

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${meta.title}</title>
<style>
:root {
  --bg: #F5F7F4;
  --surface: #FFFFFF;
  --surface-2: #EEF2EC;
  --border: #DDE4DA;
  --border-light: rgba(18, 78, 55, 0.08);
  --text: #111814;
  --dim: #5C6760;
  --pine: #124E37;
  --pine-hover: #0D3A29;
  --pine-light: #E8F3EE;
  --emerald: #059669;
  --emerald-bg: #D1FAE5;
  --amber: #D97706;
  --amber-bg: #FEF3C7;
  --natl: #065F46;
  --pub: #1E40AF;
  --priv: #92400E;
  --card-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.04), 0 4px 6px -2px rgba(0, 0, 0, 0.02);
  --card-shadow-hover: 0 16px 32px -6px rgba(18, 78, 55, 0.1), 0 6px 12px -3px rgba(0, 0, 0, 0.04);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0F1715;
    --surface: #182420;
    --surface-2: #21302B;
    --border: #2D3E38;
    --border-light: rgba(255, 255, 255, 0.08);
    --text: #F0F4F2;
    --dim: #94A39B;
    --pine: #34A871;
    --pine-hover: #45C085;
    --pine-light: #1A342B;
    --emerald: #10B981;
    --emerald-bg: #064E3B;
    --amber: #F59E0B;
    --amber-bg: #451A03;
    --natl: #6EE7B7;
    --pub: #93C5FD;
    --priv: #FDE68A;
    --card-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
    --card-shadow-hover: 0 16px 32px -6px rgba(0, 0, 0, 0.5);
  }
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, Roboto, sans-serif;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: tabular-nums;
}

.wrap {
  max-width: 1120px;
  margin: 0 auto;
  padding: 32px 20px 100px;
}

header {
  margin-bottom: 24px;
}
header h1 {
  font-size: clamp(24px, 4vw, 34px);
  font-weight: 800;
  letter-spacing: -0.03em;
  margin: 0 0 8px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 12px;
}
header h1 .brand-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: var(--pine);
  color: #FFF;
  border-radius: 12px;
  font-size: 20px;
}
.sub {
  color: var(--dim);
  font-size: 14px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
  font-weight: 500;
}
.sub .dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--dim);
  opacity: 0.5;
}
.sub-badge {
  background: var(--pine-light);
  color: var(--pine);
  font-weight: 700;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
}

/* 통계 카드 릴레이 */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
  margin: 24px 0 28px;
}
.tile {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 18px 20px;
  box-shadow: var(--card-shadow);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.tile:hover {
  transform: translateY(-2px);
  box-shadow: var(--card-shadow-hover);
}
.tile .n {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
}
.tile .l {
  font-size: 13px;
  color: var(--dim);
  margin-top: 6px;
  font-weight: 600;
}
.tile.a { border-top: 4px solid var(--emerald); }
.tile.a .n { color: var(--emerald); }
.tile.w { border-top: 4px solid var(--amber); }
.tile.w .n { color: var(--amber); }

/* 스티키 헤더 바 & 컨트롤 */
.controls-wrapper {
  position: sticky;
  top: 0;
  z-index: 10;
  background: color-mix(in srgb, var(--bg) 85%, transparent);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  padding: 14px 0;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.controls {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}
select, input[type=search] {
  font: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 9px 14px;
  outline: none;
  font-size: 14px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
select:focus, input[type=search]:focus {
  border-color: var(--pine);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--pine) 20%, transparent);
}
input[type=search] {
  flex: 1;
  min-width: 200px;
}

.seg {
  display: inline-flex;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 3px;
}
.seg button {
  font: inherit;
  color: var(--dim);
  background: none;
  border: 0;
  padding: 7px 14px;
  border-radius: 9px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s ease;
}
.seg button[aria-pressed=true] {
  background: var(--surface);
  color: var(--pine);
  font-weight: 800;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.count-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 16px 4px 12px;
  font-size: 13.5px;
  color: var(--dim);
  font-weight: 600;
}

/* 카드 목록 디자인 */
.sido-group {
  margin-top: 32px;
}
.sido-h {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.05em;
  color: var(--pine);
  text-transform: uppercase;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--border);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 20px 22px;
  margin-bottom: 14px;
  box-shadow: var(--card-shadow);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
.card:hover {
  transform: translateY(-2px);
  box-shadow: var(--card-shadow-hover);
}
.card-h {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.fname {
  font-weight: 800;
  font-size: 17px;
  letter-spacing: -0.02em;
}
.badge {
  font-size: 11.5px;
  font-weight: 700;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
}
.b-natl { color: var(--natl); background: color-mix(in srgb, var(--natl) 14%, transparent); border-color: color-mix(in srgb, var(--natl) 25%, transparent); }
.b-pub { color: var(--pub); background: color-mix(in srgb, var(--pub) 14%, transparent); border-color: color-mix(in srgb, var(--pub) 25%, transparent); }
.b-priv { color: var(--priv); background: color-mix(in srgb, var(--priv) 14%, transparent); border-color: color-mix(in srgb, var(--priv) 25%, transparent); }
.meta {
  color: var(--dim);
  font-size: 13px;
  margin-left: auto;
  font-weight: 500;
}
.new {
  color: #FFF;
  background: linear-gradient(135deg, #D97706, #F59E0B);
  font-size: 10.5px;
  font-weight: 800;
  padding: 2px 8px;
  border-radius: 999px;
  letter-spacing: 0.02em;
}

/* 핸드오프 원탭 연결 버튼 */
.handoff-btn {
  font-size: 12px;
  font-weight: 700;
  color: var(--pine);
  background: var(--pine-light);
  border: 1px solid color-mix(in srgb, var(--pine) 20%, transparent);
  border-radius: 8px;
  padding: 4px 10px;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
}
.handoff-btn:hover {
  background: var(--pine);
  color: #FFF;
}

.rooms {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.room {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 14px;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--surface-2);
  transition: background 0.15s ease;
}
.room:hover {
  background: color-mix(in srgb, var(--surface-2) 70%, var(--pine-light));
}
.rtype {
  color: var(--dim);
  font-weight: 700;
  min-width: 72px;
  font-size: 12.5px;
}
.rdetail {
  flex: 1;
  min-width: 0;
  font-weight: 600;
}
.chip {
  font-size: 12px;
  font-weight: 800;
  padding: 3px 12px;
  border-radius: 999px;
  white-space: nowrap;
  letter-spacing: -0.01em;
}
.chip.r { color: var(--emerald); background: var(--emerald-bg); }
.chip.w { color: var(--amber); background: var(--amber-bg); }

.empty {
  text-align: center;
  color: var(--dim);
  padding: 80px 0;
  font-size: 15px;
  font-weight: 600;
}

footer {
  margin-top: 50px;
  padding-top: 24px;
  border-top: 1px solid var(--border);
  color: var(--dim);
  font-size: 13px;
  text-align: center;
  line-height: 1.8;
}
</style>
</head>
<body>

<div class="wrap">
<header>
  <h1>
    <span class="brand-icon">🌲</span>
    ${meta.title}
  </h1>
  <div class="sub">
    <span class="sub-badge">${meta.date}</span>
    <span>기준시각 ${meta.stamp}</span>
    <span class="dot"></span>
    <span>숲나들e 실시간 모니터링</span>
  </div>
</header>

<div class="tiles">
  <div class="tile"><div class="n" id="t-forest">${meta.forests}</div><div class="l">휴양림 수</div></div>
  <div class="tile"><div class="n" id="t-total">${meta.total}</div><div class="l">모니터링 객실</div></div>
  <div class="tile a"><div class="n" id="t-res">${meta.reserve}</div><div class="l">예약가능 (즉시)</div></div>
  <div class="tile w"><div class="n" id="t-wait">${meta.wait}</div><div class="l">대기가능</div></div>
</div>

<div class="controls-wrapper">
  <div class="controls">
    <select id="f-sido"><option value="">전체 시/도</option></select>
    <select id="f-fac"><option value="">전체 시설유형</option></select>
    <div class="seg" role="group" aria-label="상태 필터">
      <button data-st="" aria-pressed="true">전체 보기</button>
      <button data-st="예약가능" aria-pressed="false">예약 가능</button>
      <button data-st="대기가능" aria-pressed="false">대기 가능</button>
    </div>
    <input type="search" id="f-q" placeholder="휴양림 또는 객실 검색...">
  </div>
</div>

<div class="count-bar">
  <span id="count">조회 결과를 불러오는 중...</span>
  <span>💡 객실 클릭 시 복사 및 핸드오프 가이드 제공</span>
</div>

<div id="list"></div>

<footer>
  📌 <b>안내:</b> 8월 1일은 토요일(추첨일)로 성수기 예약/대기 변동이 활발합니다.<br>
  본 대시보드는 숲나들e 데이터 수집 기반 참고용 현황이며, <b>원탭 숲나들e 바로가기</b>를 통해 공식 사이트에서 예약 확정하세요.
</footer>
</div>

<script>
const DATA = ${JSON.stringify(data)};
const $ = s => document.querySelector(s);
const TYPEB = { 국립: "b-natl", 공립: "b-pub", 사립: "b-priv" };
let st = "";

const sidos = [...new Set(DATA.map(r => r.시도))].filter(Boolean);
const facs = [...new Set(DATA.map(r => r.숙박시설).filter(Boolean))].sort();

for (const s of sidos) { const o = document.createElement("option"); o.value = o.textContent = s; $("#f-sido").append(o); }
for (const f of facs) { const o = document.createElement("option"); o.value = o.textContent = f; $("#f-fac").append(o); }

function typeOf(name) { const m = name.match(/^\\[(국립|공립|사립)\\]/); return m ? m[1] : ""; }

function copySearchGuide(fname, roomName) {
  const text = \`[숲나들e 검색 정보]\\n휴양림: \${fname}\\n객실: \${roomName}\\n일정: 2026-08-01 (1박)\`;
  navigator.clipboard.writeText(text).then(() => {
    alert(\`검색 정보가 복사되었습니다!\\n숲나들e 공식 예약 페이지에서 검색하세요.\\n\\n\${text}\`);
  }).catch(() => {
    alert(\`휴양림: \${fname}\\n객실: \${roomName}\`);
  });
}

function render() {
  const sido = $("#f-sido").value, fac = $("#f-fac").value, q = $("#f-q").value.trim();
  const rows = DATA.filter(r =>
    (!sido || r.시도 === sido) && (!fac || r.숙박시설 === fac) && (!st || r.예약가능여부 === st) &&
    (!q || r.휴양림.includes(q) || (r.시설상세 || "").includes(q))
  );
  
  $("#count").textContent = \`총 \${rows.length}개 객실 탐색됨\`;
  
  const bySido = {};
  for (const r of rows) {
    (bySido[r.시도] = bySido[r.시도] || {});
    const g = bySido[r.시도];
    (g[r.휴양림] = g[r.휴양림] || { meta: r, rooms: [] }).rooms.push(r);
  }
  
  const list = $("#list");
  list.innerHTML = "";
  
  if (!rows.length) {
    list.innerHTML = '<div class="empty">선택하신 조건에 일치하는 휴양림·객실이 없습니다.</div>';
    return;
  }
  
  for (const s of sidos) {
    if (!bySido[s]) continue;
    const grp = document.createElement("section");
    grp.className = "sido-group";
    grp.innerHTML = \`<div class="sido-h">📍 \${s}</div>\`;
    
    for (const [fname, info] of Object.entries(bySido[s])) {
      const t = typeOf(fname), clean = fname.replace(/^\\[[^\\]]+\\]/, "");
      const m = info.meta;
      const card = document.createElement("div");
      card.className = "card";
      
      let h = '<div class="card-h">';
      if (t) h += \`<span class="badge \${TYPEB[t]}">\${t}</span>\`;
      h += \`<span class="fname">\${clean}</span>\`;
      if (m.신축 === "O") h += '<span class="new">✨ 신축</span>';
      h += \`<span class="meta">개관 \${m.개관연도}년</span>\`;
      
      // 원탭 핸드오프 딥링크 버튼
      const targetUrl = "https://www.foresttrip.go.kr/rep/or/fcfsRsrvtMain.do?hmpgId=FRIP&menuId=001001";
      h += \`<a href="\${targetUrl}" target="_blank" class="handoff-btn" title="숲나들e 예약 페이지로 이동">🚀 숲나들e 이동</a>\`;
      h += '</div>';
      
      h += '<div class="rooms">';
      for (const r of info.rooms) {
        const c = r.예약가능여부 === "예약가능" ? "r" : "w";
        const label = r.예약가능여부 === "예약가능" ? "예약가능" : ("대기 " + (r.대기순위 ? r.대기순위 + "순위" : "가능"));
        const detail = (r.시설상세 || "").replace(/^\\[[^\\]]+\\]/, "");
        h += \`<div class="room" onclick="copySearchGuide('\${clean}', '\${detail}')" style="cursor:pointer" title="클릭 시 검색 정보 복사">
          <span class="rtype">\${r.숙박시설 || "객실"}</span>
          <span class="rdetail">\${detail}</span>
          <span class="chip \${c}">\${label}</span>
        </div>\`;
      }
      h += '</div>';
      
      card.innerHTML = h;
      grp.append(card);
    }
    list.append(grp);
  }
}

$("#f-sido").onchange = render;
$("#f-fac").onchange = render;
$("#f-q").oninput = render;

document.querySelectorAll(".seg button").forEach(b => {
  b.onclick = () => {
    st = b.dataset.st;
    document.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", x === b));
    render();
  };
});

render();
</script>
</body>
</html>`;

writeFileSync("artifacts/page.html", html, "utf8");
console.log(`page.html 프레미엄 UI 갱신 완료: ${meta.total}건 / ${meta.forests}곳 / 예약 ${meta.reserve} 대기 ${meta.wait}`);
