// ============================================================================
// dashboard.js — หน้า Dashboard สำหรับหน่วยกู้ภัย/ผู้ดูแลระบบ (ไม่ต้องล็อกอิน)
// แสดงแผนที่ + สถิติ real-time ของ SOS, จุดปลอดภัย, คำขอ/เช็คอิน
// ============================================================================

import { FALLBACK_LOCATION } from "./utils.js";
import {
  db, collection, onSnapshot, query, where, orderBy, doc, updateDoc, serverTimestamp
} from "./config.js";

let map;
const sosMarkers = new Map();
const zoneMarkers = new Map();
let totalRequests = 0;
let totalCheckins = 0;

function initMap() {
  map = L.map("map").setView([FALLBACK_LOCATION.lat, FALLBACK_LOCATION.lng], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);
}

function statusColorClass(status) {
  return status; // ใช้ชื่อ status ตรงกับ class ใน CSS (.sos-pin.trapped ฯลฯ)
}

function statusLabel(status) {
  const map = {
    trapped: "ติดอยู่ ออกไม่ได้",
    injured_severe: "บาดเจ็บ เดินไม่ได้",
    injured_minor: "บาดเจ็บเล็กน้อย",
    helping: "กำลังช่วยผู้อื่น"
  };
  return map[status] || status;
}

// -------------------------------------------------------- ฟัง SOS แบบเรียลไทม์
function watchSOS() {
  // หมายเหตุ: ตั้งใจไม่ใช้ orderBy() ร่วมกับ where() ในคำสั่งเดียวกัน
  // เพราะ Firestore จะต้องการ "Composite Index" ที่ยังไม่ถูกสร้างไว้ล่วงหน้า
  // จึงดึงข้อมูลมาทั้งหมดที่ resolved == false แล้วมาเรียงลำดับเองฝั่ง client แทน
  const q = query(collection(db, "sos_alerts"), where("resolved", "==", false));

  onSnapshot(
    q,
    (snap) => {
      const list = document.getElementById("sos-list");
      list.innerHTML = "";
      let count = 0;
      const currentIds = new Set();

      // เรียงเอกสารจากใหม่ไปเก่า (ใหม่สุดอยู่บนสุด) ด้วย createdAt
      const docs = snap.docs.slice().sort((a, b) => {
        const ta = a.data().createdAt?.toMillis?.() ?? 0;
        const tb = b.data().createdAt?.toMillis?.() ?? 0;
        return tb - ta;
      });

      docs.forEach((docSnap) => {
        const d = docSnap.data();
        const id = docSnap.id;
        currentIds.add(id);
        count++;

      // --- marker บนแผนที่ ---
      if (!sosMarkers.has(id)) {
        const marker = L.marker([d.lat, d.lng], {
          icon: L.divIcon({
            className: "",
            html: `<div class="sos-pin ${d.status}">🆘</div>`,
            iconSize: [28, 28]
          })
        }).addTo(map);
        sosMarkers.set(id, marker);
      }
      sosMarkers.get(id).bindPopup(
        `<b>${d.userName || "ไม่ระบุชื่อ"}</b><br>${statusLabel(d.status)}<br>แบต ${d.battery ?? "ไม่ทราบ"}%` +
        (d.userPhone ? `<br>โทร ${d.userPhone}` : "")
      );

      // --- รายการในแผงด้านข้าง ---
      const item = document.createElement("div");
      item.className = "sos-list-item";
      item.innerHTML = `
        <div class="top-row">
          <b>${d.userName || "ไม่ระบุชื่อ"}</b>
          <span class="tag" style="background:${badgeColor(d.status)}">แบต ${d.battery ?? "N/A"}%</span>
        </div>
        <div style="font-size:0.8rem;color:#B8790A;margin-top:2px">${statusLabel(d.status)}</div>
        <div class="mono" style="color:#6B7A8F;font-size:0.75rem;margin-top:4px">
          ${d.lat.toFixed(5)}, ${d.lng.toFixed(5)} ${d.userPhone ? " · โทร " + d.userPhone : ""}
        </div>
        <div class="actions">
          <button class="primary" data-action="ack" data-id="${id}">รับเรื่องแล้ว</button>
          <button data-action="resolve" data-id="${id}">✅ ปลอดภัยแล้ว</button>
        </div>
      `;
      list.appendChild(item);
      });

      // ลบ marker ที่ไม่มีในผลลัพธ์แล้ว (ถูก resolve ไปแล้ว)
      sosMarkers.forEach((marker, id) => {
        if (!currentIds.has(id)) {
          map.removeLayer(marker);
          sosMarkers.delete(id);
        }
      });

      document.getElementById("stat-sos-pending").textContent = count;
      if (count === 0) {
        list.innerHTML = '<div style="color:#6B7A8F;font-size:0.85rem">ไม่มีคำขอ SOS ที่ค้างอยู่ในขณะนี้</div>';
      }
    },
    (err) => {
      // ถ้า query ล้มเหลว (เช่น Firestore rules ปฏิเสธ) ให้เห็น error ชัดเจนแทนที่จะเงียบไปเฉยๆ
      console.error("watchSOS error:", err);
      document.getElementById("sos-list").innerHTML =
        `<div style="color:#E5484D;font-size:0.8rem">โหลดข้อมูล SOS ไม่สำเร็จ: ${err.message}</div>`;
    }
  );

  document.getElementById("sos-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const ref = doc(db, "sos_alerts", id);
    if (btn.dataset.action === "resolve") {
      await updateDoc(ref, { resolved: true, resolvedAt: serverTimestamp() });
    } else {
      await updateDoc(ref, { acknowledged: true });
      btn.textContent = "✓ รับเรื่องแล้ว";
      btn.disabled = true;
    }
  });
}

function badgeColor(status) {
  const map = {
    trapped: "#E5484D",
    injured_severe: "#F5A623",
    injured_minor: "#E5C85A",
    helping: "#3E7CB1"
  };
  return map[status] || "#94A3B8";
}

// -------------------------------------------------------- ฟังความจุจุดปลอดภัย
function watchZones() {
  onSnapshot(collection(db, "zone_state"), (snap) => {
    let totalPeople = 0;
    let totalCapacity = 0;

    snap.forEach((docSnap) => {
      const d = docSnap.data();
      const id = docSnap.id;
      totalPeople += d.currentCount || 0;
      totalCapacity += d.capacity || 0;

      const ratio = (d.currentCount || 0) / (d.capacity || 1);
      const cls = ratio > 0.85 ? "full" : ratio > 0.5 ? "mid" : "ok";

      if (zoneMarkers.has(id)) map.removeLayer(zoneMarkers.get(id));
      const marker = L.marker([d.lat, d.lng], {
        icon: L.divIcon({ className: "", html: `<div class="zone-pin ${cls}"><span>🏕️</span></div>`, iconSize: [26, 26] })
      })
        .addTo(map)
        .bindPopup(`<b>${d.name}</b><br>${d.currentCount || 0}/${d.capacity} คน`);
      zoneMarkers.set(id, marker);
    });

    document.getElementById("stat-total-people").textContent = totalPeople;
  });
}

// -------------------------------------------------------- ฟังสถิติคำขอ/เช็คอิน
function watchRequests() {
  onSnapshot(collection(db, "safe_requests"), (snap) => {
    totalRequests = snap.size;
    totalCheckins = 0;
    snap.forEach((d) => { if (d.data().checkedIn) totalCheckins++; });

    document.getElementById("stat-requests").textContent = totalRequests;
    document.getElementById("stat-checkins").textContent = totalCheckins;
    document.getElementById("stat-not-arrived").textContent = Math.max(0, totalRequests - totalCheckins);
  });
}

// -------------------------------------------------------- รายชื่อผู้ปลอดภัย (เช็คอินแล้ว)
function watchSafePeople() {
  // ใช้ where() อย่างเดียว (ไม่ผสม orderBy) เพื่อเลี่ยงปัญหา composite index เหมือน watchSOS
  const q = query(collection(db, "safe_requests"), where("checkedIn", "==", true));

  onSnapshot(
    q,
    (snap) => {
      const list = document.getElementById("safe-list");
      const docs = snap.docs.slice().sort((a, b) => {
        const ta = a.data().checkInTime?.toMillis?.() ?? 0;
        const tb = b.data().checkInTime?.toMillis?.() ?? 0;
        return tb - ta;
      });

      if (docs.length === 0) {
        list.innerHTML = '<div style="color:#6B7A8F;font-size:0.85rem">ยังไม่มีใครเช็คอินปลอดภัย</div>';
        return;
      }

      list.innerHTML = "";
      docs.slice(0, 30).forEach((docSnap) => {
        const d = docSnap.data();
        const item = document.createElement("div");
        item.className = "sos-list-item";
        item.innerHTML = `
          <div class="top-row">
            <b>${d.userName || "ไม่ระบุชื่อ"}</b>
            <span class="tag" style="background:#2FB380">✅ ปลอดภัย</span>
          </div>
          <div style="font-size:0.8rem;color:#6B7A8F;margin-top:2px">📍 ${d.recommendedZoneName || "-"}</div>
          ${d.userPhone ? `<div class="mono" style="color:#6B7A8F;font-size:0.75rem;margin-top:2px">โทร ${d.userPhone}</div>` : ""}
        `;
        list.appendChild(item);
      });
    },
    (err) => {
      console.error("watchSafePeople error:", err);
      document.getElementById("safe-list").innerHTML =
        `<div style="color:#E5484D;font-size:0.8rem">โหลดข้อมูลไม่สำเร็จ: ${err.message}</div>`;
    }
  );
}

function tickClock() {
  document.getElementById("clock-pill").textContent = new Date().toLocaleTimeString("th-TH");
}

initMap();
watchSOS();
watchZones();
watchRequests();
watchSafePeople();
setInterval(tickClock, 1000);
tickClock();
