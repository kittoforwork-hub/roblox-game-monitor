# Roblox Game Monitor — Live Operations Console 2.1.0

ชุดนี้แก้ปัญหา Worker API 404 โดยให้ `wrangler.jsonc` เป็น Wrangler config หลักเพียงไฟล์เดียวและชี้ไป `worker/index.js` ซึ่งมี API routes ครบ รวมถึงเตรียม API สำหรับรับ event ผู้เล่น Roblox join/leave ผ่าน server-to-server token authentication

## โครงสร้าง

- `public/` — Dashboard, CSS และ frontend JavaScript
- `worker/index.js` — API `/api/health`, `/api/game`, `/api/games`, `/api/history` และ telemetry
- `migrations/0001_init.sql` — ตารางเดิมสำหรับ game snapshots และ rate limit
- `migrations/0002_player_telemetry.sql` — ตาราง player event log และ active session projection
- `roblox/PlayerTelemetry.server.lua` — ตัวอย่าง Script สำหรับวางใน `ServerScriptService`
- `wrangler.jsonc` — configuration หลัก (แทนที่ `database_id` placeholder ด้วย D1 ID จริง)

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
