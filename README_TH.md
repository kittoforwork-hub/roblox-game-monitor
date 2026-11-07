# Roblox Game Monitor 2.3.0

ชุดนี้แก้ปัญหา Worker API 404 โดยให้ `wrangler.jsonc` เป็น Wrangler config หลักเพียงไฟล์เดียวและชี้ไป `worker/index.js` ซึ่งมี API routes ครบ รวมถึงเตรียม API สำหรับรับ event ผู้เล่น Roblox join/leave ผ่าน server-to-server token authentication

รุ่น 2.3.0 ปรับหน้าภาพรวมและเมนูมือถือ แยกยอดผู้เล่นล่าสุดจากข้อมูลเก่า และแก้กราฟแสดงผิดช่วงเมื่อสลับช่วงเวลาต่อเนื่อง หากใช้ D1 เดิมที่มี migrations 0001 และ 0002 อยู่แล้ว สามารถ deploy ทับได้เลย

## โครงสร้าง

- `public/` — Dashboard, CSS และ frontend JavaScript
- `worker/index.js` — API `/api/health`, `/api/game`, `/api/games`, `/api/history` และ telemetry
- `migrations/0001_init.sql` — ตารางเดิมสำหรับ game snapshots และ rate limit
- `migrations/0002_player_telemetry.sql` — ตาราง player event log และ active session projection
- `roblox/PlayerTelemetry.server.lua` — ตัวอย่าง Script สำหรับวางใน `ServerScriptService`
- `wrangler.jsonc` — configuration หลักพร้อม D1 binding จากโปรเจกต์เดิม

## ติดตั้ง/Deploy

```bash
npm install
npx wrangler login
npx wrangler d1 create roblox-monitor-db
```

นำ `database_id` ที่ได้ไปใส่ใน `wrangler.jsonc` (ถ้ามี D1 เดิม ให้ใช้ ID เดิม) แล้วรัน:

```bash
npx wrangler d1 migrations apply roblox-monitor-db --remote
npx wrangler secret put RATE_LIMIT_SALT
npx wrangler secret put ROBLOX_INGEST_TOKEN
npm test
npm run check
npx wrangler deploy
```

`ROBLOX_INGEST_TOKEN` ต้องเป็น secret สุ่มยาวอย่างน้อย 32 ตัวอักษร (แนะนำสุ่ม 32 bytes) และต้องตั้งค่าเดียวกันเป็น Roblox Secret ชื่อ `RobloxMonitorToken` ใน Creator Hub ก่อนเปิด telemetry

## API

| Method | Route | สิทธิ์ | จุดประสงค์ |
|---|---|---|---|
| GET | `/api/health` | Public | ตรวจ Worker, D1 และ telemetry schema |
| GET | `/api/game?placeId=123` | Public | รายละเอียดเกมเดียว |
| GET | `/api/games?placeIds=123,456` | Public | รายละเอียดหลายเกม |
| GET | `/api/history?placeId=123&range=24h` | Public | ประวัติ snapshot |
| POST | `/api/roblox/player-events` | Bearer token | รับ join/leave events จาก Roblox server |
| GET | `/api/roblox/players?placeId=123` | Bearer token | อ่าน active sessions |
| GET | `/api/roblox/player-events?placeId=123&limit=100` | Bearer token | อ่าน event log |

ดูขั้นตอนแบบละเอียด ตัวอย่าง payload, curl, Lua script และแนวทางตรวจ 404 ใน `README-TH.txt`

## ทดสอบ

```bash
npm test
npm run check
```

หลัง deploy ให้เปิด `https://ชื่อ-worker.workers.dev/api/health` ต้องได้ `ok: true`, และหลัง apply migration 0002 กับตั้ง secret แล้ว `telemetry.schemaReady: true`, `telemetry.configured: true`

เอกสารทางการ: [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/), [Cloudflare D1](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Roblox HttpService](https://create.roblox.com/docs/reference/engine/classes/HttpService).

## มีอะไรใหม่ใน 2.2.0

- UI ใหม่แนวองค์กร: ภาพรวมทุกเกม (ตาราง/การ์ด), หน้าเปรียบเทียบหลายเกมบนกราฟเดียว, หน้ารายละเอียดเกม, การแจ้งเตือน, ขอบเขตและนโยบายข้อมูล
- `GET /api/histories?placeIds=1,2,3&range=24h` ดึงประวัติหลายเกมในคำขอเดียว
- Cron ทุก 5 นาที เก็บ snapshot ของเกมที่มีคนเปิดดูใน 3 วันล่าสุด (ไม่ต้องเปิดเว็บค้าง) และล้างข้อมูลเก่าวันละชั่วโมงละครั้ง
- แก้บัค: ผู้เล่นที่ไม่มี event ออกจากเซิร์ฟเวอร์ที่ crash จะไม่ค้างเป็น active (หมดอายุใน 12 ชม.), แคชไม่เก็บ response ที่ error, แจ้งเตือนซ้ำทุกครั้งที่รีโหลด, ข้อความ error ของ Place ID ที่ไม่มีจริงถูกทับ, ตัวเลข "ความจุ %" ที่เอาผู้เล่นทั้งเกมไปหารขนาดเซิร์ฟเวอร์ (ผิดความหมาย) ถูกเอาออก
- สคริปต์ Roblox: ไม่ retry batch ที่ถูกปฏิเสธ (4xx) จนคิวค้าง, จำกัดขนาดคิว, ส่งเฉพาะ User ID เป็นค่าเริ่มต้น (`SEND_USERNAME = false`)
- เพิ่ม Content-Security-Policy ใน `public/_headers`

> ตั้ง Domain ของ Roblox Secret เป็นโฮสต์ Worker ของคุณโดยเฉพาะ ไม่ใช้ `*` และแจ้งผู้เล่นในนโยบายความเป็นส่วนตัวของเกมหากเปิดใช้ telemetry
