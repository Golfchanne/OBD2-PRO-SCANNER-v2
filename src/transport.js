/* ═══ src/transport.js ═══ ชั้นสื่อสาร: BLE จริง + Simulator */

const PROFILES = [
  {name:'FFF0 (Vgate/Veepeak)', svc:'0000fff0-0000-1000-8000-00805f9b34fb',
   w:'0000fff2-0000-1000-8000-00805f9b34fb', n:'0000fff1-0000-1000-8000-00805f9b34fb'},
  {name:'FFF0 (สลับขั้ว)',      svc:'0000fff0-0000-1000-8000-00805f9b34fb',
   w:'0000fff1-0000-1000-8000-00805f9b34fb', n:'0000fff2-0000-1000-8000-00805f9b34fb'},
  {name:'FFE0 (HM-10/CC2541)',  svc:'0000ffe0-0000-1000-8000-00805f9b34fb',
   w:'0000ffe1-0000-1000-8000-00805f9b34fb', n:'0000ffe1-0000-1000-8000-00805f9b34fb'},
  {name:'Nordic UART',          svc:'6e400001-b5a3-f393-e0a9-e50e24dcca9e',
   w:'6e400002-b5a3-f393-e0a9-e50e24dcca9e', n:'6e400003-b5a3-f393-e0a9-e50e24dcca9e'},
  {name:'18F0 (OBDLink)',       svc:'000018f0-0000-1000-8000-00805f9b34fb',
   w:'00002af1-0000-1000-8000-00805f9b34fb', n:'00002af0-0000-1000-8000-00805f9b34fb'},
];
const OPT = [...new Set(PROFILES.map(p=>p.svc))];

export class BleTransport {
  constructor(){ this.device=this.wc=this.nc=null; this.onData=this.onClose=null;
    this.enc=new TextEncoder(); this.dec=new TextDecoder(); }
  static get supported(){ return typeof navigator!=='undefined' && !!navigator.bluetooth; }

  async connect(){
    if(!BleTransport.supported)
      throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth — ใช้ Chrome/Edge บน Android, Windows หรือ macOS');
    if(!window.isSecureContext)
      throw new Error('ต้องเปิดผ่าน HTTPS หรือ http://localhost เท่านั้น');

    this.device = await navigator.bluetooth.requestDevice({
      filters:[{namePrefix:'OBD'},{namePrefix:'OBDII'},{namePrefix:'ELM'},{namePrefix:'Vgate'},
        {namePrefix:'V-LINK'},{namePrefix:'IOS-Vlink'},{namePrefix:'VEEPEAK'},{namePrefix:'LELink'},
        {namePrefix:'Konnwei'},{namePrefix:'VIECAR'},{namePrefix:'BLE'},
        ...OPT.map(s=>({services:[s]}))],
      optionalServices:OPT
    });
    this.device.addEventListener('gattserverdisconnected',()=>this.onClose&&this.onClose());
    const server = await this.device.gatt.connect();

    let lastErr=null;
    for(const p of PROFILES){
      try{
        const svc = await server.getPrimaryService(p.svc);
        this.wc = await svc.getCharacteristic(p.w);
        this.nc = await svc.getCharacteristic(p.n);
        await this.nc.startNotifications();
        this.nc.addEventListener('characteristicvaluechanged',
          e=>this.onData && this.onData(this.dec.decode(e.target.value)));
        return {name:this.device.name||'OBD Adapter', profile:p.name};
      }catch(e){ lastErr=e; }
    }
    try{ this.device.gatt.disconnect(); }catch(_){}
    throw new Error('ไม่พบโปรไฟล์ GATT ที่รองรับ ('+(lastErr?.message||'unknown')+
      ') — อะแดปเตอร์อาจเป็น Bluetooth Classic (SPP) ซึ่งเว็บเข้าถึงไม่ได้');
  }

  async write(text){                      // BLE MTU ~20 ไบต์ ต้องหั่นก่อนส่ง
    const buf=this.enc.encode(text), CH=20;
    for(let i=0;i<buf.length;i+=CH){
      const s=buf.slice(i,i+CH);
      this.wc.properties.writeWithoutResponse
        ? await this.wc.writeValueWithoutResponse(s)
        : await this.wc.writeValue(s);
      if(buf.length>CH) await new Promise(r=>setTimeout(r,12));
    }
  }
  async disconnect(){
    try{ await this.nc?.stopNotifications(); }catch(_){}
    try{ this.device?.gatt?.disconnect(); }catch(_){}
    this.wc=this.nc=null;
  }
  get connected(){ return !!this.device?.gatt?.connected; }
}

/* ── Simulator: จำลองรถ 1.5L ที่มี "รอยรั่วอากาศ" เพื่อสาธิตโมดูลจูน ── */
export class SimTransport {
  constructor(){ this.onData=this.onClose=null; this.connected=false; this.t=0; this.cleared=false; }
  async connect(){
    this.connected=true;
    this._tick=setInterval(()=>{this.t+=0.12;},100);
    return {name:'Simulator ECU (Demo)', profile:'virtual'};
  }
  async disconnect(){ clearInterval(this._tick); this.connected=false; this.onClose&&this.onClose(); }

  _state(){
    const c=Math.sin(this.t/9);                 // วงรอบขับขี่จำลอง
    const phase=(Math.sin(this.t/17)+1)/2;      // 0=จอด 1=เร่งเต็ม
    const rpm  = phase<0.25 ? 780+c*40 : 1100+phase*4200+c*220;
    const thr  = phase<0.25 ? 3 : 8+phase*72;
    const load = phase<0.25 ? 18+c*4 : 22+phase*68;
    const map  = phase<0.25 ? 32+c*3 : 38+phase*62;
    const iat  = 39+c*2, ect=90+c*2, spd=phase<0.25?0:phase*135;
    const ve   = 0.86+phase*0.10;
    const rho  = (map*1000)/(287.05*(iat+273.15));
    const maf  = (rpm/120)*1.5*rho*ve;
    /* รอยรั่วอากาศคงที่ ≈ 1.1 g/s → เปอร์เซ็นต์สูงตอนเดินเบา ต่ำตอนโหลด */
    const leakPct = Math.min(30, (1.1/Math.max(maf,0.8))*100);
    const ltft = Math.min(24, leakPct*0.72), stft = c*3.2;
    const lam  = phase>0.75 ? 0.89 : 1.0+Math.sin(this.t*3)*0.02;
    return {rpm,thr,load,map,iat,ect,spd,maf,stft,ltft,lam};
  }

  async write(text){
    const cmd=text.trim().toUpperCase().replace(/\s+/g,'');
    await new Promise(r=>setTimeout(r,20+Math.random()*30));
    this.onData && this.onData(this._reply(cmd)+'\r\r>');
  }

  _reply(c){
    const s=this._state();
    const h=x=>Math.max(0,Math.min(255,Math.round(x))).toString(16).toUpperCase().padStart(2,'0');
    const w=x=>{const v=Math.max(0,Math.min(65535,Math.round(x))); return h(v>>8)+' '+h(v&0xFF);};
    if(c.startsWith('AT')){
      if(c==='ATZ')   return '\rELM327 v1.5';
      if(c==='ATI')   return 'ELM327 v1.5';
      if(c==='ATRV')  return (13.9+Math.sin(this.t)*0.25).toFixed(1)+'V';
      if(c==='ATDP')  return 'ISO 15765-4 (CAN 11/500)';
      if(c==='ATDPN') return 'A6';
      return 'OK';
    }
    if(c==='0100') return '41 00 BE 3F A8 13';
    if(c==='0120') return '41 20 90 07 E0 11';
    if(c==='0140') return '41 40 FA DC 80 00';
    if(c==='0101') return this.cleared?'41 01 00 07 65 00':'41 01 82 07 65 04';
    if(c==='010C') return '41 0C '+w(s.rpm*4);
    if(c==='010D') return '41 0D '+h(s.spd);
    if(c==='0105') return '41 05 '+h(s.ect+40);
    if(c==='0104') return '41 04 '+h(s.load*255/100);
    if(c==='0111') return '41 11 '+h(s.thr*255/100);
    if(c==='010F') return '41 0F '+h(s.iat+40);
    if(c==='010B') return '41 0B '+h(s.map);
    if(c==='0110') return '41 10 '+w(s.maf*100);
    if(c==='0106') return '41 06 '+h(128+s.stft*128/100);
    if(c==='0107') return '41 07 '+h(128+s.ltft*128/100);
    if(c==='0124') return '41 24 '+w(s.lam*32768)+' 20 00';
    if(c==='0134') return '41 34 '+w(s.lam*32768)+' 80 00';
    if(c==='0142') return '41 42 '+w(13900+Math.sin(this.t)*250);
    if(c==='012F') return '41 2F '+h(0.62*255);
    if(c==='0152') return '41 52 '+h(20*255/100);
    if(c==='015C') return '41 5C '+h(95+40);
    if(c==='03')   return this.cleared?'43 00':'43 02 01 71 05 07';
    if(c==='07')   return this.cleared?'47 00':'47 01 01 33 00 00 00 00';
    if(c==='0A')   return '4A 00';
    if(c==='04'){ this.cleared=true; return '44'; }
    if(c.startsWith('02')) return '42 02 0C 1A F8 42 02 0D 2E 42 02 05 62 42 02 04 55';
    if(c==='0902') return '014\r0: 49 02 01 4D 52 30\r1: 46 5A 32 39 47 33 30\r2: 30 30 31 32 33 34 35';
    if(c.startsWith('11')) return '51 '+c.slice(2,4);
    if(c.startsWith('10')) return '50 '+c.slice(2,4)+' 00 32 01 F4';
    if(c.startsWith('31')) return '71 '+c.slice(2,4)+' '+c.slice(4,6)+' '+c.slice(6,8);
    return 'NO DATA';
  }
}