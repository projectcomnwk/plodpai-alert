// ============================================================================
// dashboard.js — หน้า Dashboard สาธารณะ (ใครก็เข้าดูได้ ไม่ต้องล็อกอิน)
//
// ตั้งใจ "ไม่แสดง" ชื่อและเบอร์โทรของผู้ใช้เด็ดขาด — อ่านข้อมูลจากคอลเลกชัน
// public_pins และ zone_state เท่านั้น ซึ่งทั้งสองไม่มีข้อมูลส่วนบุคคลติดอยู่เลย
// (ข้อมูลที่มีชื่อ/เบอร์โทร เช่น sos_alerts, safe_requests, status_reports
//  ถูกจำกัดด้วย Firestore Rules ให้อ่านได้เฉพาะ Admin/หน่วยกู้ภัยที่ล็อกอินแล้วเท่านั้น
//  ดูหน้า admin.html)
// ============================================================================

import { FALLBACK_LOCATION } from "./utils.js";
import { db, collection, onSnapshot } from "./config.js";

let map;
const pinMarkers = new Map();
const zoneMarkers = new Map();

function initMap() {
  map = L.map("map").setView([FALLBACK_LOCATION.lat, FALLBACK_LOCATION.lng], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
}

function statusLabel(kind, status) {
  if (kind === "sos") {
    return status === "resolved" ? "ช่วยเหลือสำเร็จแล้ว" : "🆘 ต้องการความช่วยเหลือด่วน";
  }
  if (kind === "checkin") return "✅ ปลอดภัย (เช็คอินที่จุดปลอดภัย)";
  const map = { safe: "✅ ปลอดภัยดี", unsafe: "⚠️ ไม่ปลอดภัย/ต้องการความช่วยเหลือ", unknown: "❓ ไม่แน่ใจ/กำลังประเมิน" };
  return map[status] || status;
}

function pinClass(kind, status) {
  if (kind === "sos") return status === "resolved" ? "helping" : "trapped";
  if (kind === "checkin") return "helping"; // สีน้ำเงิน = ปลอดภัย/อยู่ในจุดที่กำหนด
  const map = { safe: "helping", unsafe: "trapped", unknown: "injured_minor" };
  return map[status] || "injured_minor";
}

// -------------------------------------------------------- ฟังจุดสาธารณะ (ไม่มีชื่อ/เบอร์)
function watchPublicPins() {
  onSnapshot(
    collection(db, "public_pins"),
    (snap) => {
      let safeCount = 0;
      let unsafeCount = 0;
      let sosPending = 0;
      const currentIds = new Set();

      snap.forEach((docSnap) => {
        const d = docSnap.data();
        const id = docSnap.id;
        currentIds.add(id);

        // --- นับสถิติ (ไม่แตะข้อมูลชื่อ/เบอร์ เพราะ collection นี้ไม่มีข้อมูลนั้นอยู่แล้ว) ---
        if (d.kind === "sos" && !d.resolved) sosPending++;
        if (d.kind === "checkin") safeCount++;
        if (d.kind === "report" && d.status === "safe") safeCount++;
        if (d.kind === "report" && d.status === "unsafe") unsafeCount++;

        // --- แสดงจุดบนแผนที่แบบไม่ระบุตัวตน (แค่สถานะ+ตำแหน่ง) ---
        // ไม่แสดงจุด SOS ที่ช่วยเหลือสำเร็จแล้ว เพื่อไม่ให้แผนที่รกด้วยข้อมูลเก่า
        if (d.kind === "sos" && d.resolved) {
          if (pinMarkers.has(id)) { map.removeLayer(pinMarkers.get(id)); pinMarkers.delete(id); }
          return;
        }

        const cls = pinClass(d.kind, d.status);
        const emoji = d.kind === "sos" ? "🆘" : d.kind === "checkin" ? "✅" : d.status === "unsafe" ? "⚠️" : d.status === "unknown" ? "❓" : "✅";

        if (!pinMarkers.has(id)) {
          const marker = L.marker([d.lat, d.lng], {
            icon: L.divIcon({ className: "", html: `<div class="sos-pin ${cls}">${emoji}</div>`, iconSize: [26, 26] })
          }).addTo(map);
          pinMarkers.set(id, marker);
        }
        // Popup แสดงแค่สถานะ ไม่มีชื่อ/เบอร์โทรใดๆ ทั้งสิ้น
        pinMarkers.get(id).bindPopup(statusLabel(d.kind, d.status));
      });

      pinMarkers.forEach((marker, id) => {
        if (!currentIds.has(id)) {
          map.removeLayer(marker);
          pinMarkers.delete(id);
        }
      });

      document.getElementById("stat-safe").textContent = safeCount;
      document.getElementById("stat-unsafe").textContent = unsafeCount;
      document.getElementById("stat-sos-pending").textContent = sosPending;
    },
    (err) => {
      console.error("watchPublicPins error:", err);
    }
  );
}

// -------------------------------------------------------- ฟังความจุจุดปลอดภัย (ไม่มี PII)
function watchZones() {
  onSnapshot(collection(db, "zone_state"), (snap) => {
    let totalPeople = 0;

    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const id = docSnap.id;
      totalPeople += d.currentCount || 0;

      const ratio = (d.currentCount || 0) / (d.capacity || 1);
      const cls = ratio > 0.85 ? "full" : ratio > 0.5 ? "mid" : "ok";

      if (zoneMarkers.has(id)) map.removeLayer(zoneMarkers.get(id));
      const marker = L.marker([d.lat, d.lng], {
        icon: L.divIcon({ className: "", html: `<div class="zone-pin ${cls}"><span>🏕️</span></div>`, iconSize: [26, 26] })
      })
        .addTo(map)
        .bindPopup(`<b>${d.name}</b><br>${d.currentCount || 0}/${d.capacity} คน (ไม่แสดงรายชื่อ)`);
      zoneMarkers.set(id, marker);
    });

    document.getElementById("stat-total-people").textContent = totalPeople;
  });
}

function tickClock() {
  document.getElementById("clock-pill").textContent = new Date().toLocaleTimeString("th-TH");
}

initMap();
watchPublicPins();
watchZones();
setInterval(tickClock, 1000);
tickClock();
