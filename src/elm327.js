/* ═══ src/elm327.js ═══ ไดรเวอร์ ELM327: คิวคำสั่ง, parser, ISO-TP, UDS */

export class Elm327 {
  constructor(transport, logger){
    this.tp=transport; this.log=logger||(()=>{});
    this.buf=''; this.pending=null; this.queue=Promise.resolve(); this.protocol='unknown';
    this.tp.onData = chunk => this._onData(chunk);
  }

  _onData(chunk){
    this.buf += chunk;
    this.log('rx', chunk.replace(/[\r\n]+/g,' ').trim());
    if(this.buf.includes('>') && this.pending){
      const raw=this.buf.slice(0,this.buf.indexOf('>')); this.buf='';
      const p=this.pending; this.pending=null; clearTimeout(p.timer); p.resolve(raw);
    }
  }

  send(cmd, timeout=5000){
    this.queue = this.queue.then(()=> new Promise((resolve,reject)=>{
      this.buf='';
      this.pending={resolve, timer:setTimeout(()=>{
        this.pending=null; reject(new Error('หมดเวลารอตอบกลับ: '+cmd));},timeout)};
      this.log('tx', cmd);
      this.tp.write(cmd+'\r').catch(e=>{
        clearTimeout(this.pending?.timer); this.pending=null; reject(e);});
    }));
    return this.queue;
  }

  async init(){
    await this.send('ATZ',9000);
    await this.send('ATE0');   await this.send('ATL0');
    await this.send('ATS0');   await this.send('ATH0');
    await this.send('ATAT1');  await this.send('ATSP0',9000);
    await this.send('0100',12000).catch(()=>{});
    this.protocol=(await this.send('ATDP').catch(()=>'unknown')).trim();
    this.log('sy','โปรโตคอลที่ตรวจพบ: '+this.protocol);
    return this.protocol;
  }

  static parseBytes(raw){
    const lines = raw.split(/[\r\n]+/).map(l=>l.trim()).filter(Boolean)
      .filter(l=>!/^(SEARCHING|BUS INIT|OK|ELM327|\?|>)/i.test(l));
    if(lines.some(l=>/NO DATA|UNABLE TO CONNECT|CAN ERROR|STOPPED|BUS BUSY|DATA ERROR/i.test(l)))
      return {bytes:[], error:lines.join(' ')};
    let hex='';
    for(let line of lines){
      if(/^[0-9A-F]{3}$/i.test(line.replace(/\s/g,''))) continue;   // บรรทัดความยาวรวม
      line=line.replace(/^\s*[0-9A-F]\s*:\s*/i,'');                 // ตัด prefix multi-frame
      line=line.replace(/^[0-9A-F]{3}\s+/i,'');                     // ตัด header (กรณี ATH1)
      hex+=line.replace(/[^0-9A-F]/gi,'');
    }
    if(hex.length%2) hex=hex.slice(0,-1);
    const bytes=[];
    for(let i=0;i<hex.length;i+=2) bytes.push(parseInt(hex.substr(i,2),16));
    return {bytes, error:null, hex};
  }

  async requestPid(pid, timeout=2200){
    const raw=await this.send(pid,timeout);
    const {bytes,error}=Elm327.parseBytes(raw);
    if(error) return {data:null,error};
    const mode=parseInt(pid.substr(0,2),16)+0x40;
    const idx=bytes.indexOf(mode);
    if(idx<0) return {data:null,error:'ไม่พบ response header 0x'+mode.toString(16)};
    return {data:bytes.slice(idx+(pid.length>2?2:1)), error:null, all:bytes};
  }

  async readDtcRaw(mode){
    const raw=await this.send(mode,6000);
    const {bytes,error}=Elm327.parseBytes(raw);
    if(error) return {pairs:[],error};
    const resp=parseInt(mode,16)+0x40, pairs=[]; let i=0;
    while(i<bytes.length){
      if(bytes[i]!==resp){ i++; continue; }
      i++;
      const rem=bytes.length-i;
      if(bytes[i]!==undefined && bytes[i]<=0x10 && rem>=1+bytes[i]*2) i++;   // ไบต์จำนวนรหัส (CAN)
      while(i+1<bytes.length && bytes[i]!==resp){ pairs.push([bytes[i],bytes[i+1]]); i+=2; }
    }
    return {pairs,error:null};
  }

  async clearDtc(){
    const raw=await this.send('04',8000);
    return {ok:/44|OK/i.test(raw.replace(/\s/g,'')), raw:raw.trim()};
  }

  async readVin(){
    const raw=await this.send('0902',6000);
    const {bytes,error}=Elm327.parseBytes(raw);
    if(error) return null;
    const idx=bytes.indexOf(0x49);
    if(idx<0) return null;
    const ascii=bytes.slice(idx+3).filter(b=>b>=0x20&&b<=0x7E).map(b=>String.fromCharCode(b)).join('');
    const vin=ascii.replace(/[^A-HJ-NPR-Z0-9]/gi,'').slice(-17);
    return vin.length===17 ? vin.toUpperCase() : (ascii.trim()||null);
  }

  async readStatus(){
    const r=await this.requestPid('0101',3000);
    if(!r.data||r.data.length<4) return null;
    const [A,B,C,D]=r.data, spark=!(B&0x08);
    const mk=(av,inc,name)=>({name, available:av, complete: av?!inc:null});
    return {
      mil:!!(A&0x80), dtcCount:A&0x7F, spark,
      monitors:[
        mk(!!(B&0x01),!!(B&0x10),'Misfire — จุดระเบิดผิดจังหวะ'),
        mk(!!(B&0x02),!!(B&0x20),'Fuel System — ระบบเชื้อเพลิง'),
        mk(!!(B&0x04),!!(B&0x40),'Comprehensive Components'),
        mk(!!(C&0x01),!!(D&0x01),spark?'Catalyst — แคตตาไลติก':'NMHC Catalyst'),
        mk(!!(C&0x02),!!(D&0x02),spark?'Heated Catalyst':'NOx / SCR'),
        mk(!!(C&0x04),!!(D&0x04),spark?'EVAP — ระบบไอน้ำมัน':'ไม่ใช้งาน'),
        mk(!!(C&0x08),!!(D&0x08),spark?'Secondary Air':'Boost Pressure'),
        mk(!!(C&0x10),!!(D&0x10),spark?'A/C Refrigerant':'ไม่ใช้งาน'),
        mk(!!(C&0x20),!!(D&0x20),spark?'Oxygen Sensor':'Exhaust Gas Sensor'),
        mk(!!(C&0x40),!!(D&0x40),spark?'O2 Sensor Heater':'PM Filter (DPF)'),
        mk(!!(C&0x80),!!(D&0x80),spark?'EGR System':'EGR / VVT'),
      ]};
  }

  /* ── UDS (ISO 14229) ── */
  async setHeader(tx,rx){
    await this.send('ATSH'+tx.toUpperCase());
    if(rx) await this.send('ATCRA'+rx.toUpperCase());
    await this.send('ATFCSH'+tx.toUpperCase()).catch(()=>{});
    await this.send('ATFCSD300000').catch(()=>{});
    await this.send('ATFCSM1').catch(()=>{});
  }
  async resetHeader(){
    await this.send('ATCRA').catch(()=>{});
    await this.send('ATSP0').catch(()=>{});
  }
  async udsRaw(hex, timeout=9000){
    const raw=await this.send(hex.replace(/\s+/g,'').toUpperCase(), timeout);
    const p=Elm327.parseBytes(raw), neg=p.bytes[0]===0x7F;
    return {raw:raw.trim(), bytes:p.bytes, negative:neg,
      nrc:neg?p.bytes[2]:null, nrcText:neg?(NRC[p.bytes[2]]||'ไม่ทราบรหัสปฏิเสธ'):null};
  }
}

export const NRC = {
  0x10:'ปฏิเสธคำสั่งทั่วไป', 0x11:'ไม่รองรับ Service นี้', 0x12:'ไม่รองรับ Sub-function นี้',
  0x13:'ความยาวข้อความไม่ถูกต้อง', 0x22:'เงื่อนไขไม่ถูกต้อง (เครื่องต้องดับ/รอบต้องนิ่ง)',
  0x24:'ลำดับคำสั่งผิด — ต้องเข้า Session ก่อน', 0x31:'ค่าพารามิเตอร์นอกช่วงที่ยอมรับ',
  0x33:'ถูกปฏิเสธด้านความปลอดภัย — ต้องผ่าน Security Access (0x27)',
  0x35:'Security Key ไม่ถูกต้อง', 0x72:'การเขียนหน่วยความจำล้มเหลว',
  0x78:'กำลังประมวลผล โปรดรอ', 0x7E:'ไม่รองรับ Sub-function ใน Session นี้',
  0x7F:'ไม่รองรับ Service ใน Session นี้',
};