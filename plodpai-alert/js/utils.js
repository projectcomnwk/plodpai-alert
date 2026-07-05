// ============================================================================
// utils.js — ฟังก์ชันช่วยเหลือที่ใช้ร่วมกันหลายไฟล์
// ============================================================================

// พิกัดสำรอง: โรงเรียนหนองหินวิทยาคม อ.หนองหิน จ.เลย
// ใช้เมื่อผู้ใช้ปฏิเสธ GPS หรืออุปกรณ์หา location ไม่ได้ (กันเดโมค้าง)
export const FALLBACK_LOCATION = { lat: 17.10199, lng: 101.86467, label: "โรงเรียนหนองหินวิทยาคม (ตำแหน่งสำรอง)" };

/** คำนวณระยะทางระหว่าง 2 พิกัด (หน่วยกิโลเมตร) ด้วยสูตร Haversine */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // รัศมีโลก (กม.)
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** ขอตำแหน่ง GPS ของผู้ใช้ ถ้าไม่ได้ (ปฏิเสธสิทธิ์/timeout) จะ fallback เป็นพิกัดโรงเรียน */
export function getUserLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ ...FALLBACK_LOCATION, isFallback: true });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          isFallback: false
        });
      },
      () => resolve({ ...FALLBACK_LOCATION, isFallback: true }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 15000 }
    );
  });
}

/** อ่านระดับแบตเตอรี่ (ถ้าเบราว์เซอร์รองรับ Battery API) */
export async function getBatteryLevel() {
  try {
    if (navigator.getBattery) {
      const battery = await navigator.getBattery();
      return Math.round(battery.level * 100);
    }
  } catch (e) {
    /* เบราว์เซอร์บางตัวไม่รองรับ — ไม่เป็นไร ส่ง null แทน */
  }
  return null;
}

/** แสดง toast แจ้งเตือนสั้นๆ ด้านล่างจอ */
export function showToast(message, duration = 2600) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), duration);
}

/** จัดรูปแบบเวลาเป็น HH:MM:SS ภาษาไทย */
export function formatClock(date = new Date()) {
  return date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** debounce แบบง่าย */
export function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
