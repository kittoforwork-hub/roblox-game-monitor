ROBLOX MONITOR — LIVE OPERATIONS CONSOLE 2.1.0
==============================================

เป้าหมายของชุดแก้ไขนี้
-----------------------
1. ใช้ Cloudflare Worker entry point เพียงตัวเดียวคือ worker/index.js เพื่อแก้ API 404 ที่เกิดจาก config เดิมชี้ไป src/index.js ซึ่งมีเพียง /api/game
2. ให้ /api/* วิ่งเข้า Worker ก่อน Static Assets
3. คง API อ่านข้อมูลเกมและประวัติ พร้อมระบบ fallback เมื่อ D1 ยังไม่พร้อม
4. เพิ่ม API รับเหตุการณ์ผู้เล่น Roblox เข้า/ออกจาก ServerScriptService ผ่าน HTTPS และ Bearer token
5. เก็บ event log และสถานะ session ใน D1 ด้วย batch transaction และ eventId สำหรับกัน event ซ้ำ
6. เพิ่ม endpoints อ่านผู้เล่นออนไลน์/ประวัติ event แบบมี token; ไม่เปิดรายชื่อผู้เล่นสู่สาธารณะ

ไฟล์หลัก
--------
public/index.html                 หน้า Dashboard
public/style.css                  สไตล์ Dashboard
public/app.js                     UI, polling, graph, history, CSV, local fallback
worker/index.js                   Worker API ทั้งหมด
migrations/0001_init.sql           schema เดิมของเกม, snapshots และ rate limit
migrations/0002_player_telemetry.sql  ตาราง player_events และ player_sessions
roblox/PlayerTelemetry.server.lua ตัวอย่าง Script ส่ง join/leave จาก Roblox Server
wrangler.jsonc                    config หลักไฟล์เดียวของ Wrangler
package.json                     คำสั่งและ Wrangler dependency

git/config ที่เปลี่ยนจากชุดเดิม
-------------------------------
- wrangler.jsonc ชี้ main ไป worker/index.js และกำหนด run_worker_first=["/api/*"]
- นำ wrangler.toml และ src/index.js รุ่นเก่าที่ขัดแย้งกันออก เพื่อไม่ให้ deploy สลับ entry point
- ชื่อ Worker ตั้งเป็น roblox-game-monitor ให้ตรงกับ URL ที่หน้าเว็บใช้อยู่
- ต้องแทนที่ database_id placeholder ด้วย D1 database ID จริงก่อน deploy

ติดตั้งและ Deploy
------------------
ต้องมี Node.js และบัญชี Cloudflare Workers + D1

1. แตก ZIP แล้วเปิด Terminal ในโฟลเดอร์ roblox-game-monitor-main
2. ติดตั้ง dependency:
     npm install
3. Login Cloudflare:
     npx wrangler login
4. ถ้ายังไม่มี D1 ให้สร้าง:
     npx wrangler d1 create roblox-monitor-db
   คัดลอก database_id จริงที่คำสั่งแสดง แล้วใส่ใน wrangler.jsonc ตรง REPLACE_AFTER_CREATING_D1
   ถ้ามีฐานข้อมูลเดิมอยู่แล้ว ให้ใช้ ID เดิม ห้ามสร้างฐานข้อมูลใหม่โดยไม่จำเป็น
5. Apply migration ไปยัง remote D1:
     npx wrangler d1 migrations apply roblox-monitor-db --remote
   คำสั่งนี้ใช้ทั้งสร้าง schema ใหม่ และ apply migration 0002 ในฐานข้อมูลเดิมที่เคย apply 0001 แล้ว
6. สร้าง secret สำหรับ rate limiter:
     npx wrangler secret put RATE_LIMIT_SALT
   ใส่ข้อความสุ่มยาวอย่างน้อย 32 ตัวอักษร ห้ามใช้ Roblox cookie/password
7. สร้าง token สำหรับ telemetry:
     npx wrangler secret put ROBLOX_INGEST_TOKEN
   สร้างค่าด้วย `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` แล้วตั้งเป็น secret (ได้ token 64 ตัวอักษร) ค่านี้ต้องตรงกับ Roblox Secret ที่ตั้งชื่อ RobloxMonitorToken; Worker ปฏิเสธ token สั้นกว่า 32 ตัวอักษร
8. ทดสอบ syntax และ unit/smoke tests:
     npm test
     npm run check
9. Deploy:
     npx wrangler deploy

หากใช้ Cloudflare Workers Builds ที่เชื่อม GitHub:
- Root directory: เว้นว่าง / ราก Repository
- Build command: npm install
- Deploy command: npx wrangler deploy
- ตรวจว่า wrangler.jsonc ถูก commit แล้ว และ database_id เป็น ID จริงก่อนสั่ง Build/Deploy
- Deploy ต้องไป Worker ชื่อ roblox-game-monitor และไม่ควรมี config รุ่นเก่าที่ชี้ไป src/index.js

ตรวจ API หลัง deploy
--------------------
เปิด URL ต่อไปนี้โดยใช้ hostname จริงของ Worker:

GET https://roblox-game-monitor.kitto-for-work.workers.dev/api/health
ควรตอบ JSON มี ok:true, version:"2.1.0" และ telemetry.endpoint

GET https://roblox-game-monitor.kitto-for-work.workers.dev/api/game?placeId=117871374541549
ควรตอบข้อมูลเกม หรือ error JSON ที่มี code อธิบายเหตุผล ไม่ควรเป็น HTML 404

GET https://roblox-game-monitor.kitto-for-work.workers.dev/api/games?placeIds=117871374541549
GET https://roblox-game-monitor.kitto-for-work.workers.dev/api/history?placeId=117871374541549&range=24h

ใน /api/health:
- storage.d1=true หมายถึง Worker query ตาราง history ได้
- telemetry.schemaReady=true หมายถึง apply migration 0002 แล้ว
- telemetry.configured=true หมายถึงตั้ง ROBLOX_INGEST_TOKEN แล้ว

ถ้า health ยังได้ 404 ให้เปิด Cloudflare Workers > Deployments/Logs แล้วตรวจ Worker name, build root, config file และ deployment URL เพราะ API 404 ไม่ได้เกิดจาก Roblox Place ID

API เดิม
--------
GET /api/health
GET /api/game?placeId=123
GET /api/games?placeIds=123,456
GET /api/history?placeId=123&range=1h|6h|24h|7d|30d

API รับ telemetry จาก Roblox Server
----------------------------------
POST /api/roblox/player-events
Header:
  Authorization: Bearer <ROBLOX_INGEST_TOKEN>
  Content-Type: application/json

รองรับ event เดี่ยวหรือ batch (1–50 events ต่อ request):
{
  "events": [
    {
      "eventId": "GUID-unique-per-event",
      "eventType": "join",
      "placeId": "123",
      "universeId": "456",
      "jobId": "Roblox-server-job-id",
      "userId": "789",
      "username": "PlayerName",
      "occurredAt": 1793174849000
    }
  ]
}

ค่า eventType ใช้ join หรือ leave; ยังรับ alias player_join/player_leave ได้
- eventId ต้องเป็นรหัสเฉพาะของ event และต้องคงเดิมเมื่อ retry เพื่อให้ API กันข้อมูลซ้ำได้
- placeId คือ Place ID; universeId คือ Game/Universe ID; jobId คือ server instance ID
- occurredAt เป็น Unix timestamp หน่วย milliseconds (รองรับวินาทีหรือ ISO date ด้วย)
- endpoint ปฏิเสธ token ผิด, payload ผิดรูปแบบ, batch เกินขนาด และข้อมูลเก่ากว่า 30 วัน/เวลาอนาคตผิดปกติ
- DB batch จะบันทึก event log พร้อม update session state เป็น transaction เดียว
- D1 ต้อง apply migration 0002 ก่อน ถ้าไม่มี DB หรือ schema จะตอบ 503 และไม่แกล้งตอบสำเร็จ

อ่านข้อมูล telemetry (ต้องใช้ Bearer token เดียวกัน)
------------------------------------------------------
GET /api/roblox/players?placeId=123&limit=100
ตอบรายชื่อ session ที่ API ประเมินว่ายัง active แยกตาม placeId + jobId + userId

GET /api/roblox/player-events?placeId=123&limit=100
ตอบ event ล่าสุดของเกมนั้น

สอง endpoint นี้ห้ามนำ token ไปใส่ในหน้าเว็บ public หรือ LocalScript เพราะจะเปิดเผยข้อมูล/สิทธิ์ API

เชื่อมกับ Roblox Studio
-----------------------
1. เปิด Game Settings > Security และเปิด Allow HTTP Requests ตามเอกสาร Roblox HttpService
2. ใน Creator Hub สร้าง Secret ชื่อ RobloxMonitorToken โดยใช้ค่าเดียวกับ Cloudflare secret ROBLOX_INGEST_TOKEN
3. นำไฟล์ roblox/PlayerTelemetry.server.lua ไปวางเป็น Script ใน ServerScriptService (ไม่ใช่ LocalScript)
4. ตรวจ ENDPOINT ให้ตรง hostname Worker จริงของคุณ
5. Publish และทดสอบใน server จริง; การใช้ใน Studio อาจได้ jobId ที่เป็นค่า studio ชั่วคราว
6. ดู /api/health ว่า telemetry.configured และ telemetry.schemaReady เป็น true
7. สำหรับทดสอบ อ่าน event/active players ต้องเรียก GET ด้วย header Authorization: Bearer <token> จากเครื่องมือฝั่งผู้ดูแลเท่านั้น

ตัวอย่างส่งข้อมูลด้วย curl (ใช้บนเครื่องผู้ดูแล ห้ามใส่ token ลง GitHub)
--------------------------------------------------------------------------
curl -X POST "https://roblox-game-monitor.kitto-for-work.workers.dev/api/roblox/player-events" \
  -H "Authorization: Bearer $ROBLOX_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"events":[{"eventId":"manual-test-123456","eventType":"join","placeId":"123","universeId":"456","jobId":"manual-test-server","userId":"789","username":"TestPlayer"}]}'

ความปลอดภัยและข้อจำกัด
----------------------
- ไม่ต้องใช้ Roblox cookie, password หรือ Open Cloud API key เพื่ออ่าน public game metadata
- telemetry ใช้ secret token เฉพาะ server-to-server; token ไม่ถูก hardcode ใน Lua file แต่ดึงจาก Roblox Secret
- /api/roblox/players และ /api/roblox/player-events ต้องใช้ token จึงไม่เปิดรายชื่อผู้เล่นสู่ public web
- ปรับ API_REQUEST_LIMIT และ TELEMETRY_REQUEST_LIMIT ได้ใน wrangler.jsonc; ค่าเริ่มต้น 50 และ 300 requests/IP/window ตามลำดับ
- rate limiter เป็นแนวป้องกันพื้นฐาน ควรใช้ Cloudflare WAF/rate-limiting rules เพิ่มเติมสำหรับ production
- บันทึก event เฉพาะหลัง Script ฝั่ง Server ส่งสำเร็จ; หาก Roblox server ปิดทันทีหรือ HTTP ล้มเหลวเกิน retries อาจมี event หายได้ ระบบตัวอย่างมี queue/retry และ flush ตอนปิด server แต่ไม่ใช่ durable queue
- sessions ปัจจุบันคำนวณจาก join/leave ที่ Worker ได้รับจริง หากขาด leave event อาจเหลือ active session เก่า; ควรเพิ่ม heartbeat/reconciliation ในระยะต่อไปหากต้องการความแม่นยำระดับ production
- public game API แสดงจำนวนผู้เล่นรวมแบบ polling ไม่ใช่ WebSocket; telemetry join/leave เป็นข้อมูลจาก Experience ของคุณ และแยกจาก public metadata API
- ประวัติ snapshot ของเกมเก็บสูงสุด 30 วันผ่าน Cron; player event log และ inactive player sessions ใช้ retention 30 วันโดย Cron; active session ที่ไม่มี event เกิน 30 วันจะถูก mark เป็น inactive เพื่อกัน stale session

อ้างอิงเอกสาร
-------------
Cloudflare Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
Cloudflare D1: https://developers.cloudflare.com/d1/worker-api/d1-database/
Roblox HttpService: https://create.roblox.com/docs/reference/engine/classes/HttpService
Roblox in-game HTTP requests: https://create.roblox.com/docs/cloud-services/http-service

เวอร์ชัน: 2.1.0
