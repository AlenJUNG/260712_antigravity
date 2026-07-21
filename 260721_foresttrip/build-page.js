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

const html = `<style>
:root{
  --bg:#f4f7f1; --surface:#ffffff; --surface-2:#ecefe6; --border:#dde3d5;
  --text:#1b2219; --dim:#5c6455; --pine:#1f5c3d;
  --avail:#2f8f4e; --avail-bg:#e6f3ea; --wait:#a86f14; --wait-bg:#f6eede;
  --natl:#25563a; --pub:#3a5a8c; --priv:#8a5a2b;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#111510; --surface:#191e15; --surface-2:#222820; --border:#333a2c;
    --text:#e8ece0; --dim:#9ba48f; --pine:#6cbb89;
    --avail:#5ec27e; --avail-bg:#16281c; --wait:#e0aa4c; --wait-bg:#2a2213;
    --natl:#7fc49b; --pub:#8fb2e6; --priv:#d6a56e;
  }
}
:root[data-theme="light"]{
  --bg:#f4f7f1; --surface:#ffffff; --surface-2:#ecefe6; --border:#dde3d5;
  --text:#1b2219; --dim:#5c6455; --pine:#1f5c3d;
  --avail:#2f8f4e; --avail-bg:#e6f3ea; --wait:#a86f14; --wait-bg:#f6eede;
  --natl:#25563a; --pub:#3a5a8c; --priv:#8a5a2b;
}
:root[data-theme="dark"]{
  --bg:#111510; --surface:#191e15; --surface-2:#222820; --border:#333a2c;
  --text:#e8ece0; --dim:#9ba48f; --pine:#6cbb89;
  --avail:#5ec27e; --avail-bg:#16281c; --wait:#e0aa4c; --wait-bg:#2a2213;
  --natl:#7fc49b; --pub:#8fb2e6; --priv:#d6a56e;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font-family:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Malgun Gothic",system-ui,-apple-system,sans-serif;
  line-height:1.5;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
header h1{font-size:clamp(22px,3.4vw,30px);font-weight:800;letter-spacing:-.02em;margin:0 0 6px;text-wrap:balance}
.sub{color:var(--dim);font-size:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.sub .dot{width:4px;height:4px;border-radius:50%;background:var(--dim);opacity:.5}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:22px 0}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px}
.tile .n{font-size:26px;font-weight:800;letter-spacing:-.02em}
.tile .l{font-size:12px;color:var(--dim);margin-top:2px}
.tile.a .n{color:var(--avail)} .tile.w .n{color:var(--wait)}
.controls{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);
  backdrop-filter:blur(8px);padding:12px 0;margin-bottom:6px;border-bottom:1px solid var(--border);
  display:flex;gap:8px;flex-wrap:wrap;align-items:center}
select,input[type=search]{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--border);
  border-radius:9px;padding:8px 11px;outline:none}
input[type=search]{flex:1;min-width:150px}
select:focus-visible,input:focus-visible,button:focus-visible{outline:2px solid var(--pine);outline-offset:1px}
.seg{display:inline-flex;background:var(--surface-2);border:1px solid var(--border);border-radius:9px;overflow:hidden}
.seg button{font:inherit;color:var(--dim);background:none;border:0;padding:8px 12px;cursor:pointer}
.seg button[aria-pressed=true]{background:var(--surface);color:var(--text);font-weight:700;box-shadow:inset 0 0 0 1px var(--border)}
.count{color:var(--dim);font-size:13px;margin:14px 2px 6px}
.sido-group{margin-top:24px}
.sido-h{font-size:13px;font-weight:800;letter-spacing:.04em;color:var(--pine);text-transform:uppercase;
  padding-bottom:6px;border-bottom:2px solid var(--border);margin-bottom:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px 16px;margin-bottom:10px}
.card-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin-bottom:10px}
.fname{font-weight:700;font-size:15.5px}
.badge{font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;border:1px solid transparent}
.b-natl{color:var(--natl);background:color-mix(in srgb,var(--natl) 14%,transparent)}
.b-pub{color:var(--pub);background:color-mix(in srgb,var(--pub) 14%,transparent)}
.b-priv{color:var(--priv);background:color-mix(in srgb,var(--priv) 14%,transparent)}
.meta{color:var(--dim);font-size:12.5px;margin-left:auto}
.new{color:#fff;background:var(--wait);font-size:10px;font-weight:800;padding:1px 6px;border-radius:999px}
.rooms{display:flex;flex-direction:column;gap:5px}
.room{display:flex;gap:10px;align-items:center;font-size:13.5px;padding:5px 0;border-top:1px dashed var(--border)}
.room:first-child{border-top:0}
.rtype{color:var(--dim);min-width:64px;font-size:12px}
.rdetail{flex:1;min-width:0}
.chip{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;white-space:nowrap}
.chip.r{color:var(--avail);background:var(--avail-bg)}
.chip.w{color:var(--wait);background:var(--wait-bg)}
.empty{text-align:center;color:var(--dim);padding:60px 0}
footer{margin-top:40px;color:var(--dim);font-size:12px;text-align:center;line-height:1.7}
</style>

<div class="wrap">
<header>
  <h1>${meta.title}</h1>
  <div class="sub">
    <span>${meta.date}</span><span class="dot"></span>
    <span>기준 ${meta.stamp}</span><span class="dot"></span>
    <span>숲나들e 실측</span>
  </div>
</header>

<div class="tiles">
  <div class="tile"><div class="n" id="t-forest">${meta.forests}</div><div class="l">휴양림</div></div>
  <div class="tile"><div class="n" id="t-total">${meta.total}</div><div class="l">시설(방)</div></div>
  <div class="tile a"><div class="n" id="t-res">${meta.reserve}</div><div class="l">예약가능</div></div>
  <div class="tile w"><div class="n" id="t-wait">${meta.wait}</div><div class="l">대기가능</div></div>
</div>

<div class="controls">
  <select id="f-sido"><option value="">전체 시/도</option></select>
  <select id="f-fac"><option value="">전체 숙박시설</option></select>
  <div class="seg" role="group" aria-label="상태">
    <button data-st="" aria-pressed="true">전체</button>
    <button data-st="예약가능" aria-pressed="false">예약</button>
    <button data-st="대기가능" aria-pressed="false">대기</button>
  </div>
  <input type="search" id="f-q" placeholder="휴양림·시설 검색">
</div>
<div class="count" id="count"></div>
<div id="list"></div>

<footer>
  8/1은 토요일(추첨일)이라 숙박은 대부분 <b>대기</b>, 캠핑·야영데크는 <b>예약</b>이 많습니다.<br>
  비공식 조회 결과이며 실제 예약 가능 여부는 숲나들e에서 최종 확인하세요.
</footer>
</div>

<script>
const DATA=${JSON.stringify(data)};
const $=s=>document.querySelector(s);
const TYPEB={국립:"b-natl",공립:"b-pub",사립:"b-priv"};
let st="";
// 필터 옵션 채우기
const sidos=[...new Set(DATA.map(r=>r.시도))];
const facs=[...new Set(DATA.map(r=>r.숙박시설).filter(Boolean))].sort();
for(const s of sidos){const o=document.createElement("option");o.value=o.textContent=s;$("#f-sido").append(o);}
for(const f of facs){const o=document.createElement("option");o.value=o.textContent=f;$("#f-fac").append(o);}

function typeOf(name){const m=name.match(/^\\[(국립|공립|사립)\\]/);return m?m[1]:"";}
function render(){
  const sido=$("#f-sido").value, fac=$("#f-fac").value, q=$("#f-q").value.trim();
  const rows=DATA.filter(r=>
    (!sido||r.시도===sido)&&(!fac||r.숙박시설===fac)&&(!st||r.예약가능여부===st)&&
    (!q||r.휴양림.includes(q)||(r.시설상세||"").includes(q)));
  $("#count").textContent=rows.length+"건 표시";
  // 시도 → 휴양림 그룹핑
  const bySido={};
  for(const r of rows){(bySido[r.시도]=bySido[r.시도]||{}); const g=bySido[r.시도];
    (g[r.휴양림]=g[r.휴양림]||{meta:r,rooms:[]}).rooms.push(r);}
  const list=$("#list");list.innerHTML="";
  if(!rows.length){list.innerHTML='<div class="empty">조건에 맞는 결과가 없습니다.</div>';return;}
  for(const s of sidos){ if(!bySido[s])continue;
    const grp=document.createElement("section");grp.className="sido-group";
    grp.innerHTML='<div class="sido-h">'+s+'</div>';
    for(const [fname,info] of Object.entries(bySido[s])){
      const t=typeOf(fname), clean=fname.replace(/^\\[[^\\]]+\\]/,"");
      const m=info.meta;
      const card=document.createElement("div");card.className="card";
      let h='<div class="card-h">';
      if(t)h+='<span class="badge '+TYPEB[t]+'">'+t+'</span>';
      h+='<span class="fname">'+clean+'</span>';
      if(m.신축==="O")h+='<span class="new">신축</span>';
      h+='<span class="meta">개관 '+m.개관연도+'</span></div>';
      h+='<div class="rooms">';
      for(const r of info.rooms){
        const c=r.예약가능여부==="예약가능"?"r":"w";
        const label=r.예약가능여부==="예약가능"?"예약":("대기"+(r.대기순위?" "+r.대기순위:""));
        const detail=(r.시설상세||"").replace(/^\\[[^\\]]+\\]/,"");
        h+='<div class="room"><span class="rtype">'+(r.숙박시설||"")+'</span>'
          +'<span class="rdetail">'+detail+'</span>'
          +'<span class="chip '+c+'">'+label+'</span></div>';
      }
      h+='</div>';card.innerHTML=h;grp.append(card);
    }
    list.append(grp);
  }
}
$("#f-sido").onchange=render;$("#f-fac").onchange=render;$("#f-q").oninput=render;
document.querySelectorAll(".seg button").forEach(b=>b.onclick=()=>{
  st=b.dataset.st;document.querySelectorAll(".seg button").forEach(x=>x.setAttribute("aria-pressed",x===b));render();});
render();
</script>`;

writeFileSync("artifacts/page.html", html, "utf8");
console.log(`page.html 생성: ${meta.total}건 / ${meta.forests}곳 / 예약 ${meta.reserve} 대기 ${meta.wait}`);
