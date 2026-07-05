// ============================================================================
// quake.js — ดึงข้อมูลแผ่นดินไหวจาก USGS + โหมดจำลอง (Simulate Mode)
//
// แนวคิดสำคัญ: ไม่ว่าข้อมูลจะมาจาก USGS จริง หรือมาจากปุ่ม "จำลองแผ่นดินไหว"
// ทั้งสองทางจะไหลผ่านฟังก์ชันเดียวกันคือ handleQuakeEvent()
// เพื่อพิสูจน์ว่าโค้ดจริงทำงาน ไม่ใช่แค่ mockup แยกกันคนละชุด
// ============================================================================

import { haversineKm, showToast } from "./utils.js";
import { db, collection, addDoc, serverTimestamp } from "./config.js";

const S_WAVE_SPEED_KMS = 3.5; // ความเร็วคลื่น S โดยประมาณ (กม./วินาที)
const NORMAL_RADIUS_KM = 500; // รัศมีแจ้งเตือนปกติ (ครอบคลุมไทย+พม่า+ลาวบางส่วน)
const WIDE_RADIUS_KM = 20000; // โหมด "ขยายพื้นที่" สำหรับ demo ให้จับข้อมูลจริงจากทั่วโลกได้

// feed ของ USGS: แผ่นดินไหวทั้งหมดในชั่วโมงที่ผ่านมา ทั่วโลก อัปเดตทุก 1 นาที
const USGS_FEED_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";

let userLocation = null;
let pollTimer = null;
let wideMode = false;
let onQuakeCallback = null; // callback ที่ index.html ผูกไว้เพื่ออัปเดตแผนที่/UI

/** เริ่มระบบตรวจจับแผ่นดินไหว ต้องส่งตำแหน่งผู้ใช้และ callback เข้ามา */
export function initQuakeWatcher(location, callback) {
  userLocation = location;
  onQuakeCallback = callback;
  pollUSGS(); // เช็คทันทีตอนเปิดแอป
  pollTimer = setInterval(pollUSGS, 60000); // แล้วเช็คซ้ำทุก 60 วินาที
}

/** สลับโหมดขยายรัศมี (ใช้พิสูจน์ว่าระบบดึงข้อมูลจริงจาก USGS ได้ — วิธีที่ 2 ในแผนทดสอบ) */
export function setWideMode(enabled) {
  wideMode = enabled;
  pollUSGS();
}

async function pollUSGS() {
  try {
    const res = await fetch(USGS_FEED_URL);
    if (!res.ok) throw new Error("USGS feed error");
    const data = await res.json();
    const radius = wideMode ? WIDE_RADIUS_KM : NORMAL_RADIUS_KM;

    const nearby = data.features
      .map((f) => {
        const [lng, lat, depth] = f.geometry.coordinates;
        const distanceKm = haversineKm(userLocation.lat, userLocation.lng, lat, lng);
        return {
          id: f.id,
          magnitude: f.properties.mag,
          place: f.properties.place,
          time: f.properties.time,
          lat, lng, depth,
          distanceKm
        };
      })
      .filter((q) => q.magnitude >= (wideMode ? 4.0 : 3.0) && q.distanceKm <= radius)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    if (nearby.length > 0) {
      handleQuakeEvent({ ...nearby[0], source: "USGS" });
    }
  } catch (err) {
    console.warn("ดึงข้อมูล USGS ไม่สำเร็จ:", err);
  }
}

/** ยิงเหตุการณ์จำลองแผ่นดินไหว เข้า pipeline เดียวกับข้อมูลจริง */
export function simulateQuake(magnitude, lat, lng) {
  handleQuakeEvent({
    id: "demo-" + Date.now(),
    magnitude,
    place: "ตำแหน่งจำลอง (Demo Mode)",
    time: Date.now(),
    lat, lng,
    depth: 10,
    distanceKm: haversineKm(userLocation.lat, userLocation.lng, lat, lng),
    source: "DEMO"
  });
}

/** จุดศูนย์กลางเดียวที่ประมวลผลเหตุการณ์แผ่นดินไหวทุกแหล่งที่มา */
function handleQuakeEvent(quake) {
  const etaSeconds = Math.max(0, Math.round(quake.distanceKm / S_WAVE_SPEED_KMS));

  // บันทึกลง Firestore ไว้เป็นหลักฐาน/ประวัติ (ทั้ง USGS และ DEMO ถูกบันทึกเหมือนกัน)
  addDoc(collection(db, "quake_events"), {
    magnitude: quake.magnitude,
    place: quake.place,
    lat: quake.lat,
    lng: quake.lng,
    distanceKm: Math.round(quake.distanceKm),
    etaSeconds,
    source: quake.source,
    createdAt: serverTimestamp()
  }).catch((e) => console.warn("บันทึก quake_events ไม่สำเร็จ:", e));

  if (onQuakeCallback) onQuakeCallback(quake, etaSeconds);
  showToast(
    quake.source === "DEMO"
      ? `🧪 จำลองแผ่นดินไหวขนาด ${quake.magnitude} แล้ว`
      : `🔔 พบแผ่นดินไหวจริงจาก USGS ขนาด ${quake.magnitude}`
  );
}

export function stopQuakeWatcher() {
  if (pollTimer) clearInterval(pollTimer);
}
