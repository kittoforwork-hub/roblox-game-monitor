# Roblox Game Monitor — Cloudflare Workers version

ไฟล์ชุดนี้ถูกจัดให้ใช้กับหน้าตั้งค่า **Cloudflare Workers Builds** ซึ่งมี `Build command`, `Deploy command` และ `Root directory` โดยไม่ต้องมีช่อง `Build output directory`

## โครงสร้าง

- `public/index.html` — หน้าเว็บ
- `public/app.js` — ส่วนแสดงข้อมูลและเรียก API
- `public/style.css` — รูปแบบหน้าเว็บ
- `src/index.js` — Cloudflare Worker API (`/api/game`) และส่งไฟล์เว็บไซต์
- `wrangler.jsonc` — การตั้งค่า Worker และ static assets
- `package.json` — ระบุ Wrangler

## วิธีใส่ลง GitHub

อัปโหลด/แทนที่ไฟล์ใน Repository ให้มีโครงสร้างตามชุดนี้ โดยไฟล์ `wrangler.jsonc` และ `package.json` ต้องอยู่ระดับราก Repository และไฟล์เว็บต้องอยู่ใน `public/` อย่าเก็บ `index.html` ไว้ระดับรากแทน `public/index.html` ในโครงสร้างนี้

## Cloudflare Workers Builds configuration

ใน Workers ที่เชื่อมกับ Repository นี้ ตั้งค่า:

- Production branch: `main`
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`
- Root directory: เว้นว่าง (หรือ `/` ตามที่ UI บังคับ)

จากนั้นบันทึกแล้วสั่ง build/deploy ใหม่

> ถ้าชื่อ Worker ใน Cloudflare ไม่ใช่ `roblox-game-monitor` ให้ตรวจค่า `name` ใน `wrangler.jsonc` และให้ตรงกับ Worker ที่คุณต้องการ Deploy (ถ้าระบบของคุณระบุชื่อไว้ตายตัว)

## ทดสอบ

เปิด `https://ชื่อ-worker.workers.dev/api/game?placeId=117871374541549` โดยใช้โดเมนจริงที่ Cloudflare แสดงให้ ตรวจว่าตอบ JSON หรือไม่ จากนั้นเปิดหน้าเว็บเดียวกันและใส่ Game ID

## ข้อจำกัด

เวอร์ชันนี้อ่านข้อมูลสาธารณะจาก Roblox API เท่านั้น จึงแสดงข้อมูลเกมและจำนวนผู้เล่น ไม่ได้บันทึกรายชื่อผู้เล่นเข้า/ออก ไม่มีประวัติ และยังไม่มีระบบล็อกอิน
