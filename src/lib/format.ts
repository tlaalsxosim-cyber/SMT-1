import { DRIVER_COLORS } from "@/lib/domain/constants";

export function hhmm(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return "—";
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function minutesFromHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

export function n(v: number): string {
  return v.toLocaleString("ko-KR");
}

export function km(v: number): string {
  return `${v.toFixed(1)}km`;
}

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatDate(yyyymmdd: string): string {
  if (!/^\d{8}$/.test(yyyymmdd)) return yyyymmdd || "—";
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 기사별 고정 색상 — 지도 마커와 티켓이 같은 색을 쓰게 한다 */
export function driverColor(vehicleIds: string[], vehicleId: string): string {
  const idx = vehicleIds.indexOf(vehicleId);
  return DRIVER_COLORS[(idx < 0 ? 0 : idx) % DRIVER_COLORS.length];
}

export function loadRateTone(rate: number): string {
  if (rate >= 0.9) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 0.7) return "text-sky-600 dark:text-sky-400";
  if (rate >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-rose-600 dark:text-rose-400";
}
