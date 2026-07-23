// ── STATE ─────────────────────────────────────────────────────────────────────
let currentRole = 'viewer';
let currentUser = null;
let HOUR_PROD = 1224;
let TARGET = 0.93;
let EVENT_TARGETS = {Normal:null,Spike:null,'Spike-1':null,'14th':null,'15th':null,'24th':null,'25th':null,Sat:null,Sun:null};
let inflowData = {}, enqueueData = {};
let weekData = [], manualShift = {};
let weekChart = null, shiftChart = null;
let historicalData = []; // dữ liệu lịch sử từ tab "Historical Data" (Google Sheet)

// Canvas (Chart.js) không kế thừa font-family từ CSS → ép font đồng bộ toàn hệ thống
if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = "'Times New Roman', Times, serif";
}

// ── INIT ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await fetchMe();
  renderSpecialTargetGrid();
  await loadSharedConfig();
  updateDerived();
});

async function fetchMe() {
  const res = await fetch('/api/me');
  const { user, role } = await res.json();
  currentRole = role; currentUser = user;
  applyRole();
}

function applyRole() {
  const isAuth = !!currentUser;
  const canEdit = currentRole === 'owner' || currentRole === 'editor';

  document.getElementById('loginBtn').classList.toggle('hidden', isAuth);
  document.getElementById('logoutBtn').classList.toggle('hidden', !isAuth);
  document.getElementById('userInfo').classList.toggle('hidden', !isAuth);
  document.getElementById('roleChip').classList.toggle('hidden', !isAuth);
  document.getElementById('adminBtn').classList.toggle('hidden', currentRole !== 'owner');
  document.getElementById('viewerBanner').classList.toggle('hidden', isAuth && canEdit || !isAuth ? isAuth && canEdit : false);

  if (!isAuth) document.getElementById('viewerBanner').classList.remove('hidden');
  else if (!canEdit) document.getElementById('viewerBanner').classList.remove('hidden');

  if (isAuth) {
    document.getElementById('userPhoto').src = currentUser.photo || '';
    document.getElementById('userName').textContent = currentUser.name;
    const chip = document.getElementById('roleChip');
    chip.textContent = currentRole.toUpperCase();
    chip.className = `role-chip ${currentRole}`;
  }

  const inputs = document.querySelectorAll('.param-bar input, .hc-input, #newEditorEmail, #specialTargetGrid input');
  inputs.forEach(el => el.disabled = !canEdit);
  document.getElementById('runBtn').disabled = !canEdit;
  document.getElementById('exportBtn').disabled = !canEdit;
  document.getElementById('saveBtn').classList.toggle('hidden', !canEdit);

  document.querySelectorAll('.drop-zone').forEach(z => {
    z.style.pointerEvents = canEdit ? 'auto' : 'none';
    z.style.opacity = canEdit ? '1' : '0.5';
  });
  document.querySelectorAll('.data-actions button').forEach(b => b.disabled = !canEdit);
}

// ── PARAMS ────────────────────────────────────────────────────────────────────
function updateDerived() {
  const aht = parseFloat(document.getElementById('ahtInput').value) || 2.5;
  const util = parseFloat(document.getElementById('utilInput').value) || 85;
  HOUR_PROD = Math.round(3600 * (util / 100) / aht);
  document.getElementById('hpDisplay').textContent = HOUR_PROD.toLocaleString();
  document.getElementById('dpDisplay').textContent = (HOUR_PROD * 8).toLocaleString();
}

// ── SPECIAL DAY TARGETS ───────────────────────────────────────────────────────
const SPECIAL_EVENTS=['Spike-1','Spike','14th','15th','24th','25th'];
function renderSpecialTargetGrid(){
  const grid=document.getElementById('specialTargetGrid');
  if(!grid)return;
  grid.innerHTML=SPECIAL_EVENTS.map(ev=>{
    const v=EVENT_TARGETS[ev];
    return`<div class="stp-item">
      <label>${ev}</label>
      <input type="number" min="50" max="100" step="0.1" placeholder="—"
        value="${v!==null&&v!==undefined?(v*100):''}"
        data-event="${ev}" onchange="setEventTarget('${ev}',this.value)">
    </div>`;
  }).join('');
}
function setEventTarget(ev,val){
  const n=parseFloat(val);
  EVENT_TARGETS[ev]=(val===''||isNaN(n))?null:(n/100);
}
function toggleSpecialTargets(){
  document.getElementById('specialTargetPanel').classList.toggle('hidden');
}

// Trích xuất dữ liệu Shift Breakdown (cột A:I trên Google Sheet)
function buildShiftExportRows() {
  if (!weekData.length) return [];
  const rows = [];
  weekData.forEach(wd => {
    const e = getEff(wd.d);
    ALL_SHIFTS.forEach(s => {
      const count = e.shiftCounts[s.name] || 0;
      if (count <= 0) return;
      rows.push({
        date: wd.dateStr,
        dow: wd.dowLabel,
        event: wd.event,
        inflow: Math.round(e.totalInflow),
        total_hc_order: +e.weightedHC.toFixed(1),
        coverage_pct: +(e.coverage_pct * 100).toFixed(1),
        shift_name: s.name,
        shift_type: s.cost === 1 ? 'F' : 'P',
        shift_count: count
      });
    });
  });
  return rows;
}

// ── ABANDON WARNINGS — khung giờ %Abandon vượt target theo từng ngày ────────
// Ngưỡng: Abandon target = 1 − Coverage Target (áp dụng theo target riêng của từng event nếu có override)
function buildAbandonWarnings(){
  if(!weekData.length) return [];
  const warnings=[];
  weekData.forEach(wd=>{
    const e=getEff(wd.d);
    const abandonTarget=1-wd.eventTarget;
    wd.hourInflows.forEach((inf,h)=>{
      const cov=e.coverage[h]||0;
      const ab=Math.max(inf-cov*HOUR_PROD,0);
      const abPct=inf>0?ab/inf:0;
      if(abPct>abandonTarget){
        warnings.push({
          dateStr: wd.dateStr,
          dowLabel: wd.dowLabel,
          hour: h,
          abandon_pct: +(abPct*100).toFixed(1)
        });
      }
    });
  });
  return warnings;
}

// Render bảng cảnh báo trong tab Shift Allocation — format: Ngày | Khung giờ abandon cao
function renderAbandonWarnings(){
  const wrap=document.getElementById('abandonWarningsWrap');
  if(!wrap)return;
  const warnings=buildAbandonWarnings();
  if(!warnings.length){
    wrap.innerHTML=`<div class="table-card">
      <div class="table-card-title">⚠️ Abandon Alerts — Hours Exceeding Target</div>
      <div style="padding:14px 18px;font-size:12px;color:var(--text3)">Không có khung giờ nào vượt target Abandon trong tuần này.</div>
    </div>`;
    return;
  }
  const byDay={};
  warnings.forEach(w=>{
    if(!byDay[w.dateStr]) byDay[w.dateStr]={dowLabel:w.dowLabel, hours:[]};
    byDay[w.dateStr].hours.push(w);
  });
  const rows=Object.entries(byDay).map(([dateStr,info])=>{
    const hoursStr=info.hours.map(h=>`<span class="badge badge-red" style="margin-right:4px">${h.hour}h (${h.abandon_pct.toFixed(1)}%)</span>`).join('');
    return `<tr><td><strong>${info.dowLabel} ${dateStr}</strong></td><td>${hoursStr}</td></tr>`;
  }).join('');
  wrap.innerHTML=`<div class="table-card">
    <div class="table-card-title">⚠️ Abandon Alerts — Hours Exceeding Target</div>
    <div class="table-scroll"><table class="data-table">
      <thead><tr><th>Ngày</th><th>Khung giờ abandon cao</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

// ── EXPORT SHIFT DATA + ABANDON WARNINGS → Google Sheet ───────────────────────
async function exportShiftData() {
  if (!weekData.length) {
    showExportModal('⚠ Chưa có dữ liệu', 'Vui lòng chạy Run Optimizer trước khi export.', true);
    return;
  }
  const btn = document.getElementById('exportBtn');
  const oldTxt = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Exporting...';
  try {
    const rows = buildShiftExportRows();
    if (!rows.length) throw new Error('Không có dòng dữ liệu ca nào có nhân sự để export.');

    const abandonWarnings = buildAbandonWarnings();
    const abandonRows = abandonWarnings.map(w => ({
      date: w.dateStr, hour: w.hour, abandon_pct: w.abandon_pct
    }));

    const res = await fetch('/api/export-shift', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows, abandonRows })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

    const linkHtml = data.sheetUrl
      ? `<a href="${data.sheetUrl}" target="_blank" rel="noopener"
           style="display:inline-flex;align-items:center;gap:6px;margin-top:10px;
                  padding:8px 14px;background:var(--blue-lt);color:var(--blue);
                  border:1.5px solid var(--blue-md);border-radius:var(--radius-xs);
                  font-weight:600;font-size:12px;text-decoration:none">
           📄 Mở Google Sheet vừa export ↗
         </a>`
      : '';

    showExportModal(
      '✅ Export thành công',
      `Đã ghi thêm <strong>${data.appended}</strong> dòng Shift Breakdown${data.abandonAppended ? ` và <strong>${data.abandonAppended}</strong> dòng cảnh báo Abandon` : ''} vào Google Sheet.${data.updatedRange ? `<br><span style="font-size:11px;color:var(--text3)">Range: ${data.updatedRange}</span>` : ''}${linkHtml}`,
      false
    );
  } catch (err) {
    showExportModal('❌ Export thất bại', err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = oldTxt;
  }
}
function showExportModal(title, msgHtml, isError) {
  document.getElementById('exportModalTitle').textContent = title;
  const body = document.getElementById('exportModalBody');
  body.innerHTML = msgHtml;
  body.style.color = isError ? 'var(--danger)' : 'var(--text2)';
  document.getElementById('exportModal').classList.remove('hidden');
}
function closeExportModal() {
  document.getElementById('exportModal').classList.add('hidden');
}

// ── CONFIG SAVE / LOAD ────────────────────────────────────────────────────────
async function saveConfig() {
  const shiftExportRows = buildShiftExportRows();

  const config = {
    aht: document.getElementById('ahtInput').value,
    util: document.getElementById('utilInput').value,
    target: document.getElementById('targetCov').value,
    eventTargets: EVENT_TARGETS,
    inflowData, enqueueData,
    sheetUrlInflow: window._sheetUrlInflow||'',
    sheetUrlEnqueue: window._sheetUrlEnqueue||'',
    shiftExportRows
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
  if (config.eventTargets) { Object.assign(EVENT_TARGETS, config.eventTargets); renderSpecialTargetGrid(); }
  if (config.inflowData) inflowData = config.inflowData;
  if (config.enqueueData) enqueueData = config.enqueueData;
  if (config.sheetUrlInflow){window._sheetUrlInflow=config.sheetUrlInflow;const el=document.getElementById('sheetUrlInflow');if(el)el.value=config.sheetUrlInflow;}
  if (config.sheetUrlEnqueue){window._sheetUrlEnqueue=config.sheetUrlEnqueue;const el=document.getElementById('sheetUrlEnqueue');if(el)el.value=config.sheetUrlEnqueue;}
  updateDerived();
  if (window._sheetUrlInflow) fetchHistoricalData();
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

// ── GOOGLE SHEETS IMPORT ──────────────────────────────────────────────────────
function sheetsToCSV(url, sheetName){
  let id='';
  const m=url.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if(m)id=m[1];
  else if(/^[a-zA-Z0-9_-]{20,}$/.test(url.trim()))id=url.trim();
  if(!id)return null;
  const gidMatch=url.match(/[?&#]gid=(\d+)/);
  const gid=gidMatch?gidMatch[1]:'0';
  return`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

function isAppsScriptURL(url){
  return /script\.google\.com\/(a\/macros\/[^/]+\/|macros\/)s\/.+\/exec/.test(url.trim());
}

async function fetchSheetData(type){
  const inputId=type==='inflow'?'sheetUrlInflow':'sheetUrlEnqueue';
  const raw=document.getElementById(inputId).value.trim();
  if(!raw){setStatus(type,'⚠ Please enter a Spreadsheet URL or ID first','err');return;}

  let spreadsheetId='';
  const m=raw.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if(m) spreadsheetId=m[1];
  else if(/^[a-zA-Z0-9_-]{20,}$/.test(raw)) spreadsheetId=raw;
  else{setStatus(type,'❌ Invalid URL — please provide a Google Sheets link or Spreadsheet ID','err');return;}

  const sheetName=type==='inflow'
    ?(document.getElementById('sheetNameInflow')||{value:'Inflow'}).value||'Inflow'
    :(document.getElementById('sheetNameEnqueue')||{value:'Enqueue'}).value||'Enqueue';

  setStatus(type,'⏳ Loading from Google Sheets…','');
  try{
    const res=await fetch(`/api/fetch-sheet?type=${type}&spreadsheetId=${encodeURIComponent(spreadsheetId)}&sheet=${encodeURIComponent(sheetName)}`);
    const json=await res.json();
    if(!res.ok||json.error)throw new Error(json.error||`HTTP ${res.status}`);
    if(type==='inflow')parseInflowJSON(Array.isArray(json)?json:[json]);
    else parseEnqueueJSON(Array.isArray(json)?json:[json]);
    if(type==='inflow'){window._sheetUrlInflow=raw;window._sheetNameInflow=sheetName;fetchHistoricalData();}
    else{window._sheetUrlEnqueue=raw;window._sheetNameEnqueue=sheetName;}
  }catch(err){
    setStatus(type,`❌ ${err.message}`,'err');
  }
}

function parseInflowJSON(rows){
  inflowData={};let ok=0;
  rows.forEach(r=>{
    const ds=String(r.date||r.Date||'').trim();
    const val=parseFloat(r.inflow||r.Inflow||0);
    if(ds&&!isNaN(val)){inflowData[ds]=val;ok++;}
  });
  setStatus('inflow',`✅ Loaded ${ok} days from Google Sheets`,'ok');
  renderPreview('inflow',Object.entries(inflowData).slice(0,5).map(([d,v])=>({Date:d,Inflow:Math.round(v).toLocaleString()})));
}

function parseEnqueueJSON(rows){
  enqueueData={};let ok=0;
  rows.forEach(r=>{
    const ds=String(r.date||r.Date||'').trim();
    const arr=Array.from({length:24},(_,h)=>parseFloat(r['h'+h]||r['H'+h]||0));
    if(ds&&arr.some(v=>v>0)){enqueueData[ds]=arr;ok++;}
  });
  setStatus('enqueue',`✅ Loaded ${ok} days from Google Sheets`,'ok');
  const prev=Object.entries(enqueueData).slice(0,3).map(([d,arr])=>({Date:d,'h0':(arr[0]*100).toFixed(1)+'%','h9':(arr[9]*100).toFixed(1)+'%','h12':(arr[12]*100).toFixed(1)+'%','h18':(arr[18]*100).toFixed(1)+'%','…':'…'}));
  renderPreview('enqueue',prev);
}

async function refreshAllSheets(){
  let fetched=0;
  if(window._sheetUrlInflow){document.getElementById('sheetUrlInflow').value=window._sheetUrlInflow;await fetchSheetData('inflow');fetched++;}
  if(window._sheetUrlEnqueue){document.getElementById('sheetUrlEnqueue').value=window._sheetUrlEnqueue;await fetchSheetData('enqueue');fetched++;}
  if(!fetched)setStatus('inflow','⚠ No Sheet URL saved yet','err');
}

// ── HISTORICAL DATA (dùng cho AI dự đoán peak-inflow) ────────────────────────
// Lấy từ cùng Spreadsheet đang dùng cho Inflow, tab "Historical Data" (dạng wide, xem readHistoricalWide bên server)
async function fetchHistoricalData(){
  const raw = window._sheetUrlInflow;
  if(!raw) return;
  let spreadsheetId='';
  const m=raw.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if(m) spreadsheetId=m[1];
  else if(/^[a-zA-Z0-9_-]{20,}$/.test(raw)) spreadsheetId=raw;
  if(!spreadsheetId) return;
  try{
    const res=await fetch(`/api/fetch-sheet?type=historical&spreadsheetId=${encodeURIComponent(spreadsheetId)}&sheet=${encodeURIComponent('Historical Data')}`);
    const json=await res.json();
    if(res.ok && Array.isArray(json)) historicalData=json;
  }catch(err){
    console.error('fetchHistoricalData error:', err.message);
  }
}

// Tìm ngày lịch sử gần nhất cùng loại event
function getLastSameEventHistory(eventType){
  const matches=historicalData.filter(c=>c.event===eventType);
  if(!matches.length) return null;
  matches.sort((a,b)=>parseDateStr(b.date)-parseDateStr(a.date));
  return matches[0];
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

// Hiển thị khung giờ (in-break-out) của ca — CHỈ dùng cho UI, không ảnh hưởng dữ liệu export.
// FT có break: "(start-break-end)". FT/PT không break: "(start-end)".
function shiftTimeLabel(s){
  const startH = s.start % 24;
  if(s.cost === 1){
    const endH = (s.start + 9) % 24;
    let brkH = null;
    for(let i=0;i<9;i++){
      const abs = s.start + i;
      if(!s.slots.some(sl => sl.abs === abs)){ brkH = abs % 24; break; }
    }
    return brkH !== null ? `(${startH}-${brkH}-${endH})` : `(${startH}-${endH})`;
  }
  const endH = (s.start + 4) % 24;
  return `(${startH}-${endH})`;
}

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

// ── PT → FT CONSOLIDATION ────────────────────────────────────────────────────
// ── PT → FT CONSOLIDATION (CÙNG NGÀY) ────────────────────────────────────────
const PT_MERGE_RULES = [
  {a:'P12',b:'P6', ft:'S0'},
  {a:'P11',b:'P2', ft:'S1'},
  {a:'P10',b:'P15',ft:'S3'},
  {a:'P7', b:'P8', ft:'S4'},
  {a:'P2', b:'P14',ft:'S5'},
  {a:'P15',b:'P4', ft:'S7'},
  {a:'P8', b:'P16',ft:'S9'},
  {a:'P13',b:'P17',ft:'S10'},
  {a:'P14',b:'P9', ft:'S11'},
];

function validateMerge(ptA, ptB, ftShift) {
  const aHrs = new Set(ptA.hrs_today);
  const bHrs = new Set(ptB.hrs_today);
  const ftHrs = new Set(ftShift.hrs_today);
  const union = new Set([...aHrs, ...bHrs]);
  let match = 0;
  union.forEach(h => { if(ftHrs.has(h)) match++; });
  return match >= Math.min(union.size, ftHrs.size) - 1;
}

function consolidatePTtoFT(sc) {
  const result = JSON.parse(JSON.stringify(sc));
  for(const rule of PT_MERGE_RULES) {
    const ptA = ALL_SHIFTS.find(s=>s.name===rule.a);
    const ptB = ALL_SHIFTS.find(s=>s.name===rule.b);
    const ft  = ALL_SHIFTS.find(s=>s.name===rule.ft);
    if(!ptA||!ptB||!ft) continue;
    if(!validateMerge(ptA,ptB,ft)) continue;
    const pairs = Math.min(result[rule.a]||0, result[rule.b]||0);
    if(pairs <= 0) continue;
    result[rule.a] -= pairs;
    result[rule.b] -= pairs;
    result[rule.ft] = (result[rule.ft]||0) + pairs;
  }
  return result;
}

// ── PT → FT CONSOLIDATION (LIÊN NGÀY) ────────────────────────────────────────
const CROSS_DAY_S6_RULE  = {a:'P17',b:'P19',ft:'S6'};  // Ưu tiên #1 — tranh P17 với rule cùng-ngày S10
const CROSS_DAY_S12_RULE = {a:'P3', b:'P5', ft:'S12'}; // Ưu tiên cuối cùng, xử lý sau các rule khác

function validateCrossDayMerge(ptA, ptB, ftShift){
  const aHrs  = new Set([...ptA.hrs_today.map(h=>'0_'+h), ...ptA.hrs_next.map(h=>'1_'+h)]);
  const bHrs  = new Set(ptB.hrs_today.map(h=>'1_'+h));
  const ftHrs = new Set([...ftShift.hrs_today.map(h=>'0_'+h), ...ftShift.hrs_next.map(h=>'1_'+h)]);
  const union = new Set([...aHrs, ...bHrs]);
  let match = 0;
  union.forEach(h => { if(ftHrs.has(h)) match++; });
  return match >= Math.min(union.size, ftHrs.size) - 1;
}

// Tính lại coverage/carryOut/HC của 1 ngày sau khi shiftCounts bị chỉnh sửa bởi merge
function recomputeDay(d){
  const wd=weekData[d], e=wd.opt;
  e.coverage       = calcCoverage(e.shiftCounts, wd.carryIn);
  e.carryOut       = calcCarryOut(e.shiftCounts);
  e.totalInflow    = wd.hourInflows.reduce((a,b)=>a+b,0);
  e.totalCompleted = dailyTask(e.coverage, wd.hourInflows);
  e.coverage_pct   = e.totalCompleted/e.totalInflow;
  e.abandon_pct    = Math.max(0,(e.totalInflow-e.totalCompleted)/e.totalInflow);
  let ft=0,pt=0;
  SHIFTS_FT.forEach(s=>ft+=e.shiftCounts[s.name]||0);
  SHIFTS_PT.forEach(s=>pt+=e.shiftCounts[s.name]||0);
  e.ft=ft; e.pt=pt; e.weightedHC=ft+pt/2;
}

// Gộp 1 rule liên-ngày cho toàn bộ tuần — dùng chung cho cả S6 và S12
function applyCrossDayRule(rule){
  const ptA=ALL_SHIFTS.find(s=>s.name===rule.a);
  const ptB=ALL_SHIFTS.find(s=>s.name===rule.b);
  const ft =ALL_SHIFTS.find(s=>s.name===rule.ft);
  if(!ptA||!ptB||!ft) return;
  if(!validateCrossDayMerge(ptA,ptB,ft)) return;
  for(let d=0; d<weekData.length-1; d++){
    const dayD=weekData[d].opt, dayD1=weekData[d+1].opt;
    const pairs = Math.min(dayD.shiftCounts[rule.a]||0, dayD1.shiftCounts[rule.b]||0);
    if(pairs<=0) continue;
    dayD.shiftCounts[rule.a]  -= pairs;
    dayD1.shiftCounts[rule.b] -= pairs;
    dayD.shiftCounts[rule.ft] = (dayD.shiftCounts[rule.ft]||0) + pairs;
    recomputeDay(d);
    weekData[d+1].carryIn = [...dayD.carryOut];   // carryOut mới của ngày D → carryIn của ngày D+1
    recomputeDay(d+1);
  }
}

// ── ORCHESTRATOR — thứ tự ưu tiên gộp ca ──────────────────────────────────────
// (1) Cross-day S6 trước tiên  →  (2) 9 rule cùng-ngày  →  (3) Cross-day S12 sau cùng
function applyAllMerges(){
  applyCrossDayRule(CROSS_DAY_S6_RULE);
  weekData.forEach(w=>{ w.opt.shiftCounts = consolidatePTtoFT(w.opt.shiftCounts); });
  applyCrossDayRule(CROSS_DAY_S12_RULE);
  weekData.forEach((w,d)=>recomputeDay(d)); // đồng bộ lại ft/pt/weightedHC toàn tuần
}
function optimize(inflows,carryIn,target){
  const totalInflow=inflows.reduce((a,b)=>a+b,0);
  const targetTask=totalInflow*(target!==undefined?target:TARGET);
  const ac={};ALL_SHIFTS.forEach(s=>ac[s.name]=0);
  const cov=new Array(24).fill(0);
  if(carryIn)for(let h=0;h<24;h++)cov[h]+=carryIn[h]||0;

  // MIN STAFFING FLOOR: mỗi ngày tối thiểu 1 nhân sự ca S6 (overnight)
  // Chỉ ép thêm nếu carry-in từ hôm trước CHƯA đủ phủ ≥1 HC tại cả 2 khung 22h-23h
  const s6=ALL_SHIFTS.find(s=>s.name==='S6');
  if(s6){
    const s6CarryOk = s6.hrs_today.every(h=>(cov[h]||0) >= 1);
    if(!s6CarryOk){
      ac[s6.name]=1;
      s6.hrs_today.forEach(h=>cov[h]++);
    }
  }

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
  const d=parseInt(p[0]),m=parseInt(p[1]),y=parseInt(p[2]);
  if(d===m)return 'Spike';
  const nextDt=new Date(y,m-1,d);nextDt.setDate(nextDt.getDate()+1);
  if(nextDt.getDate()===nextDt.getMonth()+1)return 'Spike-1';
  if(d===14)return '14th';if(d===15)return '15th';if(d===24)return '24th';if(d===25)return '25th';
  if(dow===6)return 'Sat';if(dow===0)return 'Sun';return 'Normal';
}
function parseDateStr(ds){const p=ds.trim().split('.');return new Date(parseInt(p[2]),parseInt(p[1])-1,parseInt(p[0]));}
function formatDate(dt){return`${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.${dt.getFullYear()}`;}
function addDays(ds,n){const dt=parseDateStr(ds);dt.setDate(dt.getDate()+n);return formatDate(dt);}
function getDOW(ds){return parseDateStr(ds).getDay();}

const DOW_LABELS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOW_VN=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const EVT_COLORS={Normal:{bg:'rgba(52,216,158,.15)',text:'#34d89e'},Spike:{bg:'rgba(255,91,91,.15)',text:'#ff5b5b'},'Spike-1':{bg:'rgba(255,180,50,.15)',text:'#ffb432'},'14th':{bg:'rgba(91,143,255,.15)',text:'#5b8fff'},'15th':{bg:'rgba(91,143,255,.15)',text:'#5b8fff'},'24th':{bg:'rgba(200,100,200,.15)',text:'#c864c8'},'25th':{bg:'rgba(200,100,200,.15)',text:'#c864c8'},Sat:{bg:'rgba(255,255,255,.06)',text:'#8b90a8'},Sun:{bg:'rgba(255,255,255,.06)',text:'#8b90a8'}};

function getTargetFor(event){
  const v=EVENT_TARGETS[event];
  return (v!==null&&v!==undefined&&!isNaN(v))?v:TARGET;
}

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
    const eventTarget=getTargetFor(event);
    const opt=optimize(hourInflows,prevCarryOut,eventTarget);
    weekData.push({d:idx,dateStr:ds,dow,event,inflow,hourInflows,enq,opt,carryIn:[...prevCarryOut],dowLabel:DOW_LABELS[dow],eventTarget});
    prevCarryOut=opt.carryOut; manualShift[idx]=null;
  });
  applyAllMerges();
  populateSelects(); renderWeekGrid(); renderDayDetail(); renderShiftBreakdown(); renderTrend(); renderWorkMode();
}

function populateSelects(){
  ['daySelect','shiftDaySelect'].forEach(id=>{
    const sel=document.getElementById(id); sel.innerHTML='';
    weekData.forEach(wd=>{const o=document.createElement('option');o.value=wd.d;o.textContent=`${wd.dowLabel} ${wd.dateStr}`;sel.appendChild(o);});
  });
}
function getEff(d){return manualShift[d]||weekData[d].opt;}

// Tách coverage theo loại ca (FT/PT) cho từng giờ — dùng cho Heatmap.
// Carry-in từ ngày trước cũng được tách loại dựa trên shiftCounts thực tế của ngày trước đó.
function getCoverageByType(d){
  const covFT=new Array(24).fill(0), covPT=new Array(24).fill(0);
  if(d>0){
    const prevSc=getEff(d-1).shiftCounts;
    SHIFTS_FT.forEach(s=>{const n=prevSc[s.name]||0; if(n>0) s.hrs_next.forEach(h=>covFT[h]+=n);});
    SHIFTS_PT.forEach(s=>{const n=prevSc[s.name]||0; if(n>0) s.hrs_next.forEach(h=>covPT[h]+=n);});
  }
  const sc=getEff(d).shiftCounts;
  SHIFTS_FT.forEach(s=>{const n=sc[s.name]||0; if(n>0) s.hrs_today.forEach(h=>covFT[h]+=n);});
  SHIFTS_PT.forEach(s=>{const n=sc[s.name]||0; if(n>0) s.hrs_today.forEach(h=>covPT[h]+=n);});
  return {covFT, covPT};
}

// ── RENDER WEEK ────────────────────────────────────────────────────────────────
function renderWeekGrid(){
  const g=document.getElementById('weekGrid');
  g.innerHTML='';g.style.gridTemplateColumns='';

  const pivot=document.getElementById('weekPivot');
  if(!pivot)return;

  const evtColors={Normal:'#059669',Spike:'#dc2626','Spike-1':'#d97706','14th':'#2563eb','15th':'#2563eb','24th':'#7c3aed','25th':'#7c3aed',Sat:'#6b7280',Sun:'#6b7280'};

  let thead=`<thead>
    <tr class="pw-event">
      <th class="pw-label-col"></th>
      ${weekData.map(wd=>{const c=evtColors[wd.event]||'#6b7280';return`<th style="color:${c}">${wd.event}</th>`;}).join('')}
    </tr>
    <tr class="pw-dow">
      <th class="pw-label-col"></th>
      ${weekData.map(wd=>`<th>${wd.dowLabel}</th>`).join('')}
    </tr>
    <tr class="pw-date">
      <th class="pw-label-col"></th>
      ${weekData.map(wd=>`<th>${wd.dateStr}</th>`).join('')}
    </tr>
  </thead>`;

  const summaryRows=[
    {label:'Inflow', fn:wd=>Math.round(getEff(wd.d).totalInflow).toLocaleString(), cls:'pw-inflow'},
    {label:'Total HC Order (KF)', fn:wd=>getEff(wd.d).weightedHC.toFixed(1), cls:'pw-hc'},
    {label:'%Task Coverage (KF)', fn:wd=>{const e=getEff(wd.d);const ok=e.coverage_pct>=wd.eventTarget;return`<span style="color:${ok?'var(--success)':'var(--danger)'}">${(e.coverage_pct*100).toFixed(1)}%</span>`;}, cls:'pw-cov'},
  ];

  let tbody=`<tbody>`;
  summaryRows.forEach(r=>{
    tbody+=`<tr class="${r.cls}"><td class="pw-label-col">${r.label}</td>${weekData.map(wd=>`<td>${r.fn(wd)}</td>`).join('')}</tr>`;
  });

  tbody+=`<tr class="pw-section-hdr"><td class="pw-label-col">Breakdown by hour</td>${weekData.map(()=>'<td></td>').join('')}</tr>`;

  for(let h=0;h<24;h++){
    const cells=weekData.map(wd=>{
      const e=getEff(wd.d);
      const cov=e.coverage[h]||0;
      return`<td>${cov.toFixed(1)}</td>`;
    }).join('');
    tbody+=`<tr class="pw-hour"><td class="pw-label-col pw-hour-label">${h}:00</td>${cells}</tr>`;
  }

  tbody+=`</tbody>`;

  pivot.innerHTML=thead+tbody;

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

  if(weekChart)weekChart.destroy();weekChart=null;

  renderAIInsight('week', buildWeekContext());
}

function selectDay(d){
  document.getElementById('daySelect').value=d;
  document.getElementById('shiftDaySelect').value=d;
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

  const et=wd.eventTarget;
  document.getElementById('dayMetrics').innerHTML=`
    <div class="kpi-card"><div class="kpi-label">Optimized HC</div><div class="kpi-value kv-good">${e.weightedHC.toFixed(1)}</div><div class="kpi-sub">FT ${e.ft} · PT ${e.pt} (×½)</div></div>
    <div class="kpi-card"><div class="kpi-label">HC @ 100% baseline</div><div class="kpi-value kv-dim">${naive}</div><div class="kpi-sub">saved ${saved>0?saved.toFixed(1)+' HC':'–'}</div></div>
    <div class="kpi-card"><div class="kpi-label">%Task Coverage</div><div class="kpi-value ${e.coverage_pct>=et?'kv-good':'kv-bad'}">${(e.coverage_pct*100).toFixed(1)}%</div><div class="kpi-sub">target ≥ ${(et*100).toFixed(1)}%</div></div>
    <div class="kpi-card"><div class="kpi-label">%Abandon</div><div class="kpi-value ${e.abandon_pct<1-et?'kv-good':'kv-bad'}">${(e.abandon_pct*100).toFixed(1)}%</div><div class="kpi-sub">daily level</div></div>`;

  const enqSrc=enqueueData[wd.dateStr]?'uploaded':'default ('+wd.event+')';
  document.getElementById('dayInfo').innerHTML=
    `<strong>${wd.dateStr} · ${DOW_VN[wd.dow]} · ${wd.event}</strong>&nbsp;&nbsp;|&nbsp;&nbsp;
     AHT <strong>${document.getElementById('ahtInput').value}s</strong> · Util <strong>${document.getElementById('utilInput').value}%</strong> · HourProd <strong>${HOUR_PROD.toLocaleString()}</strong>&nbsp;&nbsp;|&nbsp;&nbsp;
     Inflow <strong>${Math.round(wd.inflow).toLocaleString()}</strong> · Target (${(et*100).toFixed(1)}%) <strong>${Math.round(wd.inflow*et).toLocaleString()}</strong> · Completed <strong>${Math.round(e.totalCompleted).toLocaleString()}</strong>&nbsp;&nbsp;|&nbsp;&nbsp;
     %Enqueue: <strong>${enqSrc}</strong>${carryTotal>0?`&nbsp;&nbsp;|&nbsp;&nbsp;Carry-in: <span class="carry-tag">${carryTotal} agent-hrs</span>`:''}`;

  const canEdit = currentRole==='owner'||currentRole==='editor';
  document.getElementById('dayTbody').innerHTML=wd.hourInflows.map((inf,h)=>{
    const cov=e.coverage[h]||0,carryH=wd.carryIn[h]||0;
    // Hourly Agent Capacity = Hourly HC Order (cov) × Hourly Prod (HOUR_PROD)
    const agentCapacity=cov*HOUR_PROD;
    const task=Math.min(agentCapacity,inf),ab=Math.max(inf-agentCapacity,0);
    const covPct=inf>0?task/inf:1,abPct=inf>0?ab/inf:0;
    const prodPct=agentCapacity>0?task/agentCapacity:(inf>0?0:1);
    const kpiOk=covPct>=et;
    const kpi=cov===0&&inf===0?`<span class="badge badge-gray">–</span>`:kpiOk?`<span class="badge badge-green">✓ OK</span>`:covPct>=0.7?`<span class="badge badge-amber">⚠ Low</span>`:`<span class="badge badge-red">✗ Miss</span>`;
    return`<tr>
      <td><strong>${h}:00</strong></td>
      <td>${(wd.enq[h]*100).toFixed(2)}%</td>
      <td>${Math.round(inf).toLocaleString()}</td>
      <td><span class="badge badge-blue">${cov}</span>${carryH>0?`<span class="carry-tag">+${carryH}↩</span>`:''}</td>
      <td>${Math.round(task).toLocaleString()}</td>
      <td><span class="badge ${covPct>=et?'badge-green':covPct>=0.7?'badge-amber':'badge-red'}">${(covPct*100).toFixed(1)}%</span></td>
      <td><span class="badge ${prodPct>=0.95?'badge-green':'badge-red'}">${(prodPct*100).toFixed(1)}%</span></td>
      <td><span class="badge ${abPct<1-et?'badge-green':abPct<0.3?'badge-amber':'badge-red'}">${(abPct*100).toFixed(1)}%</span></td>
      <td>${kpi}</td>
    </tr>`;
  }).join('');

  showAIInsightPrompt('day');
}

// ── RENDER SHIFT PIVOT ────────────────────────────────────────────────────────
function renderShiftBreakdown(){
  if(!weekData.length)return;
  const d=parseInt(document.getElementById('shiftDaySelect').value);
  if(!weekData[d])return;
  const wd=weekData[d],e=getEff(d);

  document.getElementById('shiftMetrics').innerHTML=`
    <div class="kpi-card"><div class="kpi-label">Total HC Order</div><div class="kpi-value kv-good">${e.weightedHC.toFixed(1)}</div><div class="kpi-sub">FT ${e.ft} · PT ${e.pt} (×½)</div></div>
    <div class="kpi-card"><div class="kpi-label">Fulltime</div><div class="kpi-value" style="color:var(--accent)">${e.ft}</div></div>
    <div class="kpi-card"><div class="kpi-label">Parttime</div><div class="kpi-value" style="color:var(--accent2)">${e.pt}</div><div class="kpi-sub">×½ in HC formula</div></div>
    <div class="kpi-card"><div class="kpi-label">Coverage (daily)</div><div class="kpi-value ${e.coverage_pct>=wd.eventTarget?'kv-good':'kv-bad'}">${(e.coverage_pct*100).toFixed(1)}%</div><div class="kpi-sub">target ≥ ${(wd.eventTarget*100).toFixed(1)}%</div></div>`;

  const coTotal=e.carryOut.reduce((a,b)=>a+b,0);
  document.getElementById('shiftInfo').innerHTML=
    `<strong>${wd.dateStr} · ${DOW_VN[wd.dow]}</strong>&nbsp;&nbsp;|&nbsp;&nbsp;`+
    (coTotal>0?`Carry-over → ${addDays(wd.dateStr,1)}: <span class="carry-tag">${e.carryOut.map((v,h)=>v>0?h+'('+v+')':'').filter(Boolean).join(' ')}</span>`:'No carry-over to next day.');

  const pivot=document.getElementById('shiftPivot');
  if(!pivot)return;

  const evtColors={Normal:'#059669',Spike:'#dc2626','Spike-1':'#d97706','14th':'#2563eb','15th':'#2563eb','24th':'#7c3aed','25th':'#7c3aed',Sat:'#6b7280',Sun:'#6b7280'};

  const activeShifts=new Set();
  weekData.forEach(w=>{
    const sc=getEff(w.d).shiftCounts;
    ALL_SHIFTS.forEach(s=>{if((sc[s.name]||0)>0)activeShifts.add(s.name);});
  });

  let thead=`<thead>
    <tr class="pw-event">
      <th class="pw-label-col"></th>
      ${weekData.map(w=>{const c=evtColors[w.event]||'#6b7280';return`<th style="color:${c}">${w.event}</th>`;}).join('')}
    </tr>
    <tr class="pw-dow"><th class="pw-label-col"></th>${weekData.map(w=>`<th>${w.dowLabel}</th>`).join('')}</tr>
    <tr class="pw-date"><th class="pw-label-col"></th>${weekData.map(w=>`<th>${w.dateStr}</th>`).join('')}</tr>
  </thead>`;

  let tbody=`<tbody>
    <tr class="pw-inflow"><td class="pw-label-col">Inflow</td>${weekData.map(w=>`<td>${Math.round(getEff(w.d).totalInflow).toLocaleString()}</td>`).join('')}</tr>
    <tr class="pw-hc"><td class="pw-label-col">Total HC Order</td>${weekData.map(w=>`<td>${getEff(w.d).weightedHC.toFixed(1)}</td>`).join('')}</tr>
    <tr class="pw-cov"><td class="pw-label-col">%Task Coverage (KF)</td>${weekData.map(w=>{const e2=getEff(w.d);const ok=e2.coverage_pct>=w.eventTarget;return`<td><span style="color:${ok?'var(--success)':'var(--danger)'}">${(e2.coverage_pct*100).toFixed(1)}%</span></td>`;}).join('')}</tr>
    <tr class="pw-section-hdr"><td class="pw-label-col">Breakdown by Shift</td>${weekData.map(()=>'<td></td>').join('')}</tr>`;

 const activeFT=SHIFTS_FT.filter(s=>activeShifts.has(s.name));
  if(activeFT.length){
    tbody+=`<tr class="pw-shift-group"><td class="pw-label-col pw-shift-type-label">F (Fulltime)</td>${weekData.map(()=>'<td></td>').join('')}</tr>`;
    activeFT.forEach(s=>{
      const cells=weekData.map(w=>{
        const n=getEff(w.d).shiftCounts[s.name]||0;
        return`<td style="font-weight:400">${n>0?n.toFixed(1):''}</td>`;
      }).join('');
      tbody+=`<tr class="pw-shift"><td class="pw-label-col" style="font-family:var(--mono);font-size:11px;font-weight:400;color:var(--text2)">${s.name} <span style="color:var(--text4);font-size:9px">${shiftTimeLabel(s)}</span></td>${cells}</tr>`;
    });
  }

  const activePT=SHIFTS_PT.filter(s=>activeShifts.has(s.name));
  if(activePT.length){
    tbody+=`<tr class="pw-shift-group"><td class="pw-label-col pw-shift-type-label">P (Parttime)</td>${weekData.map(()=>'<td></td>').join('')}</tr>`;
    activePT.forEach(s=>{
      const cells=weekData.map(w=>{
        const n=getEff(w.d).shiftCounts[s.name]||0;
        return`<td style="font-weight:400">${n>0?n.toFixed(1):''}</td>`;
      }).join('');
      tbody+=`<tr class="pw-shift"><td class="pw-label-col" style="font-family:var(--mono);font-size:11px;font-weight:400;color:var(--text2)">${s.name} <span style="color:var(--text4);font-size:9px">${shiftTimeLabel(s)}</span></td>${cells}</tr>`;
    });
  }

  tbody+=`</tbody>`;
  pivot.innerHTML=thead+tbody;

  renderShiftHeatmap();
  renderAbandonWarnings();
  showAIInsightPrompt('shift');
}

// ── HEATMAP: Mật độ nhân sự theo giờ × ngày ──────────────────────────────────
// ── HEATMAP: Mật độ nhân sự theo giờ × ngày ──────────────────────────────────
function renderShiftHeatmap(){
  const wrap=document.getElementById('shiftHeatmapWrap');
  if(!wrap||!weekData.length)return;

  const perDay=weekData.map(w=>getCoverageByType(w.d));
  const colW=Math.max(72, Math.floor((wrap.offsetWidth-70)/Math.max(weekData.length,1)));

  // Tính mật độ tối đa toàn bảng (FT+PT) để chuẩn hoá heat gradient
  let maxTotal=0;
  perDay.forEach(p=>{for(let h=0;h<24;h++){const t=(p.covFT[h]||0)+(p.covPT[h]||0);if(t>maxTotal)maxTotal=t;}});
  maxTotal=maxTotal||1;

  const ALPHA_MIN=0.04, ALPHA_MAX=0.42;
  function heatBg(total){
    if(total<=0)return '#fff';
    const a=ALPHA_MIN+(total/maxTotal)*(ALPHA_MAX-ALPHA_MIN);
    return `rgba(37,99,235,${a.toFixed(3)})`;
  }

  let html=`<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:12px;padding:8px 4px;border-bottom:1px solid var(--border)">
    <span style="font-size:12px;color:var(--text3);font-weight:700">Legend</span>
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--text2)">
      <span style="width:14px;height:14px;border-radius:3px;background:#2563eb;display:inline-block"></span> Full-time
    </span>
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--text2)">
      <span style="width:14px;height:14px;border-radius:3px;background:#f59e0b;display:inline-block"></span> Part-time
    </span>
    <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--text2)">
      <span style="width:70px;height:12px;border-radius:3px;background:linear-gradient(90deg, rgba(37,99,235,${ALPHA_MIN}), rgba(37,99,235,${ALPHA_MAX}));border:1px solid var(--border)"></span>
      Mật độ nhân sự (thấp → cao)
    </span>
  </div>`;

  html+=`<div class="heatmap-scroll"><table class="heatmap-table">
    <thead><tr><th class="hm-label-col">Hour</th>
    ${weekData.map(w=>`<th style="min-width:${colW}px"><div style="font-size:10px;color:#7c84a3;font-weight:700">${w.dowLabel}</div><div style="font-size:9px;color:#a8afc8">${w.dateStr.slice(0,5)}</div></th>`).join('')}
    </tr></thead><tbody>`;

  for(let h=0;h<24;h++){
    html+=`<tr><td class="hm-label-col">${String(h).padStart(2,'0')}:00</td>`;
    weekData.forEach((_,di)=>{
      const ft=perDay[di].covFT[h]||0, pt=perDay[di].covPT[h]||0, total=ft+pt;
      const bg=heatBg(total);
      let inner='';
      if(total>0){
        const ftPct=(ft/total)*100, ptPct=(pt/total)*100;
        inner=`<div class="hm-cell">
          <div class="hm-bar">
            ${ft>0?`<div class="hm-bar-ft" style="width:${ftPct}%"></div>`:''}
            ${pt>0?`<div class="hm-bar-pt" style="width:${ptPct}%"></div>`:''}
          </div>
          <div class="hm-nums">
            ${ft>0?`<span class="hm-num-ft">${ft}F</span>`:''}
            ${pt>0?`<span class="hm-num-pt">${pt}P</span>`:''}
          </div>
        </div>`;
      }
      html+=`<td style="background:${bg};padding:5px 4px;border:1px solid rgba(0,0,0,.05)" title="${total>0?`FT: ${ft} · PT: ${pt} · Total: ${total}`:'No coverage'}">${inner}</td>`;
    });
    html+=`</tr>`;
  }
  html+=`</tbody></table></div>`;

  wrap.innerHTML=html;
}
// ── WORK MODE LOGIC ───────────────────────────────────────────────────────────
function getShiftEndHour(s){
  if(s.brk!==null){
    const endAbs=s.start+9; return endAbs%24;
  } else {
    const endAbs=s.start+4; return endAbs%24;
  }
}
function isWFH(s){
  const isFT = s.cost===1;
  const endH = getShiftEndHour(s);
  const endAfter19 = (endH>=20 && endH<=23) || (endH>=0 && endH<=8);
  if(isFT && (s.start%24) > 12) return true;
  if(endAfter19) return true;
  return false;
}

function buildWorkModeData(){
  return weekData.map(w=>{
    const sc=getEff(w.d).shiftCounts;
    let wfh=0,floor=0;
    const wfhShifts=[],floorShifts=[];
    ALL_SHIFTS.forEach(s=>{
      const n=sc[s.name]||0; if(!n)return;
      if(isWFH(s)){ wfh+=n; wfhShifts.push(s.name); }
      else { floor+=n; floorShifts.push(s.name); }
    });
    return{dateStr:w.dateStr,dowLabel:w.dowLabel,event:w.event,
      wfh:+(wfh.toFixed(1)),floor:+(floor.toFixed(1)),total:+(wfh+floor).toFixed(1),
      wfhShifts,floorShifts};
  });
}

// ── RENDER WORK MODE ──────────────────────────────────────────────────────────
let workChart=null;
function renderWorkMode(){
  if(!weekData.length)return;
  const data=buildWorkModeData();

  const totalWfh=data.reduce((s,d)=>s+d.wfh,0);
  const totalFloor=data.reduce((s,d)=>s+d.floor,0);
  const pctWfh=totalWfh/(totalWfh+totalFloor||1)*100;
  document.getElementById('workModeKPI').innerHTML=`
    <div class="kpi-card"><div class="kpi-label">Total WFH (HC)</div><div class="kpi-value" style="color:#7c3aed">${totalWfh.toFixed(1)}</div><div class="kpi-sub">Shifts ending after 19:00 or FT from 13:00</div></div>
    <div class="kpi-card"><div class="kpi-label">Total On-Floor (HC)</div><div class="kpi-value" style="color:#059669">${totalFloor.toFixed(1)}</div><div class="kpi-sub">Remaining shifts</div></div>
    <div class="kpi-card"><div class="kpi-label">WFH Rate</div><div class="kpi-value" style="color:#2563eb">${pctWfh.toFixed(1)}%</div><div class="kpi-sub">Over total weekly HC</div></div>
    <div class="kpi-card"><div class="kpi-label">Days with WFH</div><div class="kpi-value kv-neutral">${data.filter(d=>d.wfh>0).length}</div><div class="kpi-sub">/ ${data.length} days</div></div>`;

  if(workChart){workChart.destroy();workChart=null;}
  const wmCanvas=document.getElementById('workModeChart');
  const wmParent=wmCanvas.parentNode;
  const wmNew=document.createElement('canvas');
  wmNew.id='workModeChart';
  wmParent.replaceChild(wmNew,wmCanvas);

  workChart=new Chart(wmNew,{
    type:'bar',
    data:{
      labels:data.map(d=>`${d.dowLabel} ${d.dateStr.slice(0,5)}`),
      datasets:[
        {label:'🏠 WFH',data:data.map(d=>d.wfh),backgroundColor:'rgba(124,58,237,.75)',borderRadius:3,stack:'s'},
        {label:'🏢 On-Floor',data:data.map(d=>d.floor),backgroundColor:'rgba(5,150,105,.7)',borderRadius:3,stack:'s'}
      ]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      plugins:{
        legend:{labels:{font:{size:12},color:'#3d4766',boxWidth:14,padding:16}},
        tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} HC`}},
        datalabels:{
          display:ctx=>ctx.dataset.data[ctx.dataIndex]>0,
          color:'#fff',
          font:{size:10,weight:'700'},
          anchor:'center',
          align:'center',
          formatter:(v,ctx)=> ctx.datasetIndex===0 ? `${v.toFixed(1)} 🏠` : `${v.toFixed(1)} 🏢`
        }
      },
      scales:{
        x:{stacked:true,ticks:{color:'#7c84a3',font:{size:11},maxRotation:30},grid:{display:false}},
        y:{stacked:true,beginAtZero:true,ticks:{color:'#7c84a3'},grid:{color:'rgba(0,0,0,.05)'}}
      }
    }
  });

  // Cùng bảng màu event với Weekly Overview / pivot-week (đồng bộ toàn hệ thống)
  const evtColorsWM={Normal:'#059669',Spike:'#dc2626','Spike-1':'#d97706','14th':'#2563eb','15th':'#2563eb','24th':'#7c3aed','25th':'#7c3aed',Sat:'#6b7280',Sun:'#6b7280'};

  document.getElementById('workModeTable').innerHTML=`
    <table class="data-table"><thead><tr>
      <th>Date</th><th>Day</th><th>Event</th>
      <th>WFH (HC)</th><th>On-Floor (HC)</th><th>Total</th><th>% WFH</th>
    </tr></thead><tbody>
    ${data.map(d=>{
      const pct=d.total>0?(d.wfh/d.total*100).toFixed(1):'0.0';
      const c=evtColorsWM[d.event]||'#6b7280';
      const wfhList=d.wfhShifts.length?` <span style="color:var(--text3);font-weight:400;font-size:11px">(${d.wfhShifts.join(',')})</span>`:'';
      const floorList=d.floorShifts.length?` <span style="color:var(--text3);font-weight:400;font-size:11px">(${d.floorShifts.join(',')})</span>`:'';
      return`<tr>
        <td>${d.dateStr}</td><td>${d.dowLabel}</td>
        <td><strong style="color:${c}">${d.event}</strong></td>
        <td style="color:#7c3aed;font-weight:600">${d.wfh}${wfhList}</td>
        <td style="color:#059669;font-weight:600">${d.floor}${floorList}</td>
        <td>${d.total}</td>
        <td><span class="badge ${parseFloat(pct)>50?'badge-blue':'badge-green'}">${pct}%</span></td>
      </tr>`;
    }).join('')}
    </tbody></table>`;

  renderAIInsight('workmode', buildWorkModeContext(data));
}

// ── RENDER TREND REPORT ───────────────────────────────────────────────────────
let trendChart1=null,trendChart2=null,trendChart3=null;
function renderTrend(){
  if(!weekData.length)return;
  const labels=weekData.map(w=>`${w.dowLabel} ${w.dateStr.slice(0,5)}`);
  const inflows=weekData.map(w=>Math.round(w.inflow));
  const hcs=weekData.map(w=>+getEff(w.d).weightedHC.toFixed(1));
  const covs=weekData.map(w=>+(getEff(w.d).coverage_pct*100).toFixed(1));
  const targets=weekData.map(w=>+(w.eventTarget*100).toFixed(1));

  const commonOpts=(yLabel)=>({responsive:true,maintainAspectRatio:false,
    plugins:{legend:{labels:{font:{size:11},color:'#3d4766',boxWidth:12}}},
    scales:{
      x:{ticks:{color:'#7c84a3',font:{size:10},maxRotation:30},grid:{display:false}},
      y:{beginAtZero:false,title:{display:true,text:yLabel,color:'#7c84a3',font:{size:10}},
        ticks:{color:'#7c84a3'},grid:{color:'rgba(0,0,0,.05)'}}
    }});

  if(trendChart1)trendChart1.destroy();
  trendChart1=new Chart(document.getElementById('trendChart1'),{
    type:'line',
    data:{labels,datasets:[{label:'Inflow (tasks)',data:inflows,borderColor:'#2563eb',backgroundColor:'rgba(37,99,235,.08)',fill:true,tension:.35,pointRadius:4,pointBackgroundColor:'#2563eb'}]},
    options:{...commonOpts('Inflow'),plugins:{...commonOpts('Inflow').plugins,
      datalabels:{display:true,align:'top',anchor:'end',color:'#2563eb',font:{size:9,weight:'500'},
        formatter:v=>v>=1000?(v/1000).toFixed(1)+'k':v}}}
  });

  if(trendChart2)trendChart2.destroy();
  trendChart2=new Chart(document.getElementById('trendChart2'),{
    type:'line',
    data:{labels,datasets:[
      {label:'HC Order (FT+PT/2)',data:hcs,borderColor:'#7c3aed',backgroundColor:'rgba(124,58,237,.08)',fill:true,tension:.35,pointRadius:4,pointBackgroundColor:'#7c3aed'}
    ]},
    options:{...commonOpts('HC Order'),plugins:{...commonOpts('HC Order').plugins,
      datalabels:{display:true,align:'top',anchor:'end',color:'#7c3aed',font:{size:9,weight:'500'},
        formatter:v=>v.toFixed(1)}}}
  });

  if(trendChart3)trendChart3.destroy();
  const cov3opts={...commonOpts('%'),scales:{...commonOpts('%').scales,y:{...commonOpts('%').scales.y,min:80,max:100}}};
  trendChart3=new Chart(document.getElementById('trendChart3'),{
    type:'line',
    data:{labels,datasets:[
      {label:'%Task Coverage',data:covs,borderColor:'#059669',backgroundColor:'rgba(5,150,105,.08)',fill:true,tension:.35,pointRadius:4,pointBackgroundColor:'#059669'},
      {label:'Target',data:targets,borderColor:'#d97706',borderDash:[5,4],borderWidth:1.5,pointRadius:0,fill:false}
    ]},
    options:{...cov3opts,plugins:{...cov3opts.plugins,
      datalabels:{display:(ctx)=>ctx.datasetIndex===0,align:'top',anchor:'end',
        color:'#059669',font:{size:9,weight:'500'},
        formatter:v=>v.toFixed(1)+'%'}}}
  });

  renderAIInsight('trend', buildTrendContext());
}

// ── CONTEXT BUILDERS cho AI Insight ──────────────────────────────────────────
function buildWeekContext(){
  if(!weekData.length)return'No data available.';
  return`Weekly Overview Report: ${weekData.length} days. `+
    weekData.map(w=>{const e=getEff(w.d);return`[${w.dateStr} ${w.event}] Inflow:${Math.round(w.inflow).toLocaleString()} HC:${e.weightedHC.toFixed(1)} Cov:${(e.coverage_pct*100).toFixed(1)}% Target:${(w.eventTarget*100).toFixed(1)}%`;}).join(' | ');
}
function buildDayContext(){
  const d=parseInt(document.getElementById('daySelect').value);
  if(!weekData[d])return'No data available.';
  const wd=weekData[d],e=getEff(d);
  let ctx=`Ngày ${wd.dateStr} (${wd.event}): Inflow ${Math.round(wd.inflow).toLocaleString()}, HC ${e.weightedHC.toFixed(1)} (FT ${e.ft} PT ${e.pt}), Coverage ${(e.coverage_pct*100).toFixed(1)}%, Target ${(wd.eventTarget*100).toFixed(1)}%. Hourly coverage: ${e.coverage.map((v,h)=>`${h}h:${v}`).join(',')}`;
  const hist=getLastSameEventHistory(wd.event);
  if(hist){
    ctx+=` | Historical reference — last ${wd.event} day (${hist.date}, ${hist.dow}): hourly inflow ${hist.hourly.map((v,h)=>`${h}h:${v}`).join(',')}`;
  }
  return ctx;
}
function buildShiftContext(){
  if(!weekData.length)return'No data available.';
  const activeShifts=new Set();
  weekData.forEach(w=>{const sc=getEff(w.d).shiftCounts;ALL_SHIFTS.forEach(s=>{if((sc[s.name]||0)>0)activeShifts.add(s.name);});});
  const summary=weekData.map(w=>{const sc=getEff(w.d).shiftCounts;const shifts=[...activeShifts].filter(n=>sc[n]>0).map(n=>`${n}:${sc[n]}`).join(',');return`[${w.dateStr}] ${shifts}`;}).join(' | ');

  const d=parseInt(document.getElementById('shiftDaySelect').value);
  let sensText='';
  if(weekData[d]){
    const wd=weekData[d];
    const{totalInflow,incResults,decResults}=buildShiftSensitivityContext(d);
    sensText=` | Sensitivity analysis for ${wd.dateStr} (${wd.event}), current Inflow ${totalInflow.toLocaleString()}, Coverage Target ${(wd.eventTarget*100).toFixed(1)}%. `+
      `INCREASE scenarios (staffing kept fixed unless additional staff is ordered): `+
      incResults.map(r=>`+${r.pct}% Inflow (→${r.inflowAbs.toLocaleString()}) → Coverage ${r.covPctFixed}% with current staffing (${r.meetsTargetFixed?'meets':'misses'} target); to reach target, order additional staff: ${r.additionalStaff} (resulting HC ${r.newHC}, +${r.hcAdded} HC)`).join(' / ')+
      `. DECREASE scenarios (re-optimized at lower Inflow, still meeting target): `+
      decResults.map(r=>`-${r.pct}% Inflow (→${r.inflowAbs.toLocaleString()}) → suggested cuts: ${r.cuts} (resulting HC ${r.newHC}, saved ${r.hcSaved} HC, Coverage ${r.covPct}%)`).join(' / ');
  }
  return`Shift Allocation — Active shifts: ${[...activeShifts].join(',')}. Daily breakdown: ${summary}${sensText}`;
}

// ── SENSITIVITY ANALYSIS — mô phỏng %Task Coverage khi Inflow tăng/giảm ─────
// Tăng Inflow: (a) giữ nguyên cơ cấu ca hiện tại → xem coverage tụt bao nhiêu;
//              (b) chạy lại optimize() ở mức inflow cao hơn để tính số nhân sự CẦN ĐẶT THÊM theo từng ca.
// Giảm Inflow: chạy lại optimize() ở mức inflow thấp hơn (cùng carry-in, cùng target) để tìm
// cơ cấu ca tối thiểu vẫn đạt target, rồi so sánh với cơ cấu hiện tại để gợi ý ca có thể cắt.
function buildShiftSensitivityContext(d){
  const wd=weekData[d], e=getEff(d);
  const et=wd.eventTarget;
  const totalInflow=wd.hourInflows.reduce((a,b)=>a+b,0);

   const incResults=[0.10,0.15,0.20,0.50].map(pct=>{
    const mult=1+pct;
    const scaledInflows=wd.hourInflows.map(v=>v*mult);
    const scaledTotal=totalInflow*mult;

    let completed=0;
    scaledInflows.forEach((inf,h)=>{
      const cap=(e.coverage[h]||0)*HOUR_PROD;
      completed+=Math.min(cap,inf);
    });
    const covPctFixed=scaledTotal>0?completed/scaledTotal:1;

    const reOpt=optimize(scaledInflows,wd.carryIn,et);
    const adds=[];
    ALL_SHIFTS.forEach(s=>{
      const cur=e.shiftCounts[s.name]||0;
      const need=reOpt.shiftCounts[s.name]||0;
      if(need>cur)adds.push(`${s.name}:+${need-cur}`);
    });

    return{
      pct:+(pct*100).toFixed(0),
      inflowAbs:Math.round(scaledTotal),
      covPctFixed:+(covPctFixed*100).toFixed(1),
      meetsTargetFixed:covPctFixed>=et,
      additionalStaff:adds.length?adds.join(', '):'No additional staff needed',
      newHC:+reOpt.weightedHC.toFixed(1),
      hcAdded:+(reOpt.weightedHC-e.weightedHC).toFixed(1)
    };
  });

  const decResults=[0.10,0.15,0.20,0.50].map(pct=>{
    const mult=1-pct;
    const scaledInflows=wd.hourInflows.map(v=>v*mult);
    const scaledTotal=totalInflow*mult;
    const reOpt=optimize(scaledInflows,wd.carryIn,et);
    const cuts=[];
    ALL_SHIFTS.forEach(s=>{
      const cur=e.shiftCounts[s.name]||0;
      const need=reOpt.shiftCounts[s.name]||0;
      if(cur>need)cuts.push(`${s.name}:-${cur-need}`);
    });
    return{
      pct:+(pct*100).toFixed(0),
      inflowAbs:Math.round(scaledTotal),
      newHC:+reOpt.weightedHC.toFixed(1),
      hcSaved:+(e.weightedHC-reOpt.weightedHC).toFixed(1),
      covPct:+(reOpt.coverage_pct*100).toFixed(1),
      cuts:cuts.length?cuts.join(', '):'No cut needed'
    };
  });

  return{totalInflow:Math.round(totalInflow),incResults,decResults};
}
function buildTrendContext(){
  if(!weekData.length)return'No data available.';
  const rows=weekData.map(w=>{const e=getEff(w.d);return`${w.dateStr}(${w.event}): Inflow=${Math.round(w.inflow).toLocaleString()} HC=${e.weightedHC.toFixed(1)} Cov=${(e.coverage_pct*100).toFixed(1)}%`;}).join(' | ');
  return`Trend Report — ${weekData.length} days: ${rows}`;
}
function buildWorkModeContext(data){
  const rows=data.map(d=>`${d.dateStr}: WFH=${d.wfh} Floor=${d.floor}`).join(' | ');
  return`Work Mode Report: ${rows}`;
}

// ── AI INSIGHT ENGINE ─────────────────────────────────────────────────────────
const AI_PROMPTS={
  week:'You are a WFM expert in E-commerce. Briefly analyze the following Weekly Overview, highlight the 3 most important insights about HC and coverage, and provide 1-2 specific recommendations. Reply in English, max 200 words.',
  day:'You are a WFM expert in E-commerce. Analyze the following Daily Detail, identify hours with coverage issues, explain the root cause, and suggest specific shift adjustments. If historical reference data for the same event type is provided in the context, use it to predict which hours are most likely to be peak-inflow hours today, and briefly explain the reasoning. Reply in English, max 200 words.',
  shift:'You are a WFM expert in E-commerce. Using the Shift Allocation structure and the sensitivity analysis data provided (which already includes the absolute Inflow figure at each milestone), address exactly 3 points concisely, using a compact bullet format per scenario (Inflow number, coverage/action, shifts affected — no long sentences): (1) Explain in 1-2 sentences why this HC allocation was chosen, with its main advantages and limitations; (2) For each scenario where actual Inflow increases by 10%, 15%, 20%, and 50% — state the resulting absolute Inflow number, how %Task Coverage would change under the current fixed schedule, and exactly which shifts and how many additional staff must be ordered to bring %Task Coverage back to the Coverage Target; (3) For each scenario where actual Inflow decreases by 10%, 15%, 20%, and 50% — state the resulting absolute Inflow number, and exactly which shifts and how many staff could be cut while still meeting the Coverage Target. Reply in English, max 260 words.',
  trend:'You are a WFM expert in E-commerce. Analyze the Inflow, HC, and Coverage trends over time, identify patterns, and provide a short-term outlook. Reply in English, max 200 words.',
  workmode:'You are a WFM expert in E-commerce. Analyze the WFH vs On-Floor distribution, assess its appropriateness for operational needs, and recommend adjustments if necessary. Reply in English, max 200 words.'
};

const _aiInsightTimers = {};
// Với tab tốn nhiều token (Day/Shift), không tự động gọi API — hiển thị nút để user chủ động bấm khi cần.
function showAIInsightPrompt(tabId){
  const container=document.getElementById(`aiInsight-${tabId}`);
  if(!container)return;
  container.innerHTML=`<button class="btn-outline" onclick="triggerManualInsight('${tabId}')">✦ Generate AI Insight</button>`;
}
function triggerManualInsight(tabId){
  const contextFn = tabId==='shift' ? buildShiftContext : buildDayContext;
  _fetchAIInsight(tabId, contextFn());
}
function renderAIInsight(tabId, context){
  const container=document.getElementById(`aiInsight-${tabId}`);
  if(!container)return;
  container.innerHTML=`<div class="ai-insight-loading"><span class="ai-spinner"></span> Waiting for changes to settle...</div>`;
  // Debounce: gộp các lần gọi liên tiếp (đổi ngày, sửa ca thủ công, chạy lại optimizer)
  // trong vòng 1.2s thành 1 lần gọi API duy nhất — giảm mạnh số request/token tốn ra.
  clearTimeout(_aiInsightTimers[tabId]);
  _aiInsightTimers[tabId] = setTimeout(() => _fetchAIInsight(tabId, context), 1200);
}
async function _fetchAIInsight(tabId, context){
  const container=document.getElementById(`aiInsight-${tabId}`);
  if(!container)return;
  container.innerHTML=`<div class="ai-insight-loading"><span class="ai-spinner"></span> AI is analyzing data...</div>`;
  try{
    const resp=await fetch('/api/ai-insight',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tabId, context, prompt: AI_PROMPTS[tabId]})
    });
    const data=await resp.json();
    if(!resp.ok) throw new Error(data.error||`HTTP ${resp.status}`);
    const text=data.text||'No response received from AI.';
    if(data.fallback){
      container.innerHTML=`<div class="ai-insight-fallback"><span style="opacity:.5">✦</span> ${text}</div>`;
      return;
    }
    container.innerHTML=`<div class="ai-insight-result">
      <div class="ai-insight-header"><span class="ai-icon">✦</span> AI Insight</div>
      <div class="ai-insight-body">${text.replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')}</div>
    </div>`;
  }catch(err){
    container.innerHTML=`<div class="ai-insight-error">⚠ ${err.message}</div>`;
  }
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

function toggleTableCard(titleEl){
  const card=titleEl.closest('.table-card');
  if(card)card.classList.toggle('collapsed');
}
function toggleAllTableCards(){
  const cards=document.querySelectorAll('.table-card');
  if(!cards.length)return;
  const anyExpanded=[...cards].some(c=>!c.classList.contains('collapsed'));
  cards.forEach(c=>c.classList.toggle('collapsed',anyExpanded));
  const btn=document.getElementById('collapseAllBtn');
  if(btn)btn.textContent=anyExpanded?'⬍ Expand All':'⬍ Collapse All';
}

function showTab(name){
  const names=['data','week','day','shift','trend','workmode'];
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  document.querySelectorAll('.section').forEach(s=>s.classList.toggle('active', s.id===`sec-${name}`));
  if(name==='trend' && weekData.length) renderTrend();
  if(name==='workmode' && weekData.length) renderWorkMode();
}
