/**
 * 클라이언트 ↔ 서버 API 계약
 *
 * 무저장 구조이므로 서버는 상태를 들지 않는다. 클라이언트가 파일과 결과를
 * 브라우저 메모리에 들고 있다가 매 요청에 필요한 만큼 실어 보낸다 (NFR-01).
 */

import type {
  DeliveryTag,
  DispatchResult,
  FleetCapacity,
  GeoResult,
  Issue,
  TimeWindow,
  Vehicle,
} from "@/lib/domain/types";
import type { EarlyDeliveryMode } from "@/lib/domain/constants";

// ─────────────────────────────────────────────────────────────
// POST /api/parse — 업로드 미리보기 (TMAP·AI 호출 없음)
// ─────────────────────────────────────────────────────────────

export interface PreviewPoint {
  id: string;
  company: string;
  region: string;
  courseCode: number | null;
  address: string;
  cleanAddress: string;
  boxes: number;
  /** 납품시간 컬럼 원문 */
  columnRaw: string | null;
  /** 납품처명 조건 텍스트 원문 */
  conditionText: string;
  /** 해석된 시간창 */
  windows: TimeWindow[];
  windowsText: string;
  mismatch: "none" | "boundary" | "missing" | "refine";
  note: string;
  tags: DeliveryTag[];
  maxTonnage: number | null;
  memoBoxes: number | null;
  orderRows: number;
}

export interface PreviewVehicle extends Omit<Vehicle, "arrivalGeo"> {
  /** 회전당 적재 범위를 한 줄로 */
  capacityText: string;
}

export interface ParseResponse {
  date: string;
  totalRows: number;
  targetRows: number;
  excluded: { reason: string; rows: number; boxes: number }[];
  excludedRows: number;
  pointCount: number;
  totalBoxes: number;
  points: PreviewPoint[];
  vehicles: PreviewVehicle[];
  capacity: FleetCapacity;
  issues: Issue[];
  /** FR-08 사전 경고 */
  warnings: {
    /** 납품처 수 − 업체 수 상한 (양수면 구조적 미배차) */
    structuralShortfall: number;
    /** 총 박스 − 적재 상한 (양수면 적재 초과) */
    capacityShortfall: number;
    /** 총 박스가 적재 하한보다 작으면 일부 차량 미운행 */
    belowMinimum: boolean;
  };
  /** 조기납품 후보 (기본 기준 적용) */
  earlyCandidates: { company: string; windowsText: string }[];
  serverStatus: ServerStatus;
}

// ─────────────────────────────────────────────────────────────
// POST /api/dispatch — 배차 실행
// ─────────────────────────────────────────────────────────────

export interface DispatchRequestOptions {
  demo: boolean;
  useAi: boolean;
  /** 분 단위 (06:00 → 360) */
  departAt: number;
  earlyMode: EarlyDeliveryMode;
  centerAddress?: string;
  drawRoutes: boolean;
}

export interface DispatchResponse extends DispatchResult {
  routePaths: Record<string, [number, number][]>;
  centerGeo: GeoResult;
  vehicles: Vehicle[];
  aiEnabled: boolean;
  tmapKeyPresent: boolean;
  sourceSummary: {
    totalRows: number;
    targetRows: number;
    excludedRows: number;
    pointCount: number;
    totalTrips: number;
    maxBoxes: number;
    minBoxes: number;
    maxCompanies: number;
  };
  serverStatus: ServerStatus;
  /** 실행에 걸린 시간 (ms) — NFR-04 5분 이내 확인용 */
  elapsedMs: number;
}

// ─────────────────────────────────────────────────────────────
// GET /api/status — 키 상태 · API 카운터 (FR-32, NFR-03)
// ─────────────────────────────────────────────────────────────

export interface ServerStatus {
  /** 키 존재 여부만 알린다. 값은 절대 내려보내지 않는다 (NFR-03) */
  tmapKeyPresent: boolean;
  anthropicKeyPresent: boolean;
  /** 지도 SDK용 브라우저 키 존재 여부 */
  mapKeyPresent: boolean;
  usage: {
    date: string;
    counts: { geocode: number; routes: number; sequential: number; optimize: number; map: number };
    limits: { geocode: number; routes: number; sequential: number; optimize: number; map: number };
    optimizeRemaining: number;
    optimizeSafeRemaining: number;
    running: boolean;
  };
}

// ─────────────────────────────────────────────────────────────
// 오류 응답
// ─────────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  hint?: string;
  detail?: string;
}

export function isApiError(v: unknown): v is ApiError {
  return typeof v === "object" && v !== null && "error" in v;
}
