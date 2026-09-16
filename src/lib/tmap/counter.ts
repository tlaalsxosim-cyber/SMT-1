/**
 * 일일 API 호출 카운터 (FR-32 / PRD §2.3)
 *
 * 경유지 최적화는 하루 50건이 전부다. 버튼 연타 한 번이 당일 운영분을 날린다.
 * 카운터는 **서버 프로세스 메모리에만** 둔다 — 무저장 원칙(NFR-01)상 DB에 쓰지 않으며,
 * 프로세스가 재시작되면 0으로 돌아간다. 화면에는 그 사실을 함께 표시한다.
 */

import { API_LIMITS, OPTIMIZE_SAFE_CAP } from "@/lib/domain/constants";
import type { ApiUsage } from "@/lib/domain/types";

export type ApiKind = keyof ApiUsage;

interface CounterState {
  date: string;
  counts: ApiUsage;
  /** 배차 실행 중 잠금 (FR-33) */
  running: boolean;
  startedAt: number | null;
}

const EMPTY: ApiUsage = { geocode: 0, routes: 0, sequential: 0, optimize: 0, map: 0 };

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 개발 중 HMR로 모듈이 다시 평가돼도 카운터가 초기화되지 않게 globalThis에 붙인다 */
const globalStore = globalThis as unknown as { __tmapCounter?: CounterState };

function state(): CounterState {
  if (!globalStore.__tmapCounter || globalStore.__tmapCounter.date !== today()) {
    globalStore.__tmapCounter = {
      date: today(),
      counts: { ...EMPTY },
      running: false,
      startedAt: null,
    };
  }
  return globalStore.__tmapCounter;
}

export function record(kind: ApiKind, n = 1): void {
  state().counts[kind] += n;
}

export function usage(): ApiUsage {
  return { ...state().counts };
}

export interface UsageReport {
  date: string;
  counts: ApiUsage;
  limits: typeof API_LIMITS;
  /** 경유지 최적화 잔여 — 가장 귀한 자원 */
  optimizeRemaining: number;
  optimizeSafeRemaining: number;
  running: boolean;
}

export function report(): UsageReport {
  const s = state();
  return {
    date: s.date,
    counts: { ...s.counts },
    limits: API_LIMITS,
    optimizeRemaining: Math.max(0, API_LIMITS.optimize - s.counts.optimize),
    optimizeSafeRemaining: Math.max(0, OPTIMIZE_SAFE_CAP - s.counts.optimize),
    running: s.running,
  };
}

/**
 * 최적화 호출 전 예산을 확인한다.
 * 안전 상한(24)을 넘으면 거부하고, 무료 한도(50)에 닿으면 강하게 막는다.
 */
export function assertOptimizeBudget(need: number): void {
  const s = state();
  const after = s.counts.optimize + need;
  if (after > API_LIMITS.optimize) {
    throw new Error(
      `경유지 최적화 무료 한도(${API_LIMITS.optimize}건)를 초과합니다. ` +
        `오늘 ${s.counts.optimize}건 사용, ${need}건 추가 요청. Demo Mode로 실행하십시오.`
    );
  }
  if (after > OPTIMIZE_SAFE_CAP) {
    throw new Error(
      `경유지 최적화 안전 상한(${OPTIMIZE_SAFE_CAP}건/일)을 초과합니다. ` +
        `오늘 ${s.counts.optimize}건 사용. 설정 탭에서 카운터를 확인하고 Demo Mode 사용을 검토하십시오.`
    );
  }
}

// ── 실행 잠금 (FR-33)

export class DispatchBusyError extends Error {
  constructor() {
    super("배차가 이미 실행 중입니다. 완료될 때까지 기다려 주십시오.");
    this.name = "DispatchBusyError";
  }
}

/** 실행 잠금을 잡는다. 이미 잡혀 있으면 예외 — 버튼 연타를 서버에서 막는다. */
export function acquireLock(): void {
  const s = state();
  // 5분 이상 걸린 실행은 죽은 것으로 보고 잠금을 푼다
  if (s.running && s.startedAt && Date.now() - s.startedAt > 5 * 60 * 1000) {
    s.running = false;
  }
  if (s.running) throw new DispatchBusyError();
  s.running = true;
  s.startedAt = Date.now();
}

export function releaseLock(): void {
  const s = state();
  s.running = false;
  s.startedAt = null;
}
