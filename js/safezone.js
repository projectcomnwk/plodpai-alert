// ============================================================================
// safezone.js — ดึงจุดปลอดภัยจาก OpenStreetMap (Overpass API)
// แล้วคำนวณ "คะแนนแนะนำ" ให้แต่ละจุด เพื่อกระจายคนไม่ให้กองจุดเดียว (Smart Routing)
// ============================================================================

import { haversineKm } from "./utils.js";
import { db, doc, getDoc, setDoc, runTransaction } from "./config.js";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
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

/** ดึงจุดปลอดภัยรอบตำแหน่งผู้ใช้ พร้อมอ่านความจุปัจจุบันจาก Firestore (zone_state) */
export async function fetchNearbySafeZones(lat, lng) {
  const query = buildOverpassQuery(lat, lng);
  const res = await fetch(OVERPASS_URL, { method: "POST", body: query });
  if (!res.ok) throw new Error("Overpass API error");
  const data = await res.json();

  const zones = [];
  for (const el of data.elements) {
    const info = classify(el.tags || {});
    if (!info) continue;

    const zLat = el.type === "node" ? el.lat : el.center?.lat;
    const zLng = el.type === "node" ? el.lon : el.center?.lon;
    if (!zLat || !zLng) continue;

    const id = `${el.type}-${el.id}`;
    const name = el.tags.name || info.label;
    const distanceKm = haversineKm(lat, lng, zLat, zLng);

    zones.push({
      id, name, lat: zLat, lng: zLng,
      distanceKm,
      capacity: info.capacity,
      typeScore: info.typeScore,
      category: info.category,
      emoji: info.emoji
    });
  }

  // อ่านจำนวนคนที่เช็คอินไปแล้วของแต่ละจุด (ถ้ามี) จาก Firestore แบบขนาน
  await Promise.all(
    zones.map(async (z) => {
      const snap = await getDoc(doc(db, "zone_state", z.id));
      z.currentCount = snap.exists() ? snap.data().currentCount || 0 : 0;
    })
  );

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
