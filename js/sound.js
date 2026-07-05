// ============================================================================
// sound.js — เสียงไซเรนแจ้งเตือนแผ่นดินไหว + สั่นเครื่อง (มือถือ)
//
// ใช้ Web Audio API สังเคราะห์เสียงเอง แทนการโหลดไฟล์เสียงจากภายนอก เพราะ:
//   1) ทำงานได้ทันทีแม้ไม่มีสัญญาณอินเทอร์เน็ต (สำคัญมากตอนเกิดภัยพิบัติจริง)
//   2) ไม่มีปัญหาลิขสิทธิ์เสียง
//   3) ไม่เพิ่มขนาดไฟล์ให้เว็บโหลดช้า
// ============================================================================

let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

// เบราว์เซอร์ส่วนใหญ่บล็อกเสียงที่เล่นเองโดยไม่มีการโต้ตอบจากผู้ใช้ก่อน (autoplay policy)
// จึงต้อง "ปลดล็อก" AudioContext ตั้งแต่การแตะ/คลิกครั้งแรกของผู้ใช้ในหน้าเว็บ
["click", "touchstart", "keydown"].forEach((evt) => {
  document.addEventListener(
    evt,
    () => {
      const ctx = getAudioCtx();
      if (ctx.state === "suspended") ctx.resume();
    },
    { once: true }
  );
});

/** เล่นเสียงไซเรน 2 โทนสลับกัน (คล้ายเสียงเตือนภัย) ความยาวประมาณ durationMs */
export function playSiren(durationMs = 4000) {
  const ctx = getAudioCtx();
  if (ctx.state === "suspended") ctx.resume();

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  gain.gain.value = 0.22; // ความดังพอได้ยินชัด แต่ไม่แสบหู
  osc.connect(gain);
  gain.connect(ctx.destination);

  const start = ctx.currentTime;
  const end = start + durationMs / 1000;
  let t = start;

  // สลับความถี่ขึ้น-ลงทุก 0.3 วิ ให้ฟังดูเหมือนไซเรนเตือนภัยจริง
  while (t < end) {
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.linearRampToValueAtTime(660, t + 0.3);
    t += 0.3;
    osc.frequency.setValueAtTime(660, t);
    osc.frequency.linearRampToValueAtTime(880, t + 0.3);
    t += 0.3;
  }

  osc.start(start);
  osc.stop(end);
}

/** สั่นเครื่อง (รองรับเฉพาะมือถือ/เบราว์เซอร์ที่มี Vibration API) */
export function vibrateAlert() {
  if (navigator.vibrate) {
    navigator.vibrate([300, 150, 300, 150, 300]);
  }
}
