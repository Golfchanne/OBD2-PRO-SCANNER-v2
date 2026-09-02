/* ═══ src/presets.js ═══
   พรีเซต CAN Header ตามยี่ห้อ (ค่าที่ใช้กันแพร่หลาย) + ขั้นตอนรีเซตที่ปลอดภัย
   ⚠ Routine ID ไม่ได้ใส่ค่าตายตัวไว้โดยเจตนา เพราะต่างกันตามปีและตลาด
     ต้องยืนยันกับ Service Manual ของรุ่นนั้นก่อนส่งเสมอ                       */

export const BRANDS = {
  generic:{ name:'มาตรฐาน OBD2 (ทุกยี่ห้อ)', sh:'7E0', cra:'7E8', session:'1003',
    notes:'Functional address 7DF สำหรับ broadcast · ECU เครื่องยนต์มักตอบที่ 7E8',
    relearn:['ล้างค่าเรียนรู้ด้วย Mode 04','อุ่นเครื่องจนพัดลมหม้อน้ำทำงาน 1 รอบ','ปล่อยเดินเบา 10 นาที ปิดแอร์ ปิดไฟ ไม่เหยียบคันเร่ง','ขับใช้งานผสมเมือง+ทางไกลอีก 80–150 กม. ให้ Readiness ครบ']},

  toyota:{ name:'Toyota / Lexus', sh:'7E0', cra:'7E8', session:'1003',
    notes:'ECU เครื่องยนต์ 7E0/7E8 · ABS 7B0/7B8 · ถุงลม 7A0/7A8 · บางรุ่นเก่าใช้ ISO 9141-2',
    relearn:['รีเซตค่าเรียนรู้: Mode 04 หรือถอดขั้วลบแบต 10 นาที','Throttle Learn: บิด ON ไม่สตาร์ต 10 วินาที → สตาร์ต → เดินเบา 10 นาที ปิดแอร์','อย่าเหยียบคันเร่งระหว่างเรียนรู้รอบเดินเบา']},

  honda:{ name:'Honda / Acura', sh:'7E0', cra:'7E8', session:'1003',
    notes:'ECU 7E0/7E8 · Honda มักต้อง Idle Learn หลังล้างค่าทุกครั้ง ไม่งั้นรอบเดินเบาจะสวิง',
    relearn:['ล้างด้วย Mode 04','สตาร์ตเครื่องจนอุ่นถึงพัดลมทำงาน','ปล่อยเดินเบา 10 นาที ปิดแอร์ ปิดไฟ ปิดพัดลมในห้องโดยสาร ล้อตรง','ห้ามเหยียบคันเร่งเด็ดขาดระหว่าง 10 นาทีนี้']},

  isuzu:{ name:'Isuzu (ดีเซล)', sh:'7E0', cra:'7E8', session:'1003',
    notes:'ดีเซลคอมมอนเรล · งานที่พบบ่อยคือ Injector Code Programming และ DPF Regen — ต้องใช้ค่าเฉพาะรุ่น',
    relearn:['ดีเซลไม่มี Closed-loop Fuel Trim แบบเบนซิน ให้ดู Injector Correction (Balance) แทน','DPF Regen แบบบังคับต้องทำในที่โล่ง ท่อไอเสียร้อนจัด เกิน 600°C','ต้องรีเซตค่าถ่วงหัวฉีดใหม่ทุกครั้งที่เปลี่ยนหัวฉีด']},

  nissan:{ name:'Nissan', sh:'7E0', cra:'7E8', session:'1003',
    notes:'ECU 7E0/7E8 · ขั้นตอน Idle Air Volume Learning ทำด้วยแป้นคันเร่งได้โดยไม่ต้องใช้เครื่องมือ',
    relearn:['Accelerator Pedal Released Position Learning: ON 2 วิ → OFF 10 วิ (ทำ 2 รอบ)','Throttle Valve Closed Position Learning: ON 10 วิ → OFF 10 วิ','Idle Air Volume Learning: อุ่นเครื่อง → ทำตามลำดับเหยียบคันเร่ง 5 ครั้งใน 5 วินาทีตามคู่มือรุ่นนั้น']},

  mazda:{ name:'Mazda', sh:'7E0', cra:'7E8', session:'1003',
    notes:'SkyActiv ใช้อัตราส่วนอัดสูงมาก ไวต่อคุณภาพน้ำมันและค่า Fuel Trim ผิดปกติ',
    relearn:['ล้างด้วย Mode 04','อุ่นเครื่องถึงอุณหภูมิทำงาน','เดินเบา 10 นาที แล้วขับใช้งานปกติ 1 ถัง']},

  mitsubishi:{ name:'Mitsubishi', sh:'7E0', cra:'7E8', session:'1003',
    notes:'ECU 7E0/7E8 · รุ่นก่อนปี 2008 บางรุ่นใช้ ISO 14230-4 (KWP)',
    relearn:['ล้างด้วย Mode 04 แล้วขับ Drive Cycle ผสม 100 กม.']},

  ford:{ name:'Ford / Mazda BT-50', sh:'7E0', cra:'7E8', session:'1003',
    notes:'ใช้ HS-CAN 500k · โมดูลอื่นอยู่บน MS-CAN ซึ่งอะแดปเตอร์ทั่วไปเข้าไม่ถึง',
    relearn:['ล้างด้วย Mode 04','KAM (Keep Alive Memory) รีเซตโดยถอดแบต 15 นาที','ขับ Drive Cycle เต็มรูปแบบเพื่อสร้าง Adaptive Table ใหม่']},

  vw:{ name:'VW / Audi / Skoda', sh:'7E0', cra:'7E8', session:'1003',
    notes:'กลุ่ม VAG ใช้ UDS เต็มรูปแบบ · หลายฟังก์ชันต้องผ่าน Security Access (0x27) ซึ่งเป็นความลับผู้ผลิต',
    relearn:['Throttle Body Alignment ต้องทำผ่าน Basic Setting เฉพาะทาง','ค่า Readiness ของ VAG ใช้เวลานานกว่ายี่ห้ออื่น']},

  bmw:{ name:'BMW / MINI', sh:'6F1', cra:'612', session:'1003',
    notes:'ใช้ Tester Address 0xF1 · โครงสร้าง Header ต่างจาก ISO-TP ทั่วไป ต้องตั้ง ATSH ให้ถูกรูปแบบ',
    relearn:['รีเซต Adaptation ต้องทำผ่านโปรโตคอลเฉพาะของ BMW','ระวังโมดูล FRM/CAS การส่งคำสั่งผิดทำให้โมดูลตายถาวรได้']},
};

/* บริการ UDS ที่ใช้บ่อย (อ้างอิง ISO 14229-1) */
export const UDS_SERVICES = {
  '10':'Diagnostic Session Control — เปลี่ยนโหมดวินิจฉัย',
  '11':'ECU Reset — รีบูตกล่อง',
  '14':'Clear Diagnostic Information — ล้างรหัสฝั่ง UDS',
  '19':'Read DTC Information — อ่านรหัสแบบละเอียด',
  '22':'Read Data By Identifier — อ่านค่าเฉพาะผู้ผลิต',
  '27':'Security Access — ปลดล็อกด้วย Seed/Key (ลิขสิทธิ์ผู้ผลิต)',
  '2E':'Write Data By Identifier — เขียนค่าลง ECU',
  '31':'Routine Control — สั่งรันรูทีน เช่น ล้างค่า Adaptation',
  '3E':'Tester Present — กันหลุด Session',
};