// ── STATE ─────────────────────────────────────────────────────────────────────
let currentRole = 'viewer';
let currentUser = null;
let HOUR_PROD = 1224;
let TARGET = 0.93;
let inflowData = {}, enqueueData = {};
let weekData = [], manualShift = {};
let weekChart = null, shiftChart = null;

// ── INIT ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Gắn sự kiện chuyển hướng trực tiếp cho nút Sign in và Sign out
  const loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.onclick = () => { window.location.href = '/auth/google'; };
  }
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.onclick = () => { window.location.href = '/auth/logout'; };
  }

  await fetchMe();
  await loadSharedConfig();
  updateDerived();
});

async function fetchMe() {
  try {
    const res = await fetch('/api/me');
    
    // Nếu Server trả về lỗi (như 404, 500), dừng lại luôn chứ không ép kiểu JSON để tránh sập code
    if (!res.ok) {
      console.warn("Auth API returned status:", res.status);
      applyRole(); // Vẫn gọi hàm này để kích hoạt giao diện mặc định (viewer)
      return;
    }
    
    const { user, role } = await res.json();
    currentRole = role; 
    currentUser = user;
    applyRole();
  } catch (err) {
    console.error("Failed to fetch auth state, breaking avoided:", err);
    applyRole(); // Có lỗi mạng vẫn chạy tiếp giao diện viewer chứ không khóa cứng app
  }
}

// ── PARAMS ────────────────────────────────────────────────────────────────────
function updateDerived() {
  const aht = parseFloat(document.getElementById('ahtInput').value) || 2.5;
  const util = parseFloat(document.getElementById('utilInput').value) || 85;
  HOUR_PROD = Math.round(3600 * (util / 100) / aht);
  document.getElementById('hpDisplay').textContent = HOUR_PROD.toLocaleString();
  document.getElementById('dpDisplay').textContent = (HOUR_PROD * 8).toLocaleString();
}

// ── CONFIG SAVE / LOAD ────────────────────────────────────────────────────────
async function saveConfig() {
  const config = {
    aht: document.getElementById('ahtInput').value,
    util: document.getElementById('utilInput').value,
    target: document.getElementById('targetCov').value,
    inflowData, enqueueData
  };
  await fetch('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  const btn = document.getElementById('saveBtn');
  btn.textContent = '✓ Saved'; setTimeout(() => btn.textContent = '💾 Save', 2000);
}

async function loadSharedConfig() {
  const res = await fetch('/api/config');
  const { config } = await res.json();
  if (!config) return;
  if (config.aht) document.getElementById('ahtInput').value = config.aht;
  if (config.util) document.getElementById('utilInput').value = config.util;
  if (config.target) document.getElementById('targetCov').value = config.target;
  if (config.inflowData) inflowData = config.inflowData;
  if (config.enqueueData) enqueueData = config.enqueueData;
  updateDerived();
  if (Object.keys(inflowData).length) {
    setStatus('inflow', `✅ Loaded ${Object.keys(inflowData).length} days from saved config`, 'ok');
    calcWeek();
  }
}

// ── ADMIN ─────────────────────────────────────────────────────────────────────
function openAdmin() {
  document.getElementById('adminModal').classList.remove('hidden');
  loadEditors();
}
function closeAdmin() { document.getElementById('adminModal').classList.add('hidden'); }

async function loadEditors() {
  const res = await fetch('/api/users');
  const { editors } = await res.json();
  const list = document.getElementById('editorList');
  if (!editors.length) { list.innerHTML = '<div style="font-size:12px;color:var(--text3)">No editors added yet.</div>'; return; }
  list.innerHTML = editors.map(e => `
    <div class="editor-row">
      <span class="editor-email">${e}</span>
      <button class="editor-remove" onclick="removeEditor('${e}')" title="Remove">✕</button>
    </div>`).join('');
}

async function addEditor() {
  const email = document.getElementById('newEditorEmail').value.trim();
  if (!email) return;
  await fetch('/api/users/editors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
  document.getElementById('newEditorEmail').value = '';
  loadEditors();
}

async function removeEditor(email) {
  await fetch(`/api/users/editors/${encodeURIComponent(email)}`, { method: 'DELETE' });
  loadEditors();
}

// ── FILE UPLOAD ───────────────────────────────────────────────────────────────
const ENQUEUE_DEFAULT = {
  Normal:[0.034,0.029,0.026,0.026,0.025,0.025,0.025,0.029,0.039,0.054,0.060,0.059,0.052,0.051,0.053,0.053,0.048,0.040,0.039,0.045,0.052,0.052,0.044,0.039],
  Spike:[0.054,0.035,0.029,0.027,0.025,0.026,0.028,0.030,0.039,0.051,0.056,0.056,0.050,0.047,0.048,0.051,0.047,0.040,0.039,0.043,0.049,0.050,0.044,0.038],
  'Spike-1':[0.033,0.029,0.026,0.025,0.025,0.025,0.025,0.029,0.037,0.050,0.055,0.054,0.050,0.049,0.052,0.052,0.047,0.041,0.041,0.046,0.051,0.053,0.051,0.054],
  '14th':[0.0343,0.0303,0.0265,0.0267,0.027,0.0258,0.0269,0.0298,0.0373,0.0513,0.0558,0.0553,0.0505,0.049,0.0517,0.05,0.0451,0.0395,0.0399,0.0468,0.0519,0.0522,0.0473,0.0491],
  '15th':[0.046,0.032,0.027,0.025,0.024,0.025,0.026,0.029,0.038,0.052,0.058,0.057,0.051,0.050,0.053,0.056,0.050,0.040,0.039,0.044,0.050,0.050,0.042,0.037],
  '24th':[0.0324,0.0287,0.0247,0.0235,0.023,0.0226,0.023,0.0268,0.0369,0.0531,0.0602,0.058,0.0502,0.0498,0.0524,0.0516,0.0477,0.0402,0.0407,0.0459,0.0531,0.0554,0.0491,0.051],
  '25th':[0.044,0.032,0.028,0.025,0.025,0.025,0.027,0.030,0.038,0.052,0.060,0.059,0.052,0.050,0.052,0.053,0.048,0.039,0.039,0.044,0.049,0.050,0.042,0.037],
  Sat:[0.036,0.032,0.028,0.027,0.027,0.026,0.027,0.030,0.039,0.051,0.059,0.058,0.052,0.050,0.051,0.049,0.046,0.040,0.040,0.046,0.050,0.051,0.044,0.039],
  Sun:[0.038,0.033,0.030,0.029,0.028,0.028,0.029,0.032,0.037,0.046,0.051,0.054,0.052,0.050,0.047,0.046,0.044,0.040,0.041,0.047,0.053,0.054,0.047,0.043]
};

function dragOver(e, id) { e.preventDefault(); document.getElementById(id).classList.add('drag'); }
function dragLeave(id) { document.getElementById(id).classList.remove('drag'); }
function dropFile(e, type) { e.preventDefault(); dragLeave('zone-'+type); const f=e.dataTransfer.files[0]; if(f)processFile(f,type); }
function handleFile(e, type) { const f=e.target.files[0]; if(f)processFile(f,type); }

function processFile(file, type) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) {
    const r = new FileReader(); r.onload = e => parseCSV(e.target.result, type); r.readAsText(file);
  } else if (name.endsWith('.xlsx')||name.endsWith('.xls')) {
    const r = new FileReader();
    r.onload = e => { const wb=XLSX.read(e.target.result,{type:'binary'}); const ws=wb.Sheets[wb.SheetNames[0]]; parseCSV(XLSX.utils.sheet_to_csv(ws),type); };
    r.readAsBinaryString(file);
  } else setStatus(type,'❌ Only CSV/Excel supported','err');
}

function parseCSV(text, type) {
  const result = Papa.parse(text.trim(), { header:true, skipEmptyLines:true, dynamicTyping:true });
  if (type==='inflow') parseInflowData(result.data);
  else parseEnqueueData(result.data);
}

function parseInflowData(rows) {
  inflowData = {};
  let ok=0;
  rows.forEach(r => {
    const ds=String(r.date||r.Date||r.DATE||'').trim();
    const val=parseFloat(r.inflow||r.Inflow||r.INFLOW||0);
    if(ds&&!isNaN(val)){inflowData[ds]=val;ok++;}
  });
  setStatus('inflow',`✅ Loaded ${ok} days`,'ok');
  renderPreview('inflow', Object.entries(inflowData).slice(0,5).map(([d,v])=>({Date:d,Inflow:Math.round(v).toLocaleString()})));
}

function parseEnqueueData(rows) {
  enqueueData = {};
  let ok=0;
  rows.forEach(r => {
    const ds=String(r.date||r.Date||'').trim();
    const arr=Array.from({length:24},(_,h)=>parseFloat(r['h'+h]||r['H'+h]||0));
    if(ds&&arr.some(v=>v>0)){enqueueData[ds]=arr;ok++;}
  });
  setStatus('enqueue',`✅ Loaded ${ok} days`,'ok');
  const prev = Object.entries(enqueueData).slice(0,3).map(([d,arr])=>({Date:d,'h0':(arr[0]*100).toFixed(1)+'%','h9':(arr[9]*100).toFixed(1)+'%','h12':(arr[12]*100).toFixed(1)+'%','h18':(arr[18]*100).toFixed(1)+'%','…':'…'}));
  renderPreview('enqueue',prev);
}

function setStatus(type, msg, cls) {
  const el = document.getElementById('status-'+type);
  el.textContent = msg; el.className = 'upload-status '+cls;
}

function renderPreview(type, rows) {
  if(!rows.length)return;
  const keys=Object.keys(rows[0]);
  const el=document.getElementById('preview-'+type);
  el.innerHTML=`<table class="data-table"><thead><tr>${keys.map(k=>`<th>${k}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${keys.map(k=>`<td>${r[k]??''}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function applyAndRun() {
  if(!Object.keys(inflowData).length){document.getElementById('applyStatus').textContent='⚠ No inflow data.';return;}
  document.getElementById('applyStatus').textContent='';
  calcWeek(); showTab('week');
}

function useSampleData() {
  inflowData = {'01.06.2026':77444,'02.06.2026':77444,'03.06.2026':77444,'04.06.2026':83593,'05.06.2026':101723,'06.06.2026':99901,'07.06.2026':79013};
  enqueueData = {};
  setStatus('inflow','✅ Sample data loaded (7 days)','ok');
  setStatus('enqueue','ℹ Using default profiles by event type','ok');
  renderPreview('inflow',Object.entries(inflowData).map(([d,v])=>({Date:d,Inflow:Math.round(v).toLocaleString()})));
  calcWeek(); showTab('week');
}

function downloadInflowTemplate() {
  downloadCSV('date,inflow\n01.06.2026,77444\n02.06.2026,83593','inflow_template.csv');
}
function downloadEnqueueTemplate() {
  const h = Array.from({length:24},(_,i)=>'h'+i).join(',');
  downloadCSV(`date,${h}\n01.06.2026,${ENQUEUE_DEFAULT.Normal.join(',')}`,'enqueue_template.csv');
}
function downloadCSV(content, filename) {
  const a=document.createElement('a'); a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(content); a.download=filename; a.click();
}

// ── SHIFT DEFINITIONS ─────────────────────────────────────────────────────────
function buildShift(name,start,brk,cost){
  const slots=[];
  if(brk!==null){for(let i=0;i<9;i++){const abs=start+i,h=abs%24;if(h!==brk)slots.push({abs,h,day:abs>=24?1:0});}}
  else{for(let i=0;i<4;i++){const abs=start+i;slots.push({abs,h:abs%24,day:abs>=24?1:0});}}
  return{name,start,brk,cost,slots,hrs_today:slots.filter(s=>s.day===0).map(s=>s.h),hrs_next:slots.filter(s=>s.day===1).map(s=>s.h)};
}
const SHIFTS_FT=[
  buildShift('S0*',6,10,1),buildShift('S0',7,11,1),buildShift('S1',8,12,1),
  buildShift('S2',9,13,1),buildShift('S3',10,14,1),buildShift('S4',11,15,1),
  buildShift('S5',13,17,1),buildShift('S8',14,18,1),buildShift('S7',15,19,1),
  buildShift('S9',16,20,1),buildShift('S10',17,21,1),buildShift('S11',18,22,1),
  buildShift('S12',19,23,1),buildShift('S6',22,null,1),
];
(()=>{const s=SHIFTS_FT.find(x=>x.name==='S6');const sl=[];for(let i=0;i<9;i++){const abs=22+i;if(abs!==26)sl.push({abs,h:abs%24,day:abs>=24?1:0});}s.slots=sl;s.hrs_today=sl.filter(x=>x.day===0).map(x=>x.h);s.hrs_next=sl.filter(x=>x.day===1).map(x=>x.h);})();
const SHIFTS_PT=[
  buildShift('P1',9,null,.5),buildShift('P2',13,null,.5),buildShift('P3',19,null,.5),
  buildShift('P4',20,null,.5),buildShift('P5',0,null,.5),buildShift('P6',12,null,.5),
  buildShift('P7',11,null,.5),buildShift('P8',16,null,.5),buildShift('P9',23,null,.5),
  buildShift('P10',10,null,.5),buildShift('P11',8,null,.5),buildShift('P12',7,null,.5),
  buildShift('P13',17,null,.5),buildShift('P14',18,null,.5),buildShift('P15',15,null,.5),
  buildShift('P16',21,null,.5),buildShift('P17',22,null,.5),buildShift('P18',2,null,.5),
  buildShift('P19',3,null,.5),
];
(()=>{const s=SHIFTS_PT.find(x=>x.name==='P5');const sl=[];for(let i=0;i<4;i++)sl.push({abs:i,h:i,day:0});s.slots=sl;s.hrs_today=[0,1,2,3];s.hrs_next=[];})();
const ALL_SHIFTS=[...SHIFTS_FT,...SHIFTS_PT];

function calcCoverage(sc,carryIn){
  const cov=new Array(24).fill(0);
  if(carryIn)for(let h=0;h<24;h++)cov[h]+=carryIn[h]||0;
  ALL_SHIFTS.forEach(s=>{const n=sc[s.name]||0;if(n>0)s.hrs_today.forEach(h=>cov[h]+=n);});
  return cov;
}
function calcCarryOut(sc){
  const nx=new Array(24).fill(0);
  ALL_SHIFTS.forEach(s=>{const n=sc[s.name]||0;if(n>0)s.hrs_next.forEach(h=>nx[h]+=n);});
  return nx;
}
function dailyTask(cov,inflows){let t=0;for(let h=0;h<24;h++)t+=Math.min(cov[h]*HOUR_PROD,inflows[h]);return t;}

function optimize(inflows,carryIn){
  const totalInflow=inflows.reduce((a,b)=>a+b,0);
  const targetTask=totalInflow*TARGET;
  const ac={};ALL_SHIFTS.forEach(s=>ac[s.name]=0);
  const cov=new Array(24).fill(0);
  if(carryIn)for(let h=0;h<24;h++)cov[h]+=carryIn[h]||0;
  for(let iter=0;iter<2000;iter++){
    if(dailyTask(cov,inflows)>=targetTask)break;
    let bSi=-1,bSc=-1;
    for(let si=0;si<ALL_SHIFTS.length;si++){
      const s=ALL_SHIFTS[si];let gain=0;
      s.hrs_today.forEach(h=>{const cap=cov[h]*HOUR_PROD;if(cap<inflows[h])gain+=Math.min(HOUR_PROD,inflows[h]-cap);});
      const sc=gain/s.cost;if(sc>bSc){bSc=sc;bSi=si;}
    }
    if(bSi<0||bSc<=0)break;
    ac[ALL_SHIFTS[bSi].name]++;ALL_SHIFTS[bSi].hrs_today.forEach(h=>cov[h]++);
  }
  const carryOut=calcCarryOut(ac),completed=dailyTask(cov,inflows);
  let ft=0,pt=0;SHIFTS_FT.forEach(s=>ft+=ac[s.name]);SHIFTS_PT.forEach(s=>pt+=ac[s.name]);
  return{shiftCounts:ac,coverage:cov,carryOut,totalCompleted:completed,totalInflow,
    coverage_pct:completed/totalInflow,abandon_pct:Math.max(0,(totalInflow-completed)/totalInflow),ft,pt,weightedHC:ft+pt/2};
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getEventType(ds,dow){
  const p=ds.split('.');if(p.length<3)return dow===6?'Sat':dow===0?'Sun':'Normal';
  const d=parseInt(p[0]),m=parseInt(p[1]);
  if(d===m)return 'Spike';
  const prev=new Date(parseInt(p[2]),m-1,d);prev.setDate(prev.getDate()-1);
  if(prev.getDate()===prev.getMonth()+1)return 'Spike-1';
  if(d===14)return '14th';if(d===15)return '15th';if(d===24)return '24th';if(d===25)return '25th';
  if(dow===6)return 'Sat';if(dow===0)return 'Sun';return 'Normal';
}
function parseDateStr(ds){const p=ds.trim().split('.');return new Date(parseInt(p[2]),parseInt(p[1])-1,parseInt(p[0]));}
function formatDate(dt){return`${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`;}
function addDays(ds,n){const dt=parseDateStr(ds);dt.setDate(dt.getDate()+n);return formatDate(dt);}
function getDOW(ds){return parseDateStr(ds).getDay();}

const DOW_LABELS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOW_VN=['Chủ Nhật','Thứ Hai','Thứ Ba','Thứ Tư','Thứ Năm','Thứ Sáu','Thứ Bảy'];
const EVT_COLORS={Normal:{bg:'rgba(40,167,69,.12)',text:'#28a745'},Spike:{bg:'rgba(220,53,69,.12)',text:'#dc3545'},'Spike-1':{bg:'rgba(255,193,7,.15)',text:'#b58100'},'14th':{bg:'rgba(26,115,232,.12)',text:'#1a73e8'},'15th':{bg:'rgba(26,115,232,.12)',text:'#1a73e8'},'24th':{bg:'rgba(156,39,176,.12)',text:'#9c27b0'},'25th':{bg:'rgba(156,39,176,.12)',text:'#9c27b0'},Sat:{bg:'var(--bg3)',text:'var(--text2)'},Sun:{bg:'var(--bg3)',text:'var(--text2)'}};

// ── MAIN CALC ──────────────────────────────────────────────────────────────────
function calcWeek() {
  updateDerived();
  TARGET = (parseFloat(document.getElementById('targetCov').value)||93)/100;
  const dates = Object.keys(inflowData).sort((a,b)=>parseDateStr(a)-parseDateStr(b));
  if(!dates.length)return;
  weekData=[]; manualShift={};
  let prevCarryOut=new Array(24).fill(0);
  dates.forEach((ds,idx)=>{
    const inflow=inflowData[ds],dow=getDOW(ds),event=getEventType(ds,dow);
    let enq=enqueueData[ds]||(ENQUEUE_DEFAULT[event]||ENQUEUE_DEFAULT.Normal);
    const sum=enq.reduce((a,b)=>a+b,0);if(sum>0)enq=enq.map(v=>v/sum);
    const hourInflows=enq.map(p=>inflow*p);
    const opt=optimize(hourInflows,prevCarryOut);
    weekData.push({d:idx,dateStr:ds,dow,event,inflow,hourInflows,enq,opt,carryIn:[...prevCarryOut],dowLabel:DOW_LABELS[dow]});
    prevCarryOut=opt.carryOut; manualShift[idx]=null;
  });
  populateSelects(); renderWeekGrid(); renderDayDetail(); renderShiftBreakdown();
}

function populateSelects(){
  ['daySelect','shiftDaySelect'].forEach(id=>{
    const sel=document.getElementById(id); if(!sel)return; sel.innerHTML='';
    weekData.forEach(wd=>{const o=document.createElement('option');o.value=wd.d;o.textContent=`${wd.dowLabel} ${wd.dateStr}`;sel.appendChild(o);});
  });
}
function getEff(d){return manualShift[d]||weekData[d].opt;}

// ── RENDER WEEK ────────────────────────────────────────────────────────────────
function renderWeekGrid()){
  const cols=Math.min(weekData.length,7);
  const g=document.getElementById('weekGrid');
  if(!g)return;
  g.style.gridTemplateColumns=`repeat(${cols},1fr)`;
  g.innerHTML=weekData.map(wd=>{
    const e=getEff(wd.d);const ok=e.coverage_pct>=TARGET;
    const ec=EVT_COLORS[wd.event]||EVT_COLORS.Normal;
    return`<div class="day-card" onclick="selectDay(${wd.d})" id="dc${wd.d}">
      <div class="dc-dow">${wd.dowLabel}</div>
      <div class="dc-date">${wd.dateStr}</div>
      <div class="dc-event" style="background:${ec.bg};color:${ec.text}">${wd.event}</div>
      <div class="dc-hc" style="color:${ok?'var(--success)':'var(--danger)'}">${e.weightedHC.toFixed(1)}</div>
      <div class="dc-breakdown">FT ${e.ft} · PT ${e.pt}</div>
      <div class="dc-kpi">
        <span class="dc-stat" style="color:${ok?'var(--success)':'var(--danger)'}">▲ ${(e.coverage_pct*100).toFixed(1)}%</span>
        <span class="dc-stat" style="color:${e.abandon_pct<1-TARGET?'var(--success)':'var(--danger)'}">▽ ${(e.abandon_pct*100).toFixed(1)}%</span>
      </div>
    </div>`;
  }).join('');

  const tFT=weekData.reduce((s,w)=>s+getEff(w.d).ft,0);
  const tPT=weekData.reduce((s,w)=>s+getEff(w.d).pt,0);
  const tW=tFT+tPT/2;
  const avgCov=weekData.reduce((s,w)=>s+getEff(w.d).coverage_pct,0)/weekData.length;
  const avgAb=weekData.reduce((s,w)=>s+getEff(w.d).abandon_pct,0)/weekData.length;
  const naive=weekData.reduce((s,w)=>s+Math.ceil(w.inflow/(HOUR_PROD*8)),0);

  document.getElementById('weekKPI').innerHTML=`
    <div class="kpi-card"><div class="kpi-label">Total HC Order</div><div class="kpi-value kv-neutral">${tW.toFixed(1)}</div><div class="kpi-sub">FT ${tFT} · PT ${tPT} (×½)</div></div>
    <div class="kpi-card"><div class="kpi-label">HC Saved vs 100%</div><div class="kpi-value kv-good">−${(naive-tW).toFixed(1)}</div><div class="kpi-sub">naive baseline ${naive}</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg Coverage</div><div class="kpi-value ${avgCov>=TARGET?'kv-good':'kv-bad'}">${(avgCov*100).toFixed(1)}%</div><div class="kpi-sub">target ≥ ${(TARGET*100).toFixed(0)}%</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg Abandon</div><div class="kpi-value ${avgAb<1-TARGET?'kv-good':'kv-bad'}">${(avgAb*100).toFixed(1)}%</div><div class="kpi-sub">target &lt; ${((1-TARGET)*100).toFixed(0)}%</div></div>`;

  if(weekChart)weekChart.destroy();
  weekChart=new Chart(document.getElementById('weekChart'),{
    type:'bar',
    data:{labels:weekData.map(w=>`${w.dowLabel} ${w.dateStr.slice(0,5)}`),datasets:[
      {label:'Fulltime',data:weekData.map(w=>getEff(w.d).ft),backgroundColor:'#1a73e8',borderRadius:4,stack:'s'},
      {label:'Parttime/2',data:weekData.map(w=>getEff(w.d).pt/2),backgroundColor:'#28a745',borderRadius:4,stack:'s'}
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.parsed.y}`}}},
      scales:{x:{stacked:true,ticks:{color:'#6c757d',font:{size:10}},grid:{color:'rgba(0,0,0,.04)'}},
        y:{stacked:true,beginAtZero:true,ticks:{color:'#6c757d',font:{size:11}},grid:{color:'rgba(0,0,0,.04)'}}}}
  });
}

function selectDay(d){
  document.getElementById('daySelect').value=d;
  document.getElementById('shiftDaySelect').value=d;
  document.querySelectorAll('.day-card').forEach((el,i)=>el.classList.toggle('active',i===d));
  renderDayDetail(); renderShiftBreakdown();
}

// ── RENDER DAY ─────────────────────────────────────────────────────────────────
function renderDayDetail(){
  const d=parseInt(document.getElementById('daySelect').value);
  if(!weekData[d])return;
  const wd=weekData[d],e=getEff(d);
  const naive=Math.ceil(wd.inflow/(HOUR_PROD*8));
  const carryTotal=wd.carryIn.reduce((a,b)=>a+b,0);
  const saved=naive-e.weightedHC;

  document.getElementById('dayMetrics').innerHTML=`
    <div class="kpi-card"><div class="kpi-label">Optimized HC</div><div class="kpi-value kv-good">${e.weightedHC.toFixed(1)}</div><div class="kpi-sub">FT ${e.ft} · PT ${e.pt} (×½)</div></div>
    <div class="kpi-card"><div class="kpi-label">HC @ 100% baseline</div><div class="kpi-value kv-dim">${naive}</div><div class="kpi-sub">saved ${saved>0?saved.toFixed(1)+' HC':'–'}</div></div>
    <div class="kpi-card"><div class="kpi-label">%Task Coverage</div><div class="kpi-value ${e.coverage_pct>=TARGET?'kv-good':'kv-bad'}">${(e.coverage_pct*100).toFixed(1)}%</div><div class="kpi-sub">target ≥ ${(TARGET*100).toFixed(0)}%</div></div>
    <div class="kpi-card"><div class="kpi-label">%Abandon</div><div class="kpi-value ${e.abandon_pct<1-TARGET?'kv-good':'kv-bad'}">${(e.abandon_pct*100).toFixed(1)}%</div><div class="kpi-sub">daily level</div></div>`;

  const enqSrc=enqueueData[wd.dateStr]?'uploaded':'default ('+wd.event+')';
  document.getElementById('dayInfo').innerHTML=
    `<strong>${wd.dateStr} · ${DOW_VN[wd.dow]} · ${wd.event}</strong>&nbsp;&nbsp;|&nbsp;&nbsp;
     AHT <strong>${document.getElementById('ahtInput').value}s</strong> · Util <strong>${document.getElementById('utilInput').value}%</strong> · HourProd <strong>${HOUR_PROD.toLocaleString()}</strong>&nbsp;&nbsp;|&nbsp;&nbsp;
     Inflow <strong>${Math.round(wd.inflow).toLocaleString()}</strong> · Target <strong>${Math.round(wd.inflow*TARGET).toLocaleString()}</strong> · Completed <strong>${Math.round(e.totalCompleted).toLocaleString()}</strong>&nbsp;&nbsp;|&nbsp;&nbsp;
     %Enqueue: <strong>${enqSrc}</strong>${carryTotal>0?`&nbsp;&nbsp;|&nbsp;&nbsp;Carry-in: <span class="carry-tag">${carryTotal} agent-hrs</span>`:''}`;

  document.getElementById('dayTbody').innerHTML=wd.hourInflows.map((inf,h)=>{
    const cov=e.coverage[h]||0,carryH=wd.carryIn[h]||0;
    const task=Math.min(cov*HOUR_PROD,inf),ab=Math.max(inf-cov*HOUR_PROD,0);
    const covPct=inf>0?task/inf:1,abPct=inf>0?ab/inf:0;
    const kpiOk=covPct>=TARGET;
    const kpi=cov===0&&inf===0?`<span class="badge badge-gray">–</span>`:kpiOk?`<span class="badge badge-green">✓ OK</span>`:covPct>=0.7?`<span class="badge badge-amber">⚠ Low</span>`:`<span class="badge badge-red">✗ Miss</span>`;
    return`<tr>
      <td><strong>${h}:00</strong></td>
      <td>${(wd.enq[h]*100).toFixed(2)}%</td>
      <td>${Math.round(inf).toLocaleString()}</td>
      <td><span class="badge badge-blue">${cov}</span>${carryH>0?`<span class="carry-tag">+${carryH}↩</span>`:''}</td>
      <td>${Math.round(task).toLocaleString()}</td>
      <td><span class="badge ${covPct>=TARGET?'badge-green':covPct>=0.7?'badge-amber':'badge-red'}">${(covPct*100).toFixed(1)}%</span></td>
      <td><span class="badge ${abPct<1-TARGET?'badge-green':abPct<0.3?'badge-amber':'badge-red'}">${(abPct*100).toFixed(1)}%</span></td>
      <td>${kpi}</td>
    </tr>`;
  }).join('');
}

// ── RENDER SHIFT ───────────────────────────────────────────────────────
function renderShiftBreakdown(){
  const d=parseInt(document.getElementById('shiftDaySelect').value);
  if(!weekData[d])return;
  const wd=weekData[d],e=getEff(d),sc=e.shiftCounts;
  const canEdit = currentRole==='owner'||currentRole==='editor';

  document.getElementById('shiftMetrics').innerHTML=`
    <div class="kpi-card"><div class="kpi-label">Total HC Order</div><div class="kpi-value kv-good">${e.weightedHC.toFixed(1)}</div><div class="kpi-sub">FT ${e.ft} · PT ${e.pt} (×½)</div></div>
    <div class="kpi-card"><div class="kpi-label">Fulltime</div><div class="kpi-value" style="color:var(--accent)">${e.ft}</div></div>
    <div class="kpi-card"><div class="kpi-label">Parttime</div><div class="kpi-value" style="color:var(--accent2)">${e.pt}</div><div class="kpi-sub">×½ in HC formula</div></div>
    <div class="kpi-card"><div class="kpi-label">Coverage (daily)</div><div class="kpi-value ${e.coverage_pct>=TARGET?'kv-good':'kv-bad'}">${(e.coverage_pct*100).toFixed(1)}%</div><div class="kpi-sub">target ≥ ${(TARGET*100).toFixed(0)}%</div></div>`;

  const coTotal=e.carryOut.reduce((a,b)=>a+b,0);
  document.getElementById('shiftInfo').innerHTML=
    `<strong>${wd.dateStr} · ${DOW_VN[wd.dow]}</strong>&nbsp;&nbsp;|&nbsp;&nbsp;`+
    (coTotal>0?`Carry-over → ${addDays(wd.dateStr,1)}: <span class="carry-tag">${e.carryOut.map((v,h)=>v>0?h+'('+v+')':'').filter(Boolean).join(' ')}</span>`:'No carry-over to next day.');

  document.getElementById('ftTbody').innerHTML=SHIFTS_FT.map(s=>{
    const n=sc[s.name]||0;
    const cleanHrsToday = s.hrs_today.map(h => h).join(' ');
    const cleanHrsNext = s.hrs_next.map(h => h).join(' ');

    return`<tr class="${n>0?'':'dim'}">
      <td><strong>${s.name}</strong></td><td>${s.start%24}:00</td>
      <td>${s.brk!==null?s.brk+':00':'–'}</td>
      <td style="font-family:var(--sans);font-size:11.5px;color:var(--text2)">${cleanHrsToday||'–'}</td>
      <td style="font-size:11.5px">${s.hrs_next.length?`<span class="carry-tag">${cleanHrsNext}</span>`:'–'}</td>
      <td><input class="hc-input" type="number" min="0" value="${n}" ${!canEdit?'disabled':''} onchange="setShiftManual(${d},'${s.name}',this.value)"></td>
    </tr>`;
  }).join('');

  document.getElementById('ptTbody').innerHTML=SHIFTS_PT.map(s=>{
    const n=sc[s.name]||0;
    const cleanHrsToday = s.hrs_today.map(h => h).join(' ');
    const cleanHrsNext = s.hrs_next.map(h => h).join(' ');

    return`<tr class="${n>0?'':'dim'}">
      <td><strong>${s.name}</strong></td><td>${s.start%24}:00</td><td>${(s.start+4)%24}:59</td>
      <td style="font-family:var(--sans);font-size:11.5px;color:var(--text2)">${cleanHrsToday||'–'}</td>
      <td style="font-size:11.5px">${s.hrs_next.length?`<span class="carry-tag">${cleanHrsNext}</span>`:'–'}</td>
      <td><input class="hc-input" type="number" min="0" value="${n}" ${!canEdit?'disabled':''} onchange="setShiftManual(${d},'${s.name}',this.value)"></td>
    </tr>`;
  }).join('');

  if(shiftChart)shiftChart.destroy();
  shiftChart=new Chart(document.getElementById('shiftChart'),{
    type:'bar',
    data:{labels:Array.from({length:24},(_,i)=>i+':00'),datasets:[
      {label:'Coverage',data:e.coverage,backgroundColor:'rgba(26,115,232,.3)',borderRadius:2,order:2},
      {label:'Carry-in',data:wd.carryIn,backgroundColor:'rgba(230,126,34,.2)',borderRadius:2,order:3},
      {label:'HC Optimal',data:e.coverage,type:'line',borderColor:'#dc3545',backgroundColor:'transparent',borderWidth:2,pointRadius:0,order:1}
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{font:{size:11},color:'#495057',boxWidth:12}}},
      scales:{x:{ticks:{autoSkip:false,font:{size:9},color:'#6c757d'},grid:{color:'rgba(0,0,0,.04)'}},
        y:{beginAtZero:true,ticks:{color:'#6c757d'},grid:{color:'rgba(0,0,0,.04)'}}}}
  });
}

function setShiftManual(d,name,val){
  const wd=weekData[d];
  if(!manualShift[d])manualShift[d]=JSON.parse(JSON.stringify(wd.opt));
  manualShift[d].shiftCounts[name]=parseInt(val)||0;
  const cov=calcCoverage(manualShift[d].shiftCounts,wd.carryIn);
  const co=calcCarryOut(manualShift[d].shiftCounts);
  let tot=0;wd.hourInflows.forEach((inf,h)=>tot+=Math.min(cov[h]*HOUR_PROD,inf));
  let ft=0,pt=0;SHIFTS_FT.forEach(s=>ft+=manualShift[d].shiftCounts[s.name]||0);SHIFTS_PT.forEach(s=>pt+=manualShift[d].shiftCounts[s.name]||0);
  Object.assign(manualShift[d],{coverage:cov,carryOut:co,totalCompleted:tot,totalInflow:wd.opt.totalInflow,
    coverage_pct:tot/wd.opt.totalInflow,abandon_pct:Math.max(0,(wd.opt.totalInflow-tot)/wd.opt.totalInflow),ft,pt,weightedHC:ft+pt/2});
  renderShiftBreakdown(); renderWeekGrid();
}

function resetShift(){
  const d=parseInt(document.getElementById('shiftDaySelect').value);
  manualShift[d]=null; renderShiftBreakdown(); renderWeekGrid();
}

function showTab(name){
  const names=['data','week','day','shift'];
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',names[i]===name));
  document.querySelectorAll('.section').forEach((s,i)=>s.classList.toggle('active',names[i]===name));
}
