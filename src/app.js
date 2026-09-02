/* ═══ src/app.js ═══ ตรรกะ UI ทั้งหมด */
import { PIDS, DEFAULT_PIDS, TUNE_PIDS, calcPid, decodeSupported } from './pids.js';
import { decodeDtc, describeDtc } from './dtc.js';
import { FUELS, ZONES, FuelTuner, afrFromLambda, targetLambda, theoreticalMaf } from './fuel.js';
import { BRANDS } from './presets.js';
import { BleTransport, SimTransport } from './transport.js';
import { Elm327 } from './elm327.js';

const $=s=>document.querySelector(s), $=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

const S = {
  tp:null, elm:null, connected:false, polling:false,
  active:new Set(DEFAULT_PIDS), supported:new Set(),
  values:{}, hist:{}, log:[], logging:false, req:0, dtcs:[],
  tuner:new FuelTuner(), tuning:false,
};

/* ─── Console ─── */
function cons(kind,msg,el=$('#console')){
  const cls={tx:'tx',rx:'rx',er:'er',sy:'sy'}[kind]||'sy';
  const pre={tx:'>> ',rx:'<< ',er:'!! ',sy:'-- '}[kind]||'';
  el.innerHTML += `<span class="${cls}">[${new Date().toLocaleTimeString('th-TH',{hour12:false})}] ${pre}${esc(msg)}</span>\n`;
  el.scrollTop=el.scrollHeight;
  if(el===$('#console') && el.childNodes.length>700) el.removeChild(el.firstChild);
}

/* ─── Nav ─── */
$('.navbtn').forEach(b=>b.onclick=()=>{
  $('.navbtn').forEach(x=>x.classList.remove('active'));
  $('.panel').forEach(x=>x.classList.remove('active'));
  b.classList.add('active'); $('#'+b.dataset.tab).classList.add('active');
  if(b.dataset.tab==='graph') drawChart();
});

/* ─── Connect ─── */
$('#btnConnect').onclick = async () => {
  try{
    $('#btnConnect').disabled=true; $('#status').textContent='กำลังเชื่อมต่อ...';
    S.tp = $('#mode').value==='sim' ? new SimTransport() : new BleTransport();
    const info = await S.tp.connect();
    S.tp.onClose = onDisconnected;
    S.elm = new Elm327(S.tp,(k,m)=>cons(k,m));
    cons('sy',`เชื่อมต่อสำเร็จ: ${info.name} [${info.profile}]`);

    $('#status').textContent='กำลังเริ่มต้นระบบ...';
    const proto = await S.elm.init();

    S.connected=true;
    $('#dot').classList.add('on');
    $('#status').textContent='เชื่อมต่อแล้ว';
    $('#btnDisconnect').disabled=false; $('#btnStart').disabled=false;

    const vin  = await S.elm.readVin().catch(()=>null);
    const volt = await S.elm.send('ATRV').then(r=>r.trim()).catch(()=>'-');
    $('#volt').querySelector('b').textContent = volt;
    $('#vehInfo').textContent = `${proto} • VIN: ${vin||'ไม่พบ'}`;

    await refreshStatus();
    await scanSupported();
    startPolling();
  }catch(e){
    cons('er',e.message);
    alert('เชื่อมต่อไม่สำเร็จ\n\n'+e.message);
    $('#status').textContent='ตัดการเชื่อมต่อ'; $('#btnConnect').disabled=false;
  }
};
$('#btnDisconnect').onclick = async()=>{ stopPolling(); await S.tp?.disconnect(); };

function onDisconnected(){
  S.connected=false; stopPolling();
  $('#dot').classList.remove('on');
  $('#status').textContent='ตัดการเชื่อมต่อ';
  $('#btnConnect').disabled=false; $('#btnDisconnect').disabled=true; $('#btnStart').disabled=true;
  cons('sy','ตัดการเชื่อมต่อแล้ว');
}

/* ─── สแกน PID ที่รองรับ ─── */
async function scanSupported(){
  S.supported.clear();
  for(const base of ['0100','0120','0140','0160']){
    try{
      const r=await S.elm.requestPid(base,3000);
      if(!r.data) break;
      decodeSupported(base,r.data).forEach(p=>S.supported.add(p));
      if(!(r.data[3]&0x01)) break;
    }catch(_){ break; }
  }
  cons('sy',`รถรุ่นนี้รองรับ ${S.supported.size} PID`);
  buildPicker(); buildGraphSelect();
}
$('#btnScanPids').onclick=()=>S.connected&&scanSupported();

function buildPicker(){
  const box=$('#pidPicker'); box.innerHTML='';
  const list = S.supported.size ? [...S.supported].filter(p=>PIDS[p]) : Object.keys(PIDS);
  list.sort().forEach(pid=>{
    const l=document.createElement('label');
    l.innerHTML=`<input type="checkbox" value="${pid}" ${S.active.has(pid)?'checked':''}>
      <span>${PIDS[pid].n} <small style="color:#7d8da6">(${pid})</small></span>`;
    l.querySelector('input').onchange=e=>{
      e.target.checked?S.active.add(pid):S.active.delete(pid);
      buildGauges(); buildGraphSelect();
    };
    box.appendChild(l);
  });
  buildGauges();
}

/* ─── เกจ ─── */
function buildGauges(){
  const g=$('#gauges'); g.innerHTML='';
  [...S.active].forEach(pid=>{
    const d=PIDS[pid]; if(!d) return;
    const el=document.createElement('div'); el.className='gauge';
    el.innerHTML=`<canvas id="g_${pid}" width="150" height="88"></canvas>
      <div class="val" id="v_${pid}">--</div>
      <div class="lbl">${d.n}${d.u?' ('+d.u+')':''}</div>`;
    g.appendChild(el);
  });
  Object.keys(S.values).forEach(p=>drawGauge(p,S.values[p]));
}
function drawGauge(pid,val){
  const cv=$('#g_'+pid); if(!cv) return;
  const d=PIDS[pid], ctx=cv.getContext('2d'), w=cv.width, cx=w/2, cy=80, r=62;
  ctx.clearRect(0,0,w,cv.height); ctx.lineWidth=10; ctx.lineCap='round';
  ctx.strokeStyle='#1e2735'; ctx.beginPath(); ctx.arc(cx,cy,r,Math.PI,2*Math.PI); ctx.stroke();
  if(val==null) return;
  const p=Math.max(0,Math.min(1,(val-d.min)/(d.max-d.min)));
  const grad=ctx.createLinearGradient(0,0,w,0);
  grad.addColorStop(0,'#22d3ee'); grad.addColorStop(.6,'#34d399'); grad.addColorStop(1,'#f43f5e');
  ctx.strokeStyle=grad; ctx.beginPath(); ctx.arc(cx,cy,r,Math.PI,Math.PI+Math.PI*p); ctx.stroke();
  $('#v_'+pid).textContent=val;
}

/* ─── Polling ─── */
let pollTimer=null, rateTimer=null;
function startPolling(){
  if(S.polling||!S.connected) return;
  S.polling=true; $('#btnStart').disabled=true; $('#btnStop').disabled=false;
  rateTimer=setInterval(()=>{ $('#rate').querySelector('b').textContent=S.req+'/s'; S.req=0; },1000);
  loop();
}
function stopPolling(){
  S.polling=false; clearTimeout(pollTimer); clearInterval(rateTimer);
  $('#btnStart').disabled=!S.connected; $('#btnStop').disabled=true;
}
$('#btnStart').onclick=startPolling; $('#btnStop').onclick=stopPolling;

async function loop(){
  if(!S.polling||!S.connected) return;
  const list = new Set(S.active);
  if(S.tuning) TUNE_PIDS.forEach(p=>list.add(p));      // โมดูลจูนต้องได้ PID ครบเสมอ
  const row={ts:new Date().toISOString()};
  for(const pid of list){
    if(!S.polling) break;
    try{
      const r=await S.elm.requestPid(pid,2200); S.req++;
      const v = r.data ? calcPid(pid,r.data) : null;
      if(v!==null){
        S.values[pid]=v; row[pid]=v;
        (S.hist[pid]=S.hist[pid]||[]).push({t:Date.now(),v});
        if(S.hist[pid].length>400) S.hist[pid].shift();
        drawGauge(pid,v);
      }
    }catch(_){}
  }
  if(S.tuning) collectTune();
  if(S.logging){ S.log.push(row); $('#logCount').textContent=S.log.length+' แถว'; appendLogRow(row); }
  drawChart();
  pollTimer=setTimeout(loop, Math.max(80,+$('#pollMs').value||200));
}

async function refreshStatus(){
  const st=await S.elm.readStatus().catch(()=>null);
  if(!st) return null;
  $('#mil').classList.toggle('on',st.mil);
  $('#mil').title = st.mil?`ไฟ Check Engine ติด — ${st.dtcCount} รหัส`:'ปกติ';
  return st;
}

/* ══════════ DTC ══════════ */
$('#btnReadDtc').onclick = async () => {
  if(!S.connected) return alert('กรุณาเชื่อมต่ออุปกรณ์ก่อน');
  const was=S.polling; stopPolling();
  const box=$('#dtcResult'); box.innerHTML='<p class="muted">กำลังสแกน...</p>';
  const groups=[{mode:'03',label:'Stored — ยืนยันแล้ว',cls:''},
    {mode:'07',label:'Pending — รอยืนยัน',cls:'pending'},
    {mode:'0A',label:'Permanent — ถาวร ลบไม่ได้',cls:'permanent'}];
  const st=await refreshStatus();
  let html='', all=[];
  if(st) html+=`<div class="card"><h3>สรุปผล</h3>
     ไฟ Check Engine: <b style="color:${st.mil?'#fbbf24':'#34d399'}">${st.mil?'ติด ⚠':'ดับ ✓'}</b>
     &nbsp;•&nbsp; จำนวนรหัส: <b>${st.dtcCount}</b>
     &nbsp;•&nbsp; ชนิดเครื่องยนต์: <b>${st.spark?'เบนซิน':'ดีเซล'}</b></div>`;
  for(const g of groups){
    let res;
    try{ res=await S.elm.readDtcRaw(g.mode); }
    catch(e){ html+=`<div class="card"><h3>${g.label}</h3><span class="muted">อ่านไม่ได้: ${esc(e.message)}</span></div>`; continue; }
    const codes=res.pairs.map(([a,b])=>decodeDtc(a,b)).filter(Boolean);
    html+=`<div class="card"><h3>${g.label} — พบ ${codes.length} รหัส</h3>`;
    if(!codes.length) html+='<span class="muted">ไม่พบรหัสในหมวดนี้ ✓</span>';
    codes.forEach(c=>{
      const i=describeDtc(c); all.push({...i,group:g.label});
      html+=`<div class="dtc-card ${g.cls}">
        <span class="dtc-code">${i.code}</span>
        <span class="dtc-tag">${i.known?'มาตรฐาน SAE':'ต้องเทียบคู่มือ'}</span>
        <div class="dtc-desc">${esc(i.desc)}</div>
        <div class="dtc-sys">ระบบ: ${esc(i.system)}</div></div>`;
    });
    html+='</div>';
  }
  S.dtcs=all; box.innerHTML=html;
  if(was) startPolling();
};

$('#btnClearDtc').onclick = async () => {
  if(!S.connected) return alert('กรุณาเชื่อมต่ออุปกรณ์ก่อน');
  if(!confirm('⚠ ยืนยันลบรหัสปัญหาทั้งหมด (Mode 04)\n\n'+
    '• กุญแจ ON แต่เครื่องยนต์ต้องดับ\n'+
    '• Freeze Frame, Readiness และค่าเรียนรู้ Fuel Trim จะถูกล้างทั้งหมด\n'+
    '• ถ้ายังไม่แก้ต้นเหตุ ไฟจะกลับมาติดอีก\n'+
    '• รหัส Permanent จะยังอยู่จนกว่า ECU ตรวจซ้ำผ่านเอง\n\nดำเนินการต่อ?')) return;
  const was=S.polling; stopPolling();
  try{
    const r=await S.elm.clearDtc();
    cons(r.ok?'sy':'er','ผลการลบรหัส: '+r.raw);
    await new Promise(res=>setTimeout(res,1200));
    await refreshStatus();
    alert(r.ok
      ? '✓ ลบสำเร็จ\n\nขั้นต่อไป: บิดกุญแจ OFF 10 วินาที → สตาร์ต → อุ่นเครื่องถึงพัดลมทำงาน → เดินเบา 10 นาทีเพื่อให้ ECU เรียนรู้ค่าใหม่'
      : '✗ ECU ไม่ตอบรับ\n\nตอบกลับ: '+r.raw+'\nลองใหม่โดยเปิดกุญแจ ON แต่ดับเครื่องยนต์');
    $('#btnReadDtc').click();
  }catch(e){ alert('เกิดข้อผิดพลาด: '+e.message); }
  if(was) startPolling();
};

$('#btnExportDtc').onclick=()=>{
  if(!S.dtcs.length) return alert('ยังไม่มีข้อมูล กรุณาสแกนก่อน');
  const txt='รายงานผลการวินิจฉัย OBD2\nวันที่: '+new Date().toLocaleString('th-TH')+
    '\nข้อมูลรถ: '+$('#vehInfo').textContent+'\n'+'='.repeat(62)+'\n\n'+
    S.dtcs.map(d=>`[${d.group}] ${d.code}\n  อาการ: ${d.desc}\n  ระบบ: ${d.system}\n`).join('\n');
  download('obd2-report-'+Date.now()+'.txt',txt,'text/plain');
};

/* ══════════ FUEL TUNING ══════════ */
(function initFuelUi(){
  const sel=$('#fuelType');
  Object.entries(FUELS).forEach(([k,v])=>{
    const o=document.createElement('option'); o.value=k; o.textContent=v.name;
    if(k==='e20') o.selected=true; sel.appendChild(o);
  });
  sel.onchange=renderFuelFacts;
  ['engineDisp','engineCyl','engineAsp'].forEach(id=>$('#'+id).onchange=renderFuelFacts);
  renderFuelFacts();
})();

const tuneCfg = () => ({
  fuel: $('#fuelType').value,
  dispL: +$('#engineDisp').value || 1.5,
  cyl: +$('#engineCyl').value || 4,
  asp: $('#engineAsp').value,
});

function renderFuelFacts(){
  const c=tuneCfg(), F=FUELS[c.fuel];
  const tgtLoad=targetLambda('load',c.asp);
  $('#fuelFacts').innerHTML=`
    <div class="fact"><span>AFR สโตอิชิโอเมตริก</span><b>${F.afr.toFixed(2)} : 1</b></div>
    <div class="fact"><span>สัดส่วนเอทานอล</span><b>${F.eth}%</b></div>
    <div class="fact"><span>AFR เป้าหมายขับคงที่</span><b>${F.afr.toFixed(1)} (λ 1.00)</b></div>
    <div class="fact"><span>AFR เป้าหมายเร่งเต็ม</span><b>${(F.afr*tgtLoad).toFixed(1)} (λ ${tgtLoad})</b></div>
    <div class="fact"><span>ต่างจากเบนซิน 95</span><b>${((FUELS.gas95.afr/F.afr-1)*100).toFixed(1)}%</b></div>
    <div class="fact" style="grid-column:1/-1"><span>หมายเหตุ</span><b style="font-size:12.5px;color:#e8eef8;font-family:inherit;font-weight:400">${F.note}</b></div>`;
  $('#afrTarget').textContent=F.afr.toFixed(1)+':1';
}

$('#tuneStart').onclick=()=>{
  if(!S.connected) return alert('กรุณาเชื่อมต่ออุปกรณ์ก่อน');
  S.tuning=true; if(!S.polling) startPolling();
  cons('sy','เริ่มเก็บข้อมูลจูนน้ำมัน — ขับใช้งานให้ครบทั้ง 3 โซน');
};
$('#tuneStop').onclick=()=>{ S.tuning=false; renderTune(); cons('sy','หยุดเก็บข้อมูลจูน'); };
$('#tuneReset').onclick=()=>{ S.tuner.reset(); renderTune(); cons('sy','ล้างข้อมูลจูนแล้ว'); };

function collectTune(){
  const v=S.values, c=tuneCfg();
  const rec=S.tuner.push({
    rpm:v['010C'], load:v['0104'], map:v['010B'], maf:v['0110'],
    iat:v['010F'], ect:v['0105'], spd:v['010D'], thr:v['0111'],
    stft1:v['0106'], ltft1:v['0107'], stft2:v['0108'], ltft2:v['0109'],
    lambda: v['0124'] ?? v['0134'] ?? v['0144'] ?? null,
  }, c);
  if(rec) renderTune(rec);
}

function renderTune(rec){
  const c=tuneCfg(), F=FUELS[c.fuel], v=S.values;
  const lam = v['0124'] ?? v['0134'] ?? null;
  const trim = (v['0106']??0)+(v['0107']??0);
  const set=(id,val,cls)=>{ const e=$('#'+id); e.textContent=val;
    e.parentElement.className='metric'+(cls?' '+cls:''); };

  set('lambdaNow', lam!=null?lam.toFixed(3):'--');
  set('afrNow',    lam!=null?afrFromLambda(lam,c.fuel).toFixed(2)+':1':'--');
  set('stftNow',   v['0106']!=null?v['0106'].toFixed(1)+'%':'--');
  set('ltftNow',   v['0107']!=null?v['0107'].toFixed(1)+'%':'--');
  set('totalTrim', (v['0106']!=null||v['0107']!=null)?trim.toFixed(1)+'%':'--',
      Math.abs(trim)<=6?'good':(Math.abs(trim)<=12?'warn':'bad'));

  const ve = rec?.ve ?? null;
  set('veNow', ve!=null?ve.toFixed(1)+'%':'--', ve==null?'':(ve>=78&&ve<=106?'good':'warn'));
  const thMaf = theoreticalMaf(v['010C'],c.dispL,v['010B'],v['010F'],1);
  set('mafCmp', (v['0110']!=null&&thMaf) ? `${v['0110'].toFixed(1)} / ${thMaf.toFixed(1)}` : '--');
  $('#afrTarget').textContent=F.afr.toFixed(1)+':1';
  $('#tuneCount').textContent=S.tuner.samples.length+' ตัวอย่าง';

  /* โซน */
  const a=S.tuner.analyze(c);
  $('#zoneGrid').innerHTML=Object.entries(ZONES).map(([k,z])=>{
    const s=a.zones[k];
    if(!s) return `<div class="zone"><h4>${z.name}</h4><div class="zsub">${z.sub}</div>
      <div class="zval" style="color:#7d8da6">--</div><div class="zsub">ยังไม่มีข้อมูล</div></div>`;
    const t=s.trim??0, col=Math.abs(t)<=6?'#34d399':(Math.abs(t)<=12?'#fbbf24':'#f43f5e');
    const w=Math.min(50,Math.abs(t)/25*50);
    return `<div class="zone"><h4>${z.name}</h4><div class="zsub">${z.sub} · ${s.n} ตัวอย่าง</div>
      <div class="zval" style="color:${col}">${t>0?'+':''}${t.toFixed(1)}%</div>
      <div class="zbar"><i></i><b style="background:${col};${t>=0?`left:50%;width:${w}%`:`right:50%;width:${w}%`}"></b></div>
      <div class="zsub" style="margin-top:9px">
        STFT ${s.stft?.toFixed(1)??'-'}% · LTFT ${s.ltft?.toFixed(1)??'-'}%<br>
        λ ${s.lambda?.toFixed(3)??'-'} · AFR ${s.lambda?(s.lambda*F.afr).toFixed(1):'-'}:1 · VE ${s.ve?.toFixed(0)??'-'}%
      </div></div>`;
  }).join('');

  /* คำแนะนำ */
  $('#tuneAdvice').innerHTML=a.advice.map(x=>`<div class="advice ${x.lv}">
    <b>${esc(x.t)}</b>${esc(x.d)}
    ${x.l.length?'<ul>'+x.l.map(y=>`<li>${esc(y)}</li>`).join('')+'</ul>':''}</div>`).join('');

  renderVeTable();
}

function renderVeTable(){
  const m=S.tuner.veMatrix(), t=$('#veTable');
  if(!m.rpms.length){ t.innerHTML='<tr><td class="muted" style="padding:14px">ยังไม่มีข้อมูล VE</td></tr>'; return; }
  const color=v=>{
    if(v==null) return 'background:#0c1119;color:#4b5768';
    if(v<70)  return 'background:#f43f5e';
    if(v<80)  return 'background:#fb923c';
    if(v<=105)return 'background:#34d399';
    if(v<=115)return 'background:#fbbf24';
    return 'background:#f43f5e';
  };
  let h='<thead><tr><th>MAP\\RPM</th>'+m.rpms.map(r=>`<th>${r}</th>`).join('')+'</tr></thead><tbody>';
  m.maps.forEach(mp=>{
    h+=`<tr><th>${mp}</th>`+m.rpms.map(r=>{
      const v=m.get(r,mp);
      return `<td class="ve" style="${color(v)}">${v!=null?v.toFixed(0):'·'}</td>`;
    }).join('')+'</tr>';
  });
  t.innerHTML=h+'</tbody>';
}

$('#btnTuneReport').onclick=()=>{
  if(!S.tuner.samples.length) return alert('ยังไม่มีข้อมูล กรุณาเก็บข้อมูลก่อน');
  download('fuel-tuning-report-'+Date.now()+'.txt',
    '\uFEFF'+S.tuner.report(tuneCfg(),$('#vehInfo').textContent),'text/plain');
};

/* ══════════ FREEZE FRAME ══════════ */
$('#btnFreeze').onclick = async () => {
  if(!S.connected) return alert('กรุณาเชื่อมต่ออุปกรณ์ก่อน');
  const was=S.polling; stopPolling();
  const box=$('#freezeResult'); box.innerHTML='<p class="muted">กำลังอ่าน...</p>';
  let html='';
  for(const t of ['0C','0D','05','04','0F','11','10','0B','06','07','2F','0E','03']){
    try{
      const raw=await S.elm.send('02'+t+'00',2500);
      const p=Elm327.parseBytes(raw), i=p.bytes.indexOf(0x42);
      if(i<0) continue;
      const d=PIDS['01'+t]; if(!d) continue;
      const v=calcPid('01'+t,p.bytes.slice(i+3));
      if(v===null) continue;
      html+=`<div class="kv"><span>${d.n}</span><b>${v} ${d.u}</b></div>`;
    }catch(_){}
  }
  box.innerHTML=html||'<p class="muted">ไม่พบข้อมูล Freeze Frame (จะมีก็ต่อเมื่อมี DTC ค้างอยู่)</p>';
  if(was) startPolling();
};

/* ══════════ READINESS ══════════ */
$('#btnReady').onclick = async () => {
  if(!S.connected) return alert('กรุณาเชื่อมต่ออุปกรณ์ก่อน');
  const st=await refreshStatus(), box=$('#readyResult');
  if(!st){ box.innerHTML='<p class="muted">อ่านสถานะไม่สำเร็จ</p>'; return; }
  const notReady=st.monitors.filter(m=>m.available&&!m.complete).length;
  box.innerHTML=`<div class="card" style="grid-column:1/-1"><h3>สรุปความพร้อมตรวจสภาพ</h3>
    ${notReady===0
      ? '<b style="color:#34d399">✓ พร้อมตรวจสภาพ — ระบบตรวจสอบตัวเองครบทุกรายการ</b>'
      : `<b style="color:#fbbf24">⚠ ยังไม่พร้อม — มี ${notReady} ระบบที่ตรวจไม่ครบ</b>
         <div class="muted" style="margin-top:7px">ต้องขับใช้งานผสม (เมือง + ทางไกล) อีกราว 80–150 กม. เพื่อให้ ECU ตรวจครบ</div>`}
    </div>`+
    st.monitors.map(m=>`<div class="mon"><span>${m.name}</span>
      <span class="badge ${!m.available?'na':(m.complete?'ok':'no')}">
        ${!m.available?'ไม่มีระบบนี้':(m.complete?'ตรวจครบ ✓':'ยังไม่ครบ')}</span></div>`).join('');
};

/* ══════════ CHART & LOG ══════════ */
function buildGraphSelect(){
  const s=$('#graphPid'), cur=s.value; s.innerHTML='';
  [...S.active].forEach(p=>{
    const o=document.createElement('option'); o.value=p; o.textContent=PIDS[p]?.n||p; s.appendChild(o);
  });
  if(cur) s.value=cur;
}
function drawChart(){
  const cv=$('#chart'); if(!cv.clientWidth) return;
  cv.width=cv.clientWidth;
  const ctx=cv.getContext('2d'), pid=$('#graphPid').value, h=cv.height, w=cv.width;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='#1e2735'; ctx.lineWidth=1;
  for(let i=0;i<=4;i++){ const y=20+(h-40)*i/4;
    ctx.beginPath(); ctx.moveTo(44,y); ctx.lineTo(w-10,y); ctx.stroke(); }
  const data=S.hist[pid]; if(!data?.length||!PIDS[pid]) return;
  const d=PIDS[pid], vs=data.map(x=>x.v);
  const lo=Math.min(...vs), hi=Math.max(...vs, lo+1);
  const grad=ctx.createLinearGradient(0,0,0,h);
  grad.addColorStop(0,'rgba(34,211,238,.35)'); grad.addColorStop(1,'rgba(34,211,238,0)');
  ctx.beginPath();
  data.forEach((p2,i)=>{
    const x=44+(w-54)*i/Math.max(1,data.length-1);
    const y=h-20-(h-40)*(p2.v-lo)/(hi-lo);
    i?ctx.lineTo(x,y):ctx.moveTo(x,y);
  });
  ctx.strokeStyle='#22d3ee'; ctx.lineWidth=2; ctx.stroke();
  ctx.lineTo(w-10,h-20); ctx.lineTo(44,h-20); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
  ctx.fillStyle='#7d8da6'; ctx.font='11px monospace';
  for(let i=0;i<=4;i++) ctx.fillText((hi-(hi-lo)*i/4).toFixed(1),4,24+(h-40)*i/4);
  ctx.fillStyle='#e8eef8'; ctx.font='13px sans-serif';
  ctx.fillText(`${d.n} — ล่าสุด ${vs[vs.length-1]} ${d.u}`,50,14);
}
$('#graphPid').onchange=drawChart;
window.addEventListener('resize',drawChart);

$('#btnLogStart').onclick=()=>{ S.logging=true; initLogTable(); cons('sy','เริ่มบันทึกข้อมูล'); };
$('#btnLogStop').onclick =()=>{ S.logging=false; cons('sy','หยุดบันทึก — '+S.log.length+' แถว'); };
function initLogTable(){
  const cols=['ts',...S.active];
  $('#logTable thead').innerHTML='<tr>'+cols.map(c=>`<th>${c==='ts'?'เวลา':(PIDS[c]?.n||c)}</th>`).join('')+'</tr>';
  $('#logTable tbody').innerHTML='';
}
function appendLogRow(row){
  const cols=['ts',...S.active], tb=$('#logTable tbody'), tr=document.createElement('tr');
  tr.innerHTML=cols.map(c=>`<td>${c==='ts'
    ? new Date(row.ts).toLocaleTimeString('th-TH',{hour12:false}) : (row[c]??'-')}</td>`).join('');
  tb.prepend(tr);
  while(tb.children.length>300) tb.removeChild(tb.lastChild);
}
$('#btnCsv').onclick=()=>{
  if(!S.log.length) return alert('ยังไม่มีข้อมูล');
  const cols=['ts',...new Set(S.log.flatMap(r=>Object.keys(r)).filter(k=>k!=='ts'))];
  const csv=[cols.map(c=>c==='ts'?'timestamp':`${PIDS[c]?.n||c} (${PIDS[c]?.u||''})`).join(',')]
    .concat(S.log.map(r=>cols.map(c=>r[c]??'').join(','))).join('\n');
  download('obd2-log.csv','\uFEFF'+csv,'text/csv');
};
$('#btnJson').onclick=()=>{
  if(!S.log.length) return alert('ยังไม่มีข้อมูล');
  download('obd2-log.json',JSON.stringify({
    vehicle:$('#vehInfo').textContent, exportedAt:new Date().toISOString(),
    engine:tuneCfg(), dtcs:S.dtcs, tuning:S.tuner.analyze(tuneCfg()), samples:S.log
  },null,2),'application/json');
};
function download(name,content,mime){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([content],{type:mime}));
  a.download=name; a.click(); URL.revokeObjectURL(a.href);
}

/* ══════════ TERMINAL ══════════ */
async function runCmd(cmd){
  if(!S.connected) return alert('กรุณาเชื่อมต่ออุปกรณ์ก่อน');
  const was=S.polling; stopPolling();
  try{ await S.elm.send(cmd,9000); }catch(e){ cons('er',e.message); }
  if(was) startPolling();
}
$('#btnSend').onclick=()=>{ const v=$('#cmdInput').value.trim(); if(v){ runCmd(v); $('#cmdInput').value=''; } };
$('#cmdInput').onkeydown=e=>{ if(e.key==='Enter') $('#btnSend').click(); };
$('#btnClearTerm').onclick=()=>$('#console').innerHTML='';
$('.quick .btn').forEach(b=>b.onclick=()=>runCmd(b.dataset.cmd));

/* ══════════ RESET / UDS ══════════ */
(function initBrands(){
  const sel=$('#brandPreset');
  Object.entries(BRANDS).forEach(([k,v])=>{
    const o=document.createElement('option'); o.value=k; o.textContent=v.name; sel.appendChild(o);
  });
  sel.onchange=applyBrand; applyBrand();
})();
function applyBrand(){
  const b=BRANDS[$('#brandPreset').value];
  $('#udsSh').value=b.sh; $('#udsCra').value=b.cra; $('#udsSession').value=b.session;
  $('#brandInfo').innerHTML=`<b>Header:</b> ATSH ${b.sh} / ATCRA ${b.cra}<br>
    <b>หมายเหตุ:</b> ${esc(b.notes)}<br><b>ขั้นตอนล้างค่าเรียนรู้ที่ปลอดภัย:</b>
    <ol style="margin:6px 0 0;padding-left:20px">${b.relearn.map(x=>`<li>${esc(x)}</li>`).join('')}</ol>`;
}

$('[data-svc]').forEach(b=>b.onclick=async()=>{
  if(!S.connected) return alert('กรุณาเชื่อมต่ออุปกรณ์ก่อน');
  const rl=$('#resetLog'), was=S.polling; stopPolling();
  try{
    if(b.dataset.svc==='clear')   $('#btnClearDtc').click();
    if(b.dataset.svc==='reinit'){ const p=await S.elm.init(); cons('sy','เริ่มต้นใหม่สำเร็จ: '+p,rl); }
    if(b.dataset.svc==='proto'){  const p=await S.elm.send('ATDP'); cons('rx','โปรโตคอล: '+p.trim(),rl); }
    if(b.dataset.svc==='battery'){const v=await S.elm.send('ATRV');
      cons('rx','แรงดันแบตเตอรี่: '+v.trim(),rl); $('#volt').querySelector('b').textContent=v.trim(); }
  }catch(e){ cons('er',e.message,rl); }
  if(was) startPolling();
});

$('#btnUdsReset').onclick = async () => {
  if(!S.connected) return alert('กรุณาเชื่อมต่ออุปกรณ์ก่อน');
  if(!confirm('⚠ กำลังส่ง ECU Reset (Service 0x11)\n\nรถต้องจอดนิ่ง เกียร์ P/N เบรกมือดึง แบตมีไฟพอ\n\nยืนยัน?')) return;
  const rl=$('#resetLog'), was=S.polling; stopPolling();
  try{
    await S.elm.setHeader($('#udsSh').value.trim(),$('#udsCra').value.trim());
    const r=await S.elm.udsRaw('11'+$('#udsReset').value);
    cons(r.negative?'er':'rx', r.negative
      ? `ECU ปฏิเสธ (NRC 0x${r.nrc.toString(16)}): ${r.nrcText}`
      : `สำเร็จ — ตอบกลับ: ${r.raw}`, rl);
  }catch(e){ cons('er',e.message,rl); }
  finally{ await S.elm.resetHeader().catch(()=>{}); if(was) startPolling(); }
};

$('#ackRisk').onchange=e=>$('#btnRoutine').disabled=!e.target.checked;

$('#btnRoutine').onclick = async () => {
  if(!S.connected) return alert('กรุณาเชื่อมต่ออุปกรณ์ก่อน');
  const rid=$('#rcId').value.replace(/\s/g,'').toUpperCase();
  if(!/^[0-9A-F]{4}$/.test(rid)) return alert('Routine ID ต้องเป็นเลขฐาน 16 จำนวน 4 หลัก เช่น 0203');
  if(!confirm('☠ คำสั่งนี้เขียนลง ECU โดยตรง\n\nRoutine ID: '+rid+'\n\nยืนยันว่าตรวจสอบกับคู่มือรุ่นนี้แล้ว?')) return;
  const rl=$('#resetLog'), was=S.polling; stopPolling();
  try{
    await S.elm.setHeader($('#udsSh').value.trim(),$('#udsCra').value.trim());
    const ses=await S.elm.udsRaw($('#udsSession').value);
    cons(ses.negative?'er':'sy','เข้า Diagnostic Session: '+ses.raw,rl);
    await S.elm.udsRaw('3E00').catch(()=>{});             // Tester Present กันหลุด session
    const payload='31'+$('#rcSub').value+rid+$('#rcData').value.replace(/\s/g,'').toUpperCase();
    const r=await S.elm.udsRaw(payload,20000);
    cons(r.negative?'er':'rx', r.negative
      ? `ECU ปฏิเสธ (NRC 0x${r.nrc.toString(16)}): ${r.nrcText}`
      : `Routine ทำงานสำเร็จ — ตอบกลับ: ${r.raw}`, rl);
  }catch(e){ cons('er',e.message,rl); }
  finally{ await S.elm.resetHeader().catch(()=>{}); if(was) startPolling(); }
};

/* ─── Boot ─── */
buildPicker(); buildGraphSelect(); renderTune(); renderVeTable();
cons('sy','พร้อมใช้งาน — เลือกโหมดแล้วกด "เชื่อมต่อ"');
cons('sy', BleTransport.supported
  ? 'เบราว์เซอร์นี้รองรับ Web Bluetooth ✓'
  : 'เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth — ใช้ได้เฉพาะโหมดจำลอง');