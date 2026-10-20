# Roblox Game Monitor — เวอร์ชันพื้นฐาน

เวอร์ชันนี้ออกแบบสำหรับคนที่มีแค่ Game ID, GitHub และ Cloudflare โดยยังไม่ต้องติดตั้ง Roblox Studio Script, ฐานข้อมูล, API Key หรือระบบล็อกอิน

## สิ่งที่ทำได้
- ใส่ Roblox Place ID หรือ URL เกมแล้วดูชื่อเกม ผู้สร้าง จำนวนผู้เล่นที่กำลังเล่น ยอด Visits และ Max Players
- ตรวจสอบข้อมูลซ้ำทุก 60 วินาที
- จำ Place ID ล่าสุดไว้ในเบราว์เซอร์เครื่องนั้น
- ใช้ Roblox public endpoints ผ่าน Cloudflare Pages Function เพื่อไม่ให้เบราว์เซอร์เรียก API โดยตรง

## ข้อจำกัด
มีเพียง Game ID ยังไม่สามารถดูชื่อผู้เล่นรายคนหรือบันทึกว่าใครเข้า/ออกเวลาใดได้ เวอร์ชันนี้ไม่ได้เก็บประวัติบนเซิร์ฟเวอร์และยังไม่มีระบบล็อกอิน เพราะยังไม่มี event จากเกมส่งเข้ามา หากต้องการ join/leave logs ต้องเพิ่ม Script ใน Roblox Studio แล้วเพิ่ม storage/API ต่อภายหลัง

## วิธีติดตั้งผ่าน GitHub + Cloudflare Pages

### 1) อัปโหลดโค้ดไป GitHub
1. สร้าง repository ใหม่บน GitHub เช่น `roblox-game-monitor-basic`
2. แตกไฟล์ ZIP นี้
3. อัปโหลดไฟล์และโฟลเดอร์ทั้งหมด โดยให้ `index.html` อยู่ที่ root ของ repository และให้มีโฟลเดอร์ `functions/api/game.js`
4. Commit การเปลี่ยนแปลง

### 2) เชื่อม Cloudflare Pages กับ GitHub
1. เข้าสู่ Cloudflare Dashboard
2. ไปที่ **Workers & Pages** แล้วเลือก **Create application** → **Pages** → **Connect to Git** (ชื่อปุ่มอาจต่างกันตามหน้าจอ)
3. เลือก repository ที่สร้างไว้
4. ตั้งค่า Framework preset เป็น **None**
5. Build command: ปล่อยว่าง
6. Build output directory: ` / ` ไม่ต้องใส่ช่องว่างจริง ให้ใช้ `.` (จุด) เป็น output directory
7. กด Deploy
8. รอ Cloudflare สร้าง URL เช่น `https://ชื่อโปรเจกต์.pages.dev` แล้วเปิดเว็บ

> ต้อง Deploy ผ่าน **Cloudflare Pages** ไม่ใช่ GitHub Pages เพราะโฟลเดอร์ `functions/` ใช้ทำ API endpoint บน Cloudflare

### 3) ใช้งาน
1. เปิดหน้าเว็บ Cloudflare Pages
2. ใส่เลข Place ID ที่อยู่หลัง `roblox.com/games/` ใน URL ของเกม หรือวาง URL เต็มลงในช่อง
3. กด **ตรวจสอบเกม**

## หากเว็บแสดงข้อผิดพลาด
- `ไม่พบ Game ID`: ตรวจสอบว่าตัวเลขที่ใส่คือ Place ID จากลิงก์เกม
- `Roblox ตอบกลับผิดปกติ`: ลองใหม่ภายหลัง อาจเป็นข้อจำกัดชั่วคราวหรืออัตราการเรียก API
- หน้าเว็บเปิดได้แต่ `/api/game` ตอบ `404`: ตรวจว่าโฟลเดอร์ `functions/api/game.js` อยู่ที่ root ของ repository แล้ว Deploy ผ่าน Cloudflare Pages ใหม่

## โครงสร้างไฟล์
```text
roblox-game-monitor-basic/
├── index.html
├── style.css
├── app.js
├── functions/
│   └── api/
│       └── game.js
└── README_TH.md
```

## ความเป็นส่วนตัว / ความปลอดภัย
- เว็บนี้ใช้เฉพาะข้อมูลเกมที่ Roblox เปิดเผยต่อสาธารณะ
- ไม่ต้องกรอกรหัสผ่าน Roblox, Cookie หรือ API Key
- ข้อมูลที่บันทึกใน localStorage มีแค่ Place ID ล่าสุดและอยู่ในเบราว์เซอร์เครื่องนั้น
- หากต้องการเก็บ log รายชื่อผู้เล่นและเวลาเข้า/ออกในรุ่นต่อไป ค่อยเพิ่ม Roblox Server Script, Cloudflare Worker/Pages Function ที่รับ event, และ Cloudflare D1 สำหรับเก็บข้อมูล 30 วัน
