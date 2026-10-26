ROBLOX MONITOR — LIVE OPERATIONS CONSOLE 2.0
============================================

ชุดนี้เป็นโปรเจกต์ Cloudflare Workers + Static Assets + D1 ออกแบบให้ไฟล์ HTML, CSS, JavaScript และ API ทำงานร่วมกันได้ โดยคงฟังก์ชันหลักจากหน้าเดิมไว้ และเพิ่ม Multi-Game Workspace, การเก็บประวัติถาวร, กราฟหลายช่วงเวลา, CSV export, สถานะข้อมูลเก่า, Browser Notifications และ rate limiting ฝั่ง API

ไฟล์ในชุด
----------
public/index.html       หน้า Dashboard
public/style.css        ดีไซน์ Live Operations Center แบบ Dark Premium / responsive
public/app.js           UI logic, multi-game tracking, charts, CSV, local fallback และ browser notifications
worker/index.js         Cloudflare Worker API และ public Roblox API integration
migrations/0001_init.sql สร้างตาราง D1 และ index
wrangler.toml           การตั้งค่า Worker, Static Assets, D1 และ scheduled cleanup

ติดตั้งบน Cloudflare
--------------------
ต้องมี Node.js รุ่นปัจจุบัน และบัญชี Cloudflare ที่เปิดใช้ Workers กับ D1 ได้

1. แตก ZIP และเปิด Terminal ในโฟลเดอร์โปรเจกต์
2. ติดตั้ง/เรียกใช้ Wrangler:
     npx wrangler login
3. สร้าง D1 database:
     npx wrangler d1 create roblox-monitor-db
4. คัดลอก database_id ที่คำสั่งแสดง แล้วแทนที่ REPLACE_AFTER_CREATING_D1 ใน wrangler.toml
5. สร้างตารางใน D1 บน Cloudflare:
     npx wrangler d1 migrations apply roblox-monitor-db --remote
6. ตั้ง secret สำหรับสร้าง hash ของ IP ใน rate limiter (ใช้ข้อความสุ่มยาว ๆ ไม่ใช่รหัสผ่าน Roblox):
     npx wrangler secret put RATE_LIMIT_SALT
7. Deploy:
     npx wrangler deploy

เปิด URL ของ Worker ที่ Wrangler แจ้ง แล้วทดสอบ /api/health ต้องแสดง ok:true และ storage.d1:true
หากต้องการทดสอบก่อน deploy ใช้ npx wrangler dev และปรับ migrations ให้กับ local D1:
     npx wrangler d1 migrations apply roblox-monitor-db --local

หมายเหตุการ deploy
------------------
- ไม่ต้องใช้ Roblox cookie, password หรือ API key เพื่ออ่านข้อมูลสาธารณะที่หน้านี้แสดง
- D1 ต้องสร้างและ migrate ก่อน จึงจะเก็บประวัติร่วมกันบนเซิร์ฟเวอร์ได้
- รายการเกมที่ติดตามและการตั้งค่าแจ้งเตือนในหน้าเว็บเก็บไว้ใน localStorage ของเบราว์เซอร์/อุปกรณ์นั้น แต่ snapshots จะถูกเก็บใน D1 หากผูกฐานข้อมูลสำเร็จ
- ประวัติ D1 เก็บย้อนหลัง 30 วัน และ Worker มี Cron ลบข้อมูลที่เก่ากว่าช่วงดังกล่าว
- ถ้า D1 ใช้งานไม่ได้ API จะยังพยายามส่งข้อมูลสดกลับมา และหน้าเว็บใช้ local fallback เท่าที่มี ไม่ถือว่าประวัติถาวรทำงานอยู่
- ค่า API_REQUEST_LIMIT เริ่มต้น 50 คำขอต่อ IP ต่อช่วงเวลา 60 วินาที (กำหนดได้ใน wrangler.toml) ตัวกรองนี้เป็นแนวป้องกันพื้นฐาน ไม่ได้ทดแทน WAF/Cloudflare rate limiting policy
- ควรเปิด Cloudflare dashboard แล้วตั้ง WAF/rate limiting rules เพิ่มเติมหากเผยแพร่เว็บให้คนทั่วไปใช้งาน

ฟังก์ชันที่คงไว้จากหน้าเดิม
---------------------------
- รับ Place ID หรือลิงก์เกม Roblox
- แสดงชื่อเกม, ผู้สร้าง, Place ID, Universe ID, ผู้เล่นออนไลน์, maxPlayers, visits และไอคอนเกมเมื่อมีข้อมูล
- รีเฟรชข้อมูลอัตโนมัติ เลือก 60 วินาที / 2 นาที / 5 นาที และกด refresh เองได้
- จำเกมล่าสุดและเกมปัจจุบันในเบราว์เซอร์
- กราฟและประวัติการตรวจสอบ พร้อม export CSV

API routes
----------
GET /api/health
GET /api/game?placeId=123
GET /api/games?placeIds=123,456
GET /api/history?placeId=123&range=1h|6h|24h|7d|30d

ข้อจำกัดที่ควรทราบ
-------------------
1. ข้อมูลเรียลไทม์ในหน้านี้เป็นการ polling ไม่ใช่ WebSocket หรือ stream แบบวินาทีต่อวินาที รอบอัปเดตขั้นต่ำคือ 60 วินาที และอาจช้ากว่านั้นจาก cache หรือ Roblox API
2. ใช้ Public Web API ของ Roblox เพื่ออ่าน Universe ID, รายละเอียดเกม และ thumbnail บาง endpoint ถูกจัดเป็น legacy/experimental หรืออาจเปลี่ยนแปลงได้ Roblox อาจตอบ 429 หรือจำกัดอัตราเรียกโดยไม่มีเพดานที่รับประกันสำหรับทุกกรณี ระบบจึงมี timeout, retry แบบจำกัด และ error handling แต่ไม่สามารถบังคับให้ Roblox API พร้อมใช้งานได้
3. playing เป็นค่ารวมที่ API ส่งกลับ ณ เวลาที่ตรวจสอบ ส่วน maxPlayers เป็นความจุสูงสุดต่อเซิร์ฟเวอร์ ไม่ใช่จำนวนผู้เล่นทั้งหมดหรือจำนวนเซิร์ฟเวอร์ทั้งหมด
4. ไม่สามารถอ่านชื่อผู้เล่น, Player ID, เวลาเข้า/ออก, chat, server instance ภายใน หรือสถิติภายในเกมจาก public metadata API ได้ หากต้องการข้อมูลเหล่านั้นต้องพัฒนา telemetry ภายใน Roblox Experience ของผู้ใช้และใช้ระบบจัดเก็บที่ได้รับอนุญาต
5. Browser Notifications ทำงานได้เมื่อผู้ใช้อนุญาต เปิดหน้าเว็บไว้ และเบราว์เซอร์รองรับเท่านั้น ไม่ใช่ push notification จากเซิร์ฟเวอร์ตอนปิดหน้าเว็บ และไม่ได้ส่งเข้า Discord โดยอัตโนมัติ
6. ระบบแจ้งเตือนปัจจุบันเป็นกฎฝั่งหน้าเว็บ: จำนวนผู้เล่นข้าม threshold ที่กำหนด และความจุแตะ 90% เหตุการณ์นี้ไม่ใช่ระบบ incident management หรือการรับประกันแจ้งเตือนตลอดเวลา
7. D1 snapshots ถูกสร้างเมื่อมีการเรียก /api/game หรือ /api/games เท่านั้น ไม่มี background poller หากไม่มีใครเปิด Dashboard หรือส่งคำขอ API ประวัติจะไม่เพิ่มขึ้นเอง
8. rate-limit table เก็บ hash ที่สร้างจาก IP และ secret แบบรายนาที ไม่เก็บ raw IP; ควรตั้ง RATE_LIMIT_SALT ใน production และกำหนด retention/rate limiting ให้เหมาะกับปริมาณใช้งานจริง

ความหมายสถานะ
--------------
- API CONNECTED · D1: API ตอบสนองและ D1 query สำเร็จ
- API CONNECTED · LOCAL: API ตอบสนองแต่ยังไม่มี D1 ที่ใช้ได้
- PARTIAL DATA / STALE DATA: มีบางเกมดึงข้อมูลไม่สำเร็จหรือกำลังแสดงค่าล่าสุดที่เคยสำเร็จ
- API UNAVAILABLE: หน้าเว็บติดต่อ /api/health ไม่สำเร็จ ตรวจสอบการ deploy และ route /api/*

เวอร์ชัน: 2.0.0
