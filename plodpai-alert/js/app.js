// ============================================================================
// app.js — ไฟล์หลักของหน้า index.html
// เชื่อมแผนที่ + quake.js + safezone.js + sos.js เข้าด้วยกัน
// ============================================================================

import { getUserLocation, showToast, formatClock, FALLBACK_LOCATION } from "./utils.js";
import { initQuakeWatcher, setWideMode, simulateQuake } from "./quake.js";
import { fetchNearbySafeZones, scoreZones, fetchWalkingRoute, checkInToZone } from "./safezone.js";
import { initSOS, getStatusOptions, submitSOS, closeStatusSheet } from "./sos.js";
import { db, collection, addDoc, updateDoc, doc, serverTimestamp } from "./config.js";

let map, userMarker, epicenterCircle, epicenterMarker, routeLine;
const zoneMarkers = new Map();
let userLocation = null;
let currentRecommendation = null; // จุดที่ระบบแนะนำล่าสุด (ไว้ใช้ตอนกดเช็คอิน)
let currentRequestId = null; // id ของเอกสาร safe_requests ล่าสุด (ไว้ผูกกับการเช็คอิน)
let quakeCountdownTimer = null;

async function main() {
  userLocation = await getUserLocation();
  if (userLocation.isFallback) {
    showToast("ไม่พบสัญญาณ GPS — ใช้ตำแหน่งสำรอง (โรงเรียนหนองหินวิทยาคม)");
  }

  initMap();
  initQuakeWatcher(userLocation, onQuakeDetected);
  wireButtons();
}

function initMap() {
  map = L.map("map", { zoomControl: false }).setView([userLocation.lat, userLocation.lng], 14);
  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors"
  }).addTo(map);

  userMarker = L.marker([userLocation.lat, userLocation.lng], {
    icon: L.divIcon({ className: "", html: '<div style="font-size:22px">📍</div>', iconSize: [24, 24] })
  }).addTo(map).bindPopup("ตำแหน่งของคุณ");
}

// ------------------------------------------------------------------ ปุ่มต่างๆ
function wireButtons() {
  document.getElementById("btn-request-zone").addEventListener("click", handleRequestZone);
  document.getElementById("btn-checkin").addEventListener("click", handleCheckIn);
  document.getElementById("btn-demo").addEventListener("click", openDemoPanel);
  document.getElementById("btn-wide-mode").addEventListener("click", toggleWideMode);

  initSOS(document.getElementById("btn-sos"), () => userLocation);

  getStatusOptions().forEach((opt) => {
    const btn = document.querySelector(`.status-option[data-key="${opt.key}"]`);
    if (btn) btn.addEventListener("click", () => submitSOS(opt.key));
  });
  document.getElementById("sos-cancel").addEventListener("click", closeStatusSheet);

  // แผงจำลองแผ่นดินไหว
  document.getElementById("demo-run").addEventListener("click", () => {
    const mag = parseFloat(document.getElementById("demo-magnitude").value);
    simulateQuake(mag, userLocation.lat, userLocation.lng);
    document.getElementById("demo-panel").classList.remove("show");
  });
  document.getElementById("demo-cancel").addEventListener("click", () => {
    document.getElementById("demo-panel").classList.remove("show");
  });
}

function openDemoPanel() {
  document.getElementById("demo-panel").classList.add("show");
}

let wideModeOn = false;
function toggleWideMode() {
  wideModeOn = !wideModeOn;
  setWideMode(wideModeOn);
  const btn = document.getElementById("btn-wide-mode");
  btn.textContent = wideModeOn
    ? "🌏 โหมดขยายพื้นที่: เปิดอยู่ (ตรวจข้อมูลจริงทั่วโลก)"
    : "🌏 เปิดโหมดขยายพื้นที่ (พิสูจน์ข้อมูลจริงจาก USGS)";
}

// ------------------------------------------------------------ แจ้งเตือนแผ่นดินไหว
function onQuakeDetected(quake, etaSeconds) {
  const banner = document.getElementById("quake-banner");
  banner.classList.add("show");
  document.getElementById("qb-place").textContent = quake.place;
  document.getElementById("qb-mag").textContent = quake.magnitude.toFixed(1);
  document.getElementById("qb-distance").textContent = Math.round(quake.distanceKm);
  document.getElementById("qb-source").textContent = quake.source === "DEMO" ? "DEMO MODE" : "USGS (ข้อมูลจริง)";

  drawEpicenter(quake, etaSeconds);
  startCountdown(etaSeconds);
}

function drawEpicenter(quake, etaSeconds) {
  if (epicenterMarker) map.removeLayer(epicenterMarker);
  if (epicenterCircle) map.removeLayer(epicenterCircle);

  epicenterMarker = L.marker([quake.lat, quake.lng], {
    icon: L.divIcon({ className: "", html: '<div class="pulse-marker"></div>', iconSize: [16, 16] })
  }).addTo(map).bindPopup(`ศูนย์กลาง: ${quake.place}<br>ขนาด ${quake.magnitude}`);

  epicenterCircle = L.circle([quake.lat, quake.lng], {
    radius: 1000,
    color: "#E5484D",
    weight: 1,
    fillOpacity: 0.05
  }).addTo(map);

  // แสดงคลื่นสั่นสะเทือนที่ขยายตัวไปตามเวลาจริง (สื่อฟิสิกส์ของคลื่น S)
  const startTime = Date.now();
  const speedMs = 3500; // ม./วินาที
  clearInterval(quakeCountdownTimer?.waveTimer);
  const waveTimer = setInterval(() => {
    const elapsedSec = (Date.now() - startTime) / 1000;
    epicenterCircle.setRadius(Math.min(elapsedSec * speedMs, 3000000));
  }, 200);
  if (quakeCountdownTimer) quakeCountdownTimer.waveTimer = waveTimer;
}

function startCountdown(etaSeconds) {
  clearInterval(quakeCountdownTimer?.timer);
  let remaining = etaSeconds;
  const etaEl = document.getElementById("qb-eta");

  function tick() {
    if (remaining <= 0) {
      etaEl.textContent = "คลื่นสั่นสะเทือนอาจถึงแล้ว — หมอบ-กำบัง-ยึด";
      clearInterval(quakeCountdownTimer.timer);
      return;
    }
    etaEl.textContent = `แรงสั่นอาจถึงในอีก ${remaining} วินาที`;
    remaining -= 1;
  }
  tick();
  const timer = setInterval(tick, 1000);
  quakeCountdownTimer = { timer, waveTimer: quakeCountdownTimer?.waveTimer };
}

// -------------------------------------------------------------- จุดปลอดภัย
async function handleRequestZone() {
  const btn = document.getElementById("btn-request-zone");
  const label = btn.querySelector(".btn-label");
  const originalLabel = label.textContent;
  btn.disabled = true;
  label.textContent = "กำลังค้นหา...";
  showToast("🔎 กำลังค้นหาจุดปลอดภัยใกล้คุณ...");

  try {
    const zones = await fetchNearbySafeZones(userLocation.lat, userLocation.lng);
    const ranked = scoreZones(zones);

    if (ranked.length === 0) {
      showToast("ไม่พบจุดปลอดภัยในรัศมี 5 กม. ลองขยับตำแหน่งหรือเพิ่มรัศมีในโค้ด");
      btn.disabled = false;
      label.textContent = originalLabel;
      return;
    }

    currentRecommendation = ranked[0];
    renderZonesOnMap(ranked);
    renderRecommendation(currentRecommendation);
    drawRouteTo(currentRecommendation);

    // บันทึกคำขอนี้ไว้วิเคราะห์ (กี่คนขอ, ขอจุดไหน, เช็คอินสำเร็จกี่คน)
    const reqRef = await addDoc(collection(db, "safe_requests"), {
      lat: userLocation.lat,
      lng: userLocation.lng,
      recommendedZoneId: currentRecommendation.id,
      recommendedZoneName: currentRecommendation.name,
      checkedIn: false,
      createdAt: serverTimestamp()
    });
    currentRequestId = reqRef.id;

    document.getElementById("btn-checkin").disabled = false;
  } catch (err) {
    console.error(err);
    showToast("ดึงข้อมูลจุดปลอดภัยไม่สำเร็จ ลองใหม่อีกครั้ง");
  } finally {
    btn.disabled = false;
    label.textContent = originalLabel;
  }
}

function renderZonesOnMap(zones) {
  zoneMarkers.forEach((m) => map.removeLayer(m));
  zoneMarkers.clear();

  zones.forEach((z, idx) => {
    const ratio = z.occupancyRatio;
    const cls = ratio > 0.85 ? "full" : ratio > 0.5 ? "mid" : z.category === "help" ? "help" : "ok";
    const marker = L.marker([z.lat, z.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div class="zone-pin ${cls}"><span>${z.emoji}</span></div>`,
        iconSize: [26, 26]
      })
    })
      .addTo(map)
      .bindPopup(
        `<b>${idx === 0 ? "⭐ แนะนำ: " : ""}${z.name}</b><br>` +
        `ระยะทาง ${z.distanceKm.toFixed(1)} กม.<br>` +
        `ความจุ ${z.currentCount}/${z.capacity} คน`
      );
    zoneMarkers.set(z.id, marker);
  });
}

function renderRecommendation(zone) {
  const card = document.getElementById("recommend-card");
  card.classList.add("show");
  document.getElementById("rec-name").textContent = `${zone.emoji} ${zone.name}`;
  document.getElementById("rec-distance").textContent = zone.distanceKm.toFixed(2) + " กม.";
  document.getElementById("rec-capacity").textContent = `${zone.currentCount}/${zone.capacity} คน`;
  const pct = Math.min(100, Math.round((zone.currentCount / zone.capacity) * 100));
  document.getElementById("rec-bar").style.width = pct + "%";
  document.getElementById("rec-bar").style.background =
    pct > 85 ? "var(--alert-red)" : pct > 50 ? "var(--warn-amber)" : "var(--safe-green)";
}

async function drawRouteTo(zone) {
  if (routeLine) map.removeLayer(routeLine);
  try {
    const coords = await fetchWalkingRoute(userLocation.lat, userLocation.lng, zone.lat, zone.lng);
    routeLine = L.polyline(coords, { color: "#3E7CB1", weight: 4, opacity: 0.85 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  } catch (e) {
    // fallback: เส้นตรง ถ้า OSRM เรียกไม่สำเร็จ (เช่น ไม่มีเน็ตหรือ rate limit)
    routeLine = L.polyline(
      [[userLocation.lat, userLocation.lng], [zone.lat, zone.lng]],
      { color: "#3E7CB1", weight: 3, dashArray: "6 6" }
    ).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
  }
}

async function handleCheckIn() {
  if (!currentRecommendation) return;
  const btn = document.getElementById("btn-checkin");
  btn.disabled = true;
  try {
    await checkInToZone(currentRecommendation);
    if (currentRequestId) {
      await updateDoc(doc(db, "safe_requests", currentRequestId), {
        checkedIn: true,
        checkInTime: serverTimestamp()
      });
    }
    showToast(`✅ เช็คอินที่ ${currentRecommendation.name} สำเร็จ`);
    // รีเฟรชข้อมูลความจุหลังเช็คอิน เพื่อให้คนถัดไปได้คำแนะนำที่กระจายตัว
    currentRecommendation.currentCount += 1;
    renderRecommendation(currentRecommendation);
  } catch (err) {
    console.error(err);
    showToast("เช็คอินไม่สำเร็จ ลองใหม่อีกครั้ง");
    btn.disabled = false;
  }
}

main();
