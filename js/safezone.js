// ============================================================================
// safezone.js — ดึงจุดปลอดภัยจาก OpenStreetMap (Overpass API)
// แล้วคำนวณ "คะแนนแนะนำ" ให้แต่ละจุด เพื่อกระจายคนไม่ให้กองจุดเดียว (Smart Routing)
//
// อัปเดต: เพิ่มระบบ "เซิร์ฟเวอร์สำรอง" (fallback) เพราะ overpass-api.de เป็นเซิร์ฟเวอร์
// สาธารณะฟรีที่บางครั้งไม่เสถียร (มีรายงานปัญหา error 406 / ปฏิเสธ request เป็นช่วงๆ)
// ถ้าเซิร์ฟเวอร์หลักไม่ตอบภายในเวลาที่กำหนด หรือตอบ error ระบบจะลองเซิร์ฟเวอร์ถัดไปอัตโนมัติ
// แทนที่จะค้างที่ "กำลังค้นหา..." ตลอดไปเหมือนก่อนหน้านี้
// ============================================================================

import { haversineKm, showToast } from "./utils.js";
import { db, doc, getDoc, setDoc, runTransaction } from "./config.js";
import { FALLBACK_ZONES } from "./fallback_zones.js";

// เรียงตามลำดับที่จะลอง — ตัวแรกคือเซิร์ฟเวอร์หลัก (ยืนยันแล้วว่ารองรับ CORS ดี เว็บส่วนใหญ่ใช้ตัวนี้)
// ตัวที่ 2-3 เป็น subdomain ของผู้ดูแลเดียวกัน (z / lz4) ที่ overpass-api.de ปกติ round-robin ไปหาอยู่แล้ว
// เผื่อไว้กรณี DNS/เส้นทางที่ overpass-api.de ชี้ไปมีปัญหาเฉพาะจุด
// ตัวสุดท้าย (kumi.systems) เป็นผู้ดูแลคนละคนจริงๆ ไว้เป็นทางเลือกสุดท้ายถ้า 3 ตัวแรกล่มพร้อมกันหมด
const OVERPASS_SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

const OVERPASS_TIMEOUT_MS = 8000; // รอเซิร์ฟเวอร์แต่ละตัวไม่เกิน 8 วินาที ก่อนลองตัวถัดไป
const SEARCH_RADIUS_M = 5000; // ค้นหาในรัศมี 5 กม. รอบตำแหน่งผู้ใช้

// ค่าเริ่มต้นของแต่ละประเภทสถานที่: ความจุโดยประมาณ + คะแนนความเหมาะสมของประเภท (0-1)
// (ความจุเป็นค่าประมาณ เพราะ OpenStreetMap ไม่มีข้อมูลนี้ — ใช้เป็น baseline ปรับได้ภายหลัง)
const TYPE_DEFAULTS = {
  pitch:      { capacity: 300,  typeScore: 1.0, category: "open",  label: "สนามกีฬา/ลานกว้าง", emoji: "⚽" },
  stadium:    { capacity: 2000, typeScore: 1.0, category: "open",  label: "สนามกีฬาขนาดใหญ่",  emoji: "🏟️" },
  park:       { capacity: 500,  typeScore: 1.0, category: "open",  label: "สวนสาธารณะ",        emoji: "🌳" },
  school:     { capacity: 400,  typeScore: 0.8, category: "open",  label: "สนามโรงเรียน",       emoji: "🏫" },
  community:  { capacity: 200,  typeScore: 0.6, category: "open",  label: "ศูนย์ชุมชน",         emoji: "🏛️" },
  hospital:   { capacity: 100,  typeScore: 0.4, category: "help",  label: "โรงพยาบาล",          emoji: "🏥" },
  police:     { capacity: 50,   typeScore: 0.4, category: "help",  label: "สถานีตำรวจ",         emoji: "🚓" }
};

/** สร้าง Overpass QL query รอบจุด lat/lng */
function buildOverpassQuery(lat, lng) {
  const r = SEARCH_RADIUS_M;
  return `
    [out:json][timeout:25];
    (
      node["leisure"="pitch"](around:${r},${lat},${lng});
      way["leisure"="pitch"](around:${r},${lat},${lng});
      node["leisure"="stadium"](around:${r},${lat},${lng});
      way["leisure"="stadium"](around:${r},${lat},${lng});
      node["leisure"="park"](around:${r},${lat},${lng});
      way["leisure"="park"](around:${r},${lat},${lng});
      node["amenity"="school"](around:${r},${lat},${lng});
      node["amenity"="community_centre"](around:${r},${lat},${lng});
      node["amenity"="hospital"](around:${r},${lat},${lng});
      way["amenity"="hospital"](around:${r},${lat},${lng});
      node["amenity"="police"](around:${r},${lat},${lng});
    );
    out center;
  `;
}

function classify(tags) {
  if (tags.leisure === "pitch") return TYPE_DEFAULTS.pitch;
  if (tags.leisure === "stadium") return TYPE_DEFAULTS.stadium;
  if (tags.leisure === "park") return TYPE_DEFAULTS.park;
  if (tags.amenity === "school") return TYPE_DEFAULTS.school;
  if (tags.amenity === "community_centre") return TYPE_DEFAULTS.community;
  if (tags.amenity === "hospital") return TYPE_DEFAULTS.hospital;
  if (tags.amenity === "police") return TYPE_DEFAULTS.police;
  return null;
}

/**
 * ยิง query ไปยังเซิร์ฟเวอร์ Overpass ทีละตัวตามลำดับใน OVERPASS_SERVERS
 * ถ้าตัวไหนไม่ตอบภายในเวลาที่กำหนด หรือตอบ error จะข้ามไปลองตัวถัดไปทันที
 * โยน error ก็ต่อเมื่อ "ทุกเซิร์ฟเวอร์" ใช้ไม่ได้จริงๆ เท่านั้น
 */
async function fetchFromOverpass(query) {
  let lastError = null;

  for (const url of OVERPASS_SERVERS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "POST",
        body: query,
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดพลาด (HTTP ${res.status})`);
      }
      return await res.json(); // สำเร็จ — จบการทำงานทันที ไม่ต้องลองเซิร์ฟเวอร์ถัดไป
    } catch (err) {
      clearTimeout(timer);
      const reason = err.name === "AbortError" ? "หมดเวลารอ (เกิน 8 วินาที)" : err.message;
      console.warn(`⚠️ เซิร์ฟเวอร์ Overpass ไม่ตอบ: ${url} (${reason}) — ลองเซิร์ฟเวอร์ถัดไป...`);
      lastError = err;
      // ไม่ throw ตรงนี้ — ปล่อยให้ loop ไปลอง url ถัดไปต่อ
    }
  }

  // มาถึงตรงนี้แปลว่าลองครบทุกเซิร์ฟเวอร์แล้วไม่มีตัวไหนตอบสำเร็จเลย
  throw new Error(
    "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ข้อมูลแผนที่ได้ในขณะนี้ (ลองแล้ว " +
    OVERPASS_SERVERS.length + " เซิร์ฟเวอร์) กรุณาลองใหม่อีกครั้งในอีกสักครู่"
  );
}

// ---------------------------------------------------------------------------
// ระบบสำรอง 3 ชั้น เมื่อ Overpass ใช้ไม่ได้ (เน็ตช้า/เซิร์ฟเวอร์ล่ม):
//   1) ข้อมูลสด จาก Overpass            (ปกติ)
//   2) แคชในเครื่อง ผลล่าสุดที่เคยโหลดสำเร็จ (เก็บใน localStorage นาน 30 วัน)
//   3) รายการสำรองที่ฝังในแอป            (ไฟล์ fallback_zones.js)
// ถ้าทั้ง 3 ชั้นไม่มีจุดในรัศมี ค่อยแจ้ง error
// ---------------------------------------------------------------------------
const CACHE_KEY = "plodpai_zone_cache_v1";
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_SHIFT_KM = 3; // ใช้แคชได้ถ้าผู้ใช้อยู่ห่างจากจุดที่เคยโหลดไม่เกิน 3 กม.

function saveZoneCache(lat, lng, zones) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      lat, lng, savedAt: Date.now(),
      zones: zones.map((z) => ({
        id: z.id, name: z.name, lat: z.lat, lng: z.lng,
        capacity: z.capacity, typeScore: z.typeScore, category: z.category, emoji: z.emoji
      }))
    }));
  } catch (e) { /* โหมดส่วนตัว/พื้นที่เต็ม — ข้ามไปได้ */ }
}

function loadZoneCache(lat, lng) {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (Date.now() - c.savedAt > CACHE_MAX_AGE_MS) return null;
    if (haversineKm(lat, lng, c.lat, c.lng) > CACHE_MAX_SHIFT_KM) return null;
    return c.zones;
  } catch (e) { return null; }
}

/** คำนวณระยะทางใหม่จากตำแหน่งผู้ใช้ และเก็บเฉพาะจุดที่อยู่ในรัศมีค้นหา */
function withDistance(list, lat, lng) {
  return list
    .map((z) => ({ ...z, distanceKm: haversineKm(lat, lng, z.lat, z.lng) }))
    .filter((z) => z.distanceKm <= SEARCH_RADIUS_M / 1000);
}

function parseOverpass(data, lat, lng) {
  const zones = [];
  for (const el of data.elements) {
    const info = classify(el.tags || {});
    if (!info) continue;

    const zLat = el.type === "node" ? el.lat : el.center?.lat;
    const zLng = el.type === "node" ? el.lon : el.center?.lon;
    if (!zLat || !zLng) continue;

    zones.push({
      id: `${el.type}-${el.id}`,
      name: el.tags.name || info.label,
      lat: zLat, lng: zLng,
      distanceKm: haversineKm(lat, lng, zLat, zLng),
      capacity: info.capacity,
      typeScore: info.typeScore,
      category: info.category,
      emoji: info.emoji
    });
  }
  return zones;
}

/** ดึงจุดปลอดภัยรอบตำแหน่งผู้ใช้ พร้อมอ่านความจุปัจจุบันจาก Firestore (zone_state) */
export async function fetchNearbySafeZones(lat, lng) {
  let zones = [];
  let source = "live";

  try {
    const data = await fetchFromOverpass(buildOverpassQuery(lat, lng));
    zones = parseOverpass(data, lat, lng);
    if (zones.length) saveZoneCache(lat, lng, zones);
  } catch (err) {
    // Overpass ใช้ไม่ได้ → ลองแคชในเครื่อง แล้วค่อยลองรายการสำรองที่ฝังในแอป
    const cached = loadZoneCache(lat, lng);
    zones = cached ? withDistance(cached, lat, lng) : [];
    source = "cache";
    if (!zones.length) {
      zones = withDistance(FALLBACK_ZONES, lat, lng);
      source = "fallback";
    }
    if (!zones.length) throw err; // ไม่มีข้อมูลสำรองเลย → แจ้งสาเหตุเดิม
    console.warn(`⚠️ ใช้ข้อมูลสำรอง (${source}) เพราะ Overpass ใช้ไม่ได้:`, err.message);
    showToast(
      source === "cache"
        ? "เซิร์ฟเวอร์แผนที่ไม่ตอบ — ใช้จุดปลอดภัยที่บันทึกไว้ในเครื่อง"
        : "เซิร์ฟเวอร์แผนที่ไม่ตอบ — ใช้รายการจุดปลอดภัยสำรองของแอป",
      5000
    );
  }

  // อ่านจำนวนคนที่เช็คอินไปแล้วของแต่ละจุด (ถ้ามี) จาก Firestore แบบขนาน
  // ถ้าอ่านไม่ได้ (เช่น ออฟไลน์) ให้ถือว่ายังไม่มีคนเช็คอิน แทนที่จะล้มทั้งหมด
  await Promise.all(
    zones.map(async (z) => {
      try {
        const snap = await getDoc(doc(db, "zone_state", z.id));
        z.currentCount = snap.exists() ? snap.data().currentCount || 0 : 0;
      } catch (e) {
        z.currentCount = 0;
      }
    })
  );

  zones.source = source;
  return zones;
}

/**
 * คำนวณคะแนนแนะนำของแต่ละจุด (สูตร 4 ปัจจัย):
 *   40% ระยะทาง (ใกล้กว่า = คะแนนสูงกว่า)
 *   35% ความจุที่เหลือ (คนน้อยกว่า = คะแนนสูงกว่า → ช่วยกระจายคนไม่ให้กองจุดเดียว)
 *   15% ประเภทสถานที่ (สนามโล่ง/สวน คะแนนสูงกว่าลานจอดรถ)
 *   10% เส้นทางปลอดภัย (ตอนนี้เป็นค่าคงที่ — ต่อยอดได้ด้วยข้อมูล crowdsource ถนนพัง)
 *
 * นอกจาก score (ใช้จัดอันดับ) ยังคำนวณ safetyPercent (0-100) ไว้ "แสดงผล" ให้ผู้ใช้เห็น
 * ว่าจุดนี้ปลอดภัยแค่ไหน โดยเน้นประเภทสถานที่ + ความจุที่เหลือ (ไม่รวมระยะทาง เพราะระยะทาง
 * ไม่ใช่ตัวชี้วัดความปลอดภัยของสถานที่นั้นเอง)
 */
export function scoreZones(zones, maxRadiusKm = 5) {
  return zones
    .filter((z) => z.currentCount < z.capacity) // ตัดจุดที่เต็มแล้วออก
    .map((z) => {
      const distanceScore = Math.max(0, 1 - z.distanceKm / maxRadiusKm);
      const occupancyRatio = z.currentCount / z.capacity;
      const capacityScore = Math.max(0, 1 - occupancyRatio);
      const routeSafetyScore = 1; // baseline คงที่ (extension: ผูกกับรายงานถนนพังจากชุมชน)

      const score =
        0.4 * distanceScore +
        0.35 * capacityScore +
        0.15 * z.typeScore +
        0.1 * routeSafetyScore;

      // คะแนนความปลอดภัยที่แสดงผล: เน้นประเภทสถานที่ (60%) + ความจุที่ยังว่าง (40%)
      const safetyPercent = Math.round((z.typeScore * 0.6 + capacityScore * 0.4) * 100);
      const capacityRemaining = Math.max(0, z.capacity - z.currentCount);

      return { ...z, occupancyRatio, score, safetyPercent, capacityRemaining };
    })
    .sort((a, b) => b.score - a.score);
}

/** ดึงเส้นทางเดินเท้าจาก OSRM (ถ้าดึงไม่ได้ จะ fallback เป็นเส้นตรงในไฟล์ app.js) */
export async function fetchWalkingRoute(fromLat, fromLng, toLat, toLng) {
  const url = `https://router.project-osrm.org/route/v1/foot/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("OSRM error");
  const data = await res.json();
  if (!data.routes || !data.routes[0]) throw new Error("ไม่พบเส้นทาง");
  // GeoJSON เป็น [lng,lat] ต้องสลับเป็น [lat,lng] สำหรับ Leaflet
  return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

/** เพิ่มจำนวนคนเช็คอินที่จุดนี้ (transaction กันข้อมูลชนกันเวลามีคนเช็คอินพร้อมกัน) */
export async function checkInToZone(zone) {
  const ref = doc(db, "zone_state", zone.id);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      tx.set(ref, {
        name: zone.name,
        lat: zone.lat,
        lng: zone.lng,
        capacity: zone.capacity,
        category: zone.category,
        currentCount: 1,
        lastUpdated: Date.now()
      });
    } else {
      const current = snap.data().currentCount || 0;
      tx.update(ref, { currentCount: current + 1, lastUpdated: Date.now() });
    }
  });
}
