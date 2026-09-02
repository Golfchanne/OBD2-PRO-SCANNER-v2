/* ═══ src/fuel.js ═══
   เอนจินวิเคราะห์และคำนวณค่าจูนน้ำมัน
   ทุกสูตรอ้างอิงหลักอุณหพลศาสตร์เครื่องยนต์จริง ไม่ใช่ค่าประมาณลอย ๆ */

/* ── ตารางเชื้อเพลิง (เน้นชนิดที่ใช้จริงในไทย) ── */
export const FUELS = {
  gas95 : {name:'เบนซิน 95 (ไร้เอทานอล)', afr:14.70, eth:0,   dens:0.745, note:'ค่ามาตรฐานอ้างอิงของ ECU ส่วนใหญ่'},
  e10   : {name:'แก๊สโซฮอล์ 91/95 (E10)', afr:14.08, eth:10,  dens:0.750, note:'ต้องการเชื้อเพลิงมากกว่าเบนซินล้วน ~4%'},
  e20   : {name:'แก๊สโซฮอล์ E20',         afr:13.47, eth:20,  dens:0.755, note:'ต้องการเชื้อเพลิงมากกว่า E10 ~4.5%'},
  e85   : {name:'แก๊สโซฮอล์ E85',         afr: 9.87, eth:85,  dens:0.782, note:'ต้องการเชื้อเพลิงมากกว่าเบนซิน ~30–40% ต้องใช้หัวฉีดใหญ่ขึ้น'},
  lpg   : {name:'LPG (แก๊สหุงต้ม)',        afr:15.60, eth:0,   dens:0.540, note:'ค่าออกเทนสูง แต่พลังงานต่อลิตรต่ำกว่าเบนซิน'},
  ngv   : {name:'NGV / CNG',              afr:17.20, eth:0,   dens:0.190, note:'สะอาดที่สุด แต่กำลังตกราว 10–15%'},
  diesel: {name:'ดีเซล B7',                afr:14.50, eth:0,   dens:0.840, note:'ทำงานแบบ lean-burn λ 1.2–6.0 ไม่มี Closed-loop แบบเบนซิน'},
};

/* ── โซนภาระเครื่องยนต์ ── */
export const ZONES = {
  idle  :{name:'เดินเบา (Idle)',        sub:'รอบ < 1,100 · ภาระ < 25%',  color:'#22d3ee'},
  cruise:{name:'ขับคงที่ (Cruise)',      sub:'ภาระ 25–60% · λ ≈ 1.00',   color:'#34d399'},
  load  :{name:'เร่ง / โหลดหนัก (WOT)',  sub:'ภาระ > 60% · λ 0.85–0.92', color:'#fbbf24'},
};

export function classifyZone(rpm, load, throttle){
  if(rpm != null && rpm < 1100 && load < 25) return 'idle';
  if(load > 60 || (throttle != null && throttle > 65)) return 'load';
  return 'cruise';
}

/* ── ความหนาแน่นอากาศจาก MAP + IAT (สมการแก๊สอุดมคติ) ──
   ρ = P / (R · T)   ;  R(อากาศแห้ง) = 287.05 J/(kg·K)  */
export function airDensity(mapKpa, iatC){
  if(mapKpa == null || iatC == null) return null;
  return (mapKpa * 1000) / (287.05 * (iatC + 273.15));   // kg/m³
}

/* ── MAF ที่ควรจะเป็นตามทฤษฎี (VE = 100%) ──
   ṁ (g/s) = (RPM / 120) × ปริมาตรกระบอกสูบ(L) × ρ(kg/m³) × VE  */
export function theoreticalMaf(rpm, dispL, mapKpa, iatC, ve = 1){
  const rho = airDensity(mapKpa, iatC);
  if(!rho || !rpm) return null;
  return (rpm / 120) * dispL * rho * ve;
}

/* ── VE จริงของเครื่องยนต์ = MAF ที่วัดได้ ÷ MAF ทฤษฎี ── */
export function calcVE(mafGs, rpm, dispL, mapKpa, iatC){
  const th = theoreticalMaf(rpm, dispL, mapKpa, iatC, 1);
  if(!th || th < 0.5 || !mafGs) return null;
  const ve = (mafGs / th) * 100;
  return (ve > 15 && ve < 220) ? ve : null;
}

/* ── AFR ↔ λ ── */
export const afrFromLambda = (lam, fuelKey) => lam * FUELS[fuelKey].afr;
export const lambdaFromAfr = (afr, fuelKey) => afr / FUELS[fuelKey].afr;

/* ── λ เป้าหมายตามโซน (เครื่องเบนซินหัวฉีดทั่วไป) ── */
export function targetLambda(zone, asp){
  if(zone === 'load') return asp === 'turbo' ? 0.82 : 0.88;
  return 1.00;
}

/* ─────────────────────────────────────────────────────────
   ตัวเก็บและวิเคราะห์ข้อมูลจูน
   ───────────────────────────────────────────────────────── */
export class FuelTuner {
  constructor(){ this.reset(); }

  reset(){
    this.samples = [];
    this.zones = { idle:[], cruise:[], load:[] };
    this.ve = {};              // key "rpmBin|mapBin" → {sum,count}
    this.startedAt = null;
  }

  /* s = {rpm, load, map, maf, iat, ect, spd, thr, stft1, ltft1, stft2, ltft2, lambda} */
  push(s, cfg){
    if(s.rpm == null || s.rpm < 300) return null;          // เครื่องดับ ไม่เก็บ
    if(s.ect != null && s.ect < 70) return null;           // ยังไม่ถึงอุณหภูมิทำงาน ค่าจะเพี้ยน

    this.startedAt = this.startedAt || Date.now();
    const zone = classifyZone(s.rpm, s.load ?? 0, s.thr);
    const trim1 = (s.stft1 ?? 0) + (s.ltft1 ?? 0);
    const trim2 = (s.stft2 != null || s.ltft2 != null) ? (s.stft2 ?? 0) + (s.ltft2 ?? 0) : null;
    const ve = calcVE(s.maf, s.rpm, cfg.dispL, s.map, s.iat);

    const rec = {...s, zone, trim1, trim2, ve, t: Date.now()};
    this.samples.push(rec);
    if(this.samples.length > 6000) this.samples.shift();
    this.zones[zone].push(rec);
    if(this.zones[zone].length > 2000) this.zones[zone].shift();

    /* สะสมลง VE Table */
    if(ve != null && s.map != null){
      const rb = Math.min(7000, Math.floor(s.rpm/500)*500);
      const mb = Math.min(110,  Math.floor(s.map/10)*10);
      const k = rb+'|'+mb;
      const c = this.ve[k] || (this.ve[k] = {sum:0, n:0});
      c.sum += ve; c.n++;
    }
    return rec;
  }

  /* สถิติต่อโซน */
  zoneStats(zone){
    const a = this.zones[zone];
    if(!a.length) return null;
    const avg = k => {
      const v = a.map(x=>x[k]).filter(x=>x!=null && isFinite(x));
      return v.length ? v.reduce((p,c)=>p+c,0)/v.length : null;
    };
    return {
      n: a.length,
      trim: avg('trim1'), trim2: avg('trim2'),
      stft: avg('stft1'), ltft: avg('ltft1'),
      lambda: avg('lambda'), ve: avg('ve'),
      rpm: avg('rpm'), load: avg('load'), maf: avg('maf'),
    };
  }

  /* ─── วินิจฉัยและคำนวณค่าชดเชย ─── */
  analyze(cfg){
    const Z = { idle:this.zoneStats('idle'), cruise:this.zoneStats('cruise'), load:this.zoneStats('load') };
    const out = [];
    const F = FUELS[cfg.fuel];
    const MIN = 25;                       // ตัวอย่างขั้นต่ำต่อโซนถึงจะเชื่อถือได้

    const ready = Object.values(Z).filter(z=>z && z.n>=MIN).length;
    if(ready === 0){
      return {zones:Z, advice:[{lv:'info', t:'ข้อมูลยังไม่พอ',
        d:'ขับใช้งานจริงต่ออีกสักพัก ให้ครบทั้ง 3 โซน: เดินเบานิ่ง ๆ 1 นาที, ขับความเร็วคงที่ 60–90 กม./ชม. 3 นาที, และเร่งเต็มคันเร่ง 2–3 ครั้ง', l:[]}],
        correction:null};
    }

    const idle = Z.idle?.n>=MIN ? Z.idle.trim : null;
    const cru  = Z.cruise?.n>=MIN ? Z.cruise.trim : null;
    const ld   = Z.load?.n>=MIN ? Z.load.trim : null;

    /* กฎที่ 1 — รั่วอากาศหลังลิ้นเร่ง (บางเฉพาะรอบเดินเบา) */
    if(idle != null && cru != null && idle > 12 && (idle - cru) > 7){
      out.push({lv:'crit', t:`รั่วอากาศหลังลิ้นปีกผีเสื้อ (Vacuum Leak) — Trim เดินเบา +${idle.toFixed(1)}%`,
        d:'อากาศรั่วเข้าปริมาณคงที่ ที่รอบเดินเบาอากาศรวมน้อย เปอร์เซ็นต์จึงพุ่ง แต่ตอนรอบสูงอากาศมากจนเจือจาง ค่าจึงลด — เป็นลายเซ็นคลาสสิกของท่อสุญญากาศรั่ว',
        l:['ตรวจท่อสุญญากาศ/ท่อหายใจฝาวาล์ว (PCV) ทุกเส้น','ตรวจปะเก็นท่อร่วมไอดีและปะเก็นเรือนลิ้นเร่ง','ตรวจซีลก้านวัดน้ำมันเครื่องและฝาเติมน้ำมัน','ตรวจวาล์ว EVAP Purge ค้างเปิด','ฉีดสเปรย์ทำความสะอาดคาร์บูรอบ ๆ ท่อไอดี ถ้ารอบเปลี่ยน = จุดรั่ว']});
    }

    /* กฎที่ 2 — บางทุกโซน */
    if([idle,cru,ld].filter(v=>v!=null && v>9).length >= 2 && !(idle>12 && cru!=null && (idle-cru)>7)){
      out.push({lv:'crit', t:'ส่วนผสมบางทั้งช่วงการทำงาน (Global Lean)',
        d:'ECU ต้องเพิ่มน้ำมันตลอดเวลา แปลว่าเชื้อเพลิงมาไม่พอ หรือเซ็นเซอร์อากาศอ่านต่ำกว่าจริง',
        l:['ล้าง/เปลี่ยนไส้กรองน้ำมันเชื้อเพลิง','วัดแรงดันรางหัวฉีด เทียบสเปกรุ่น (ทั่วไป 300–400 kPa)','ตรวจปั๊มติ๊กอ่อน — วัดกระแสและแรงดันขณะโหลด','ล้างหัวฉีดด้วยอัลตราโซนิก','ทำความสะอาดสาย MAF ด้วยน้ำยาเฉพาะ (ห้ามใช้มือแตะ)',
          `ถ้าเพิ่งเปลี่ยนมาใช้ ${F.name} ค่าบวกนี้อาจเป็นเรื่องปกติ — ดูหัวข้อค่าชดเชยด้านล่าง`]});
    }

    /* กฎที่ 3 — บางเฉพาะตอนโหลดหนัก (อันตรายที่สุด) */
    if(ld != null && ld > 12 && (cru == null || ld - cru > 6)){
      out.push({lv:'crit', t:`เชื้อเพลิงไม่พอที่โหลดสูง — Trim ช่วงเร่ง +${ld.toFixed(1)}%`,
        d:'⚠ ภาวะนี้เสี่ยงต่อการน็อคและลูกสูบละลายมากที่สุด ระบบจ่ายน้ำมันตามไม่ทันเมื่อความต้องการสูงสุด ควรหยุดเค้นเครื่องจนกว่าจะแก้ไข',
        l:['ปั๊มติ๊กหมดอายุ / สายไฟปั๊มตกแรงดัน','กรองเบนซินตัน','หัวฉีดเล็กเกินไปสำหรับเชื้อเพลิงหรือกำลังที่เพิ่มขึ้น','เร็กกูเลเตอร์แรงดันรั่ว']});
    }

    /* กฎที่ 4 — หนา */
    const richest = Math.min(...[idle,cru,ld].filter(v=>v!=null));
    if(richest < -9){
      out.push({lv:'warn', t:`ส่วนผสมหนาเกิน — Trim ${richest.toFixed(1)}%`,
        d:'ECU ต้องตัดน้ำมันลงตลอด แปลว่าน้ำมันเข้ามากเกินหรืออากาศถูกอ่านสูงกว่าจริง',
        l:['หัวฉีดรั่ว/ปิดไม่สนิท','แรงดันรางสูงเกิน — เร็กกูเลเตอร์ค้าง','ไส้กรองอากาศตัน ทำให้ VE ตก','เซ็นเซอร์อุณหภูมิน้ำ (ECT) อ่านเย็นค้าง ECU จึงเติมน้ำมันเผื่อ','ถ่านคาร์บอนอิ่มตัวจากระบบ EVAP']});
    }

    /* กฎที่ 5 — ปกติ */
    if([idle,cru,ld].filter(v=>v!=null).every(v=>Math.abs(v)<=6)){
      out.push({lv:'good', t:'ระบบเชื้อเพลิงอยู่ในเกณฑ์ดีมาก',
        d:'Fuel Trim ทุกโซนอยู่ในช่วง ±6% ซึ่งถือว่าดีเยี่ยม (เกณฑ์ยอมรับทั่วไปคือ ±10%) ไม่จำเป็นต้องปรับแต่งอะไร', l:[]});
    }

    /* กฎที่ 6 — VE ผิดปกติ */
    if(Z.load?.ve != null){
      const ve = Z.load.ve;
      if(ve > 108 && cfg.asp === 'na')
        out.push({lv:'warn', t:`VE ที่โหลดสูง = ${ve.toFixed(0)}% (สูงผิดปกติสำหรับเครื่อง NA)`,
          d:'เครื่อง NA ทั่วไปทำได้ 85–100% ค่าที่เกินนี้มักแปลว่า MAF อ่านค่าสูงกว่าจริง หรือค่าความจุ/ชนิดเครื่องที่กรอกไม่ตรง',
          l:['ตรวจสอบว่ากรอกความจุเครื่องยนต์ถูกต้อง','ทำความสะอาดหรือเปลี่ยน MAF','ตรวจรอยรั่วท่อไอดีระหว่าง MAF กับลิ้นเร่ง']});
      if(ve < 72)
        out.push({lv:'warn', t:`VE ที่โหลดสูง = ${ve.toFixed(0)}% (ต่ำผิดปกติ)`,
          d:'เครื่องยนต์หายใจไม่ออก — อากาศเข้าได้น้อยกว่าที่ควรเป็น',
          l:['ไส้กรองอากาศตัน','แคตตาไลติกอุดตัน / ท่อไอเสียตัน (วัดแรงดันย้อนกลับ)','วาล์วรั่ว หรือแหวนลูกสูบสึก — ควรวัดกำลังอัด','ไทม์มิ่งโซ่/สายพานเลื่อนหนึ่งฟัน','คราบเขม่าสะสมในลิ้นเร่งและวาล์วไอดี']});
    }

    /* กฎที่ 7 — λ ที่โหลดหนัก */
    if(Z.load?.lambda != null){
      const lam = Z.load.lambda, tgt = targetLambda('load', cfg.asp);
      if(lam >= 0.99)
        out.push({lv:'crit', t:`λ ขณะเร่งเต็ม = ${lam.toFixed(2)} — บางเกินไปอย่างอันตราย`,
          d:`เครื่องยนต์ควรอยู่ที่ λ ≈ ${tgt} (AFR ${(tgt*F.afr).toFixed(1)}:1) ตอนโหลดเต็ม เพื่อใช้น้ำมันส่วนเกินระบายความร้อนห้องเผาไหม้ ค่าที่ ~1.0 เสี่ยงน็อคและลูกสูบเสียหาย`,
          l:['หยุดใช้รอบสูง/บรรทุกหนักจนกว่าจะแก้ไข','ตรวจระบบจ่ายน้ำมันตามข้อด้านบน','ถ้าเป็นรถแต่ง ต้องปรับแมพเพิ่มน้ำมันในโซน WOT']});
      else if(lam < tgt - 0.09)
        out.push({lv:'info', t:`λ ขณะเร่ง = ${lam.toFixed(2)} — หนากว่าค่าเหมาะสม`,
          d:'ปลอดภัยต่อเครื่อง แต่สิ้นเปลืองน้ำมัน กำลังตก และเขม่าจับแคตเร็ว', l:[]});
    }

    /* ── คำนวณค่าชดเชยที่ควรใส่ในเครื่องมือจูน ── */
    const base = cru ?? idle ?? ld;
    let correction = null;
    if(base != null){
      const mafScale = 1 + base/100;                 // MAF อ่านต่ำ → ต้องคูณขึ้น
      const injScale = 1 / (1 + base/100);           // หรือลดค่าคงที่หัวฉีดลงแทน
      correction = {
        basis: cru!=null?'โซนขับคงที่ (Cruise)':(idle!=null?'โซนเดินเบา':'โซนโหลด'),
        trim: base,
        mafScale, injScale,
        mafPct: (mafScale-1)*100,
        injPct: (injScale-1)*100,
      };
      const dir = base > 0 ? 'เพิ่ม' : 'ลด';
      out.push({lv:'info', t:'ค่าชดเชยที่แนะนำสำหรับเครื่องมือจูน (Flash Tool)',
        d:`อ้างอิงจาก Trim เฉลี่ย ${base.toFixed(1)}% ใน${correction.basis} — เลือกทำอย่างใดอย่างหนึ่งเท่านั้น อย่าทำพร้อมกันทั้งสองทาง`,
        l:[`วิธี A · ปรับสเกล MAF: คูณตาราง MAF ด้วย ${mafScale.toFixed(4)} (${dir} ${Math.abs(correction.mafPct).toFixed(1)}%)`,
           `วิธี B · ปรับค่าคงที่หัวฉีด: คูณด้วย ${injScale.toFixed(4)} (${base>0?'ลด':'เพิ่ม'} ${Math.abs(correction.injPct).toFixed(1)}%)`,
           'หลังแฟลชแล้ว: ล้างค่าเรียนรู้ (Mode 04) → อุ่นเครื่องถึงพัดลมตัด → เก็บข้อมูลใหม่ → ทำซ้ำจนกว่า Trim จะอยู่ใน ±5%',
           'ปรับครั้งละไม่เกิน 10% เสมอ ห้ามกระโดดทีเดียว']});
    }

    /* ── ข้อมูลการเปลี่ยนชนิดเชื้อเพลิง ── */
    if(cfg.fuel !== 'gas95'){
      const need = (FUELS.gas95.afr / F.afr - 1) * 100;
      out.push({lv:'info', t:`หมายเหตุการใช้ ${F.name}`,
        d:`${F.note} — เทียบกับเบนซิน 95 เชื้อเพลิงชนิดนี้ต้องการปริมาณมากขึ้นประมาณ ${need.toFixed(1)}% เพื่อให้ได้ λ = 1.00`,
        l:F.eth >= 85
          ? ['E85 ต้องใช้หัวฉีดโตขึ้นอย่างน้อย 30–40% ปั๊มติ๊กแรงขึ้น และท่อยางทนเอทานอล',
             'ต้องเปลี่ยนน้ำมันเครื่องถี่ขึ้น เพราะเอทานอลปนลงห้องเครื่องได้ง่ายกว่า',
             'สตาร์ตเย็นยากขึ้น — ต้องเพิ่ม Cranking Fuel ในแมพ',
             'ถ้ารถไม่ใช่ Flex-Fuel จากโรงงาน อย่าเติมโดยไม่จูน']
          : ['ตรวจสอบคู่มือรถว่ารองรับเชื้อเพลิงชนิดนี้ก่อนใช้ต่อเนื่อง',
             'ถ้า Trim ค้างบวกเกิน 10% ตลอด แปลว่า ECU ชดเชยจนสุดขอบ ควรจูนเพิ่ม']});
    }

    return {zones:Z, advice:out, correction};
  }

  /* ── ส่งออก VE Table เป็นตาราง 2 มิติ ── */
  veMatrix(){
    const rpms = [...new Set(Object.keys(this.ve).map(k=>+k.split('|')[0]))].sort((a,b)=>a-b);
    const maps = [...new Set(Object.keys(this.ve).map(k=>+k.split('|')[1]))].sort((a,b)=>b-a);
    return {rpms, maps, get:(r,m)=>{
      const c = this.ve[r+'|'+m];
      return c ? c.sum/c.n : null;
    }};
  }

  /* ── รายงานข้อความสำหรับส่งลูกค้า/เก็บแฟ้มอู่ ── */
  report(cfg, vehInfo){
    const a = this.analyze(cfg), F = FUELS[cfg.fuel];
    const L = [];
    L.push('รายงานวิเคราะห์ระบบเชื้อเพลิง (Fuel Trim & VE Analysis)');
    L.push('วันที่: ' + new Date().toLocaleString('th-TH'));
    L.push('ข้อมูลรถ: ' + vehInfo);
    L.push(`เครื่องยนต์: ${cfg.dispL} ลิตร ${cfg.cyl} สูบ ${cfg.asp==='turbo'?'Turbo':'NA'}`);
    L.push(`เชื้อเพลิง: ${F.name} — AFR สโตอิชิโอเมตริก ${F.afr}:1`);
    L.push(`จำนวนตัวอย่าง: ${this.samples.length}`);
    L.push('='.repeat(66), '');
    L.push('[ Fuel Trim แยกตามโซน ]');
    for(const [k,z] of Object.entries(a.zones)){
      if(!z){ L.push(`  ${ZONES[k].name}: ยังไม่มีข้อมูล`); continue; }
      L.push(`  ${ZONES[k].name} (${z.n} ตัวอย่าง)`);
      L.push(`     STFT ${z.stft?.toFixed(1) ?? '-'}%  |  LTFT ${z.ltft?.toFixed(1) ?? '-'}%  |  รวม ${z.trim?.toFixed(1) ?? '-'}%`);
      L.push(`     λ ${z.lambda?.toFixed(3) ?? '-'}  |  AFR ${z.lambda?(z.lambda*F.afr).toFixed(2):'-'}:1  |  VE ${z.ve?.toFixed(1) ?? '-'}%`);
    }
    L.push('', '[ ผลวินิจฉัย ]');
    a.advice.forEach((x,i)=>{
      L.push(`  ${i+1}. [${x.lv.toUpperCase()}] ${x.t}`);
      L.push('     ' + x.d);
      x.l.forEach(y=>L.push('      - ' + y));
    });
    if(a.correction){
      L.push('', '[ ค่าชดเชยที่แนะนำ ]');
      L.push(`  สเกล MAF     : × ${a.correction.mafScale.toFixed(4)}`);
      L.push(`  สเกลหัวฉีด   : × ${a.correction.injScale.toFixed(4)}`);
    }
    L.push('', '[ VE Table ]');
    const m = this.veMatrix();
    L.push('  MAP\\RPM  ' + m.rpms.map(r=>String(r).padStart(7)).join(''));
    m.maps.forEach(mp=>{
      L.push('  ' + String(mp).padStart(5) + '    ' +
        m.rpms.map(r=>{ const v=m.get(r,mp); return (v?v.toFixed(0):'-').padStart(7); }).join(''));
    });
    L.push('', '— หมายเหตุ: ค่าชดเชยเป็นข้อมูลประกอบการตัดสินใจ การเขียนแมพลง ECU',
      '  ต้องทำด้วยเครื่องมือแฟลชที่รองรับรุ่นนั้นโดยช่างผู้ชำนาญเท่านั้น');
    return L.join('\n');
  }
}