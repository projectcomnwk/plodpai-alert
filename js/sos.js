// ============================================================================
// sos.js — ปุ่ม SOS ขอความช่วยเหลือ (กดค้าง 3 วินาทีกันกดพลาด)
// ============================================================================

import { db, collection, addDoc, serverTimestamp } from "./config.js";
import { getBatteryLevel, showToast } from "./utils.js";
import { getProfile } from "./profile.js";

const HOLD_DURATION_MS = 3000;

const STATUS_OPTIONS = [
  { key: "trapped",         emoji: "🔴", label: "ติดอยู่ ออกไม่ได้" },
  { key: "injured_severe",  emoji: "🟠", label: "บาดเจ็บ เดินไม่ได้" },
  { key: "injured_minor",   emoji: "🟡", label: "บาดเจ็บเล็กน้อย ต้องการความช่วยเหลือ" },
  { key: "helping",         emoji: "🔵", label: "ช่วยคนอื่นที่ติดอยู่ด้วยกัน" }
];

let holdTimer = null;
let holdStart = null;
let getLocationFn = null;

/** เริ่มระบบ SOS ต้องส่งฟังก์ชันที่คืนตำแหน่งปัจจุบันของผู้ใช้เข้ามา */
export function initSOS(sosButtonEl, getCurrentLocation) {
  getLocationFn = getCurrentLocation;
  const fill = sosButtonEl.querySelector(".hold-fill");

  const start = (e) => {
    e.preventDefault();
    holdStart = Date.now();
    fill.style.transition = "none";
    holdTimer = requestAnimationFrame(function step() {
      const elapsed = Date.now() - holdStart;
      const pct = Math.min(100, (elapsed / HOLD_DURATION_MS) * 100);
      fill.style.width = pct + "%";
      if (elapsed >= HOLD_DURATION_MS) {
        fill.style.width = "0%";
        openStatusSheet();
      } else {
        holdTimer = requestAnimationFrame(step);
      }
    });
  };

  const cancel = () => {
    cancelAnimationFrame(holdTimer);
    fill.style.transition = "width .2s ease";
    fill.style.width = "0%";
  };

  sosButtonEl.addEventListener("mousedown", start);
  sosButtonEl.addEventListener("touchstart", start, { passive: false });
  ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach((evt) =>
    sosButtonEl.addEventListener(evt, cancel)
  );
}

function openStatusSheet() {
  const backdrop = document.getElementById("sos-sheet");
  backdrop.classList.add("show");
}

export function closeStatusSheet() {
  document.getElementById("sos-sheet").classList.remove("show");
}

export function getStatusOptions() {
  return STATUS_OPTIONS;
}

/** ส่งคำขอ SOS จริงเข้า Firestore หลังผู้ใช้เลือกสถานะแล้ว */
export async function submitSOS(statusKey) {
  const location = await getLocationFn();
  const battery = await getBatteryLevel();
  const profile = getProfile();

  const docRef = await addDoc(collection(db, "sos_alerts"), {
    userId: profile?.userId || null,
    userName: profile?.name || "ไม่ระบุชื่อ",
    userPhone: profile?.phone || null,
    lat: location.lat,
    lng: location.lng,
    accuracy: location.accuracy || null,
    status: statusKey,
    battery,
    resolved: false,
    createdAt: serverTimestamp()
  });

  closeStatusSheet();
  showToast("🆘 ส่งคำขอความช่วยเหลือแล้ว — เจ้าหน้าที่จะเห็นตำแหน่งของคุณ");
  return docRef.id;
}
