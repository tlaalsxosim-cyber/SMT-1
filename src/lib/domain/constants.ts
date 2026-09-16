/**
 * 시스템 기본값 · 규칙 상수
 * 설정 탭에서 세션 한정으로만 변경되며 저장하지 않는다 (§11 ④)
 */

import type { DeliveryTag, GeoPoint, Minutes } from "./types";

/** 출발지 — 평택센터 단일 출발 (§1.2) */
export const CENTER = {
  name: "평택센터",
  address: "경기도 평택시 경기대로 245",
  /** 지오코딩 실패 시 사용할 폴백 좌표 (평택시청 인근) */
  fallback: { lat: 36.9924, lon: 127.1128 } as GeoPoint,
} as const;

/** 센터 출발 시각 기본값 (OI-7 미확정 — 설정 탭에서 변경 가능) */
export const DEFAULT_DEPART_MINUTES = 6 * 60; // 06:00

/** 2회전 재상차 소요 시간 가정 (R-09 / OI-8 미확정) */
export const RELOAD_MINUTES = 30;

/**
 * 2회전 이상 회전의 납품 마감 하한 (R-15) — **15:00 확정 (현업, 2026-09-16)**
 *
 * 센터로 복귀해 재상차한 뒤 다시 나가는 회전은 실제 하차가 정오를 넘긴다.
 * 마감이 15:00보다 이른 배송지는 **2회전에 배정하지 않는다**.
 * 1회전에는 적용하지 않으며, 시간 제약이 없는 배송지는 언제든 허용한다.
 *
 * 담당자가 바꿀 수 있는 설정이 아니라 확정된 업무 규칙이므로 상수로 둔다.
 * 다른 기준값의 영향을 재 보려면 `npm run compare`로 측정한다.
 */
export const SECOND_TRIP_MIN_DEADLINE: Minutes = 15 * 60;

/**
 * 대형차 판정 기준 톤수 (R-17) — **5톤 이상은 회전당 1업체가 원칙**
 *
 * 현업 확인(2026-09-16): "5톤이나 10톤 차는 1회전에 많아야 두 업체까지 하는데,
 * 그것도 주소지가 거의 동일한 경우만. 나머지는 한 업체로 간다고 가정하고 배차."
 *
 * 차량 마스터의 `최대업체수`(5·10톤 = 2)만으로는 이 구분을 표현할 수 없다.
 * 상한 2는 **같은 건물에 업체 둘이 있을 때의 상한**이지 "아무 두 곳이나 묶어도 된다"가 아니다.
 * 이 규칙이 없으면 30박스짜리 소량 업체가 10톤 차에 얹혀 실려 나간다
 * (2026-09-15 결과의 원앤원 30박스 + 하림충북 1,061박스 조합).
 */
export const LARGE_VEHICLE_TONNAGE = 5;

/**
 * 수도권 배차 경계 위도 (R-18) — 이 선보다 남쪽은 **지입 배차에서 제외**
 *
 * 현업 확정(2026-09-16, 2차): "평택 위쪽 수도권으로 우선 배차해야 하고, 익산 미담이나
 * 청주 하림충북 같은 지방 건은 용차를 배치해야 하는 상황이라 지입 배차에서 제외했으면 한다.
 * 수도권으로 무조건 나와야 한다."
 *
 * 1차 요청("되도록이면 위쪽으로")은 후순위였으나, 2차에서 **무조건 제외**로 확정됐다.
 * 후순위로 두면 북쪽에 대안이 없을 때 대형차가 그대로 남쪽으로 내려간다 —
 * 실데이터가 정확히 그랬다(익산 1,200 · 청주 1,061). 그래서 제외가 아니면 의미가 없다.
 *
 * 36.90은 평택센터(36.99)와 천안(36.81) 사이에 그은 선으로, **천안시 자체가 남쪽에 들어간다**.
 * 실데이터에서 걸리는 곳은 천안·아산·청주·익산 4곳이다.
 *
 * 제외된 물량은 버려지지 않는다 — 사유 「수도권외」로 기타에 남아 용차 판단으로 넘어간다(R-12).
 */
export const METRO_SOUTH_LIMIT_LAT = 36.9;

/** 납품처 1곳당 하차 소요 시간 가정 — TMAP arriveTime 보정용 */
export const UNLOAD_MINUTES = 20;

/** 배차 대상으로 인정하는 출고창고 (FR-05) */
export const EXPECTED_WAREHOUSE = "평택창고(수도권)";

/** 배차 대상으로 인정하는 재고단위 (FR-06) */
export const EXPECTED_STOCK_UNIT = "BOX";

/**
 * 조기납품 판정 기준 (R-08 / OI-2)
 * 실데이터 기준 `마감 ≤ 09:00`은 해당 0곳, `시작 ≤ 09:00`은 16곳으로 해가 없다.
 * 확정 전까지 중간값인 `마감 ≤ 10:00`(3곳)을 기본값으로 두고 설정에서 바꿀 수 있게 한다.
 */
export const EARLY_DELIVERY_MODE_DEFAULT: EarlyDeliveryMode = "endBy10";
export type EarlyDeliveryMode = "endBy9" | "endBy10" | "startBy9";

/** 조기납품 판정에 필요한 부가 정보 */
export interface EarlyRuleMeta {
  /** 원문에 시작 시각이 명시되어 있었는지 */
  hasExplicitStart: boolean;
}

export const EARLY_DELIVERY_RULES: Record<
  EarlyDeliveryMode,
  {
    label: string;
    describe: string;
    test: (w: { start: number; end: number }, meta: EarlyRuleMeta) => boolean;
  }
> = {
  endBy9: {
    label: "마감 ≤ 09:00",
    describe: "plan.md §3.2 원안 — 2026-09-15 실데이터 해당 0곳",
    test: (w) => w.end <= 9 * 60,
  },
  endBy10: {
    label: "마감 ≤ 10:00",
    describe: "기본값 — 실데이터 해당 3곳 (대명푸드·주아유통·태건푸드)",
    test: (w) => w.end <= 10 * 60,
  },
  startBy9: {
    label: "시작 ≤ 09:00 (명시된 경우만)",
    /**
     * 납품 시작 기본값이 08:00이므로, 이 조건 없이는 마감만 있는 배송지가 전부
     * "09:00 이전 시작"으로 잡혀 기준이 무의미해진다.
     * 원문에 시작 시각이 적힌 배송지로만 한정한다.
     */
    describe: "원문에 시작 시각이 적힌 업체만 — 실데이터 18곳",
    test: (w, meta) => meta.hasExplicitStart && w.start <= 9 * 60,
  },
};

/** TMAP 무료 한도 (§9.2) — 카운터 경고 기준 */
export const API_LIMITS = {
  geocode: 20000,
  routes: 1000,
  sequential: 1000,
  optimize: 50,
  map: 100000,
} as const;

/** 경유지 최적화 안전 상한 — 회전 12 + 재시도 12 (NFR-05) */
export const OPTIMIZE_SAFE_CAP = 24;

/** 시간창 위반 시 재구성·재호출 한도 (R-11) */
export const RETRY_LIMIT = 1;

/** 경유지 최적화 API가 허용하는 경유지 최대 개수 */
export const MAX_VIA_POINTS = 10;

/**
 * 특이사항 태그 추출 사전 (FR-13)
 * 납품처명 조건 텍스트 + 비고(건) + 비고(내역)에서 탐지한다.
 */
export const TAG_PATTERNS: { tag: DeliveryTag; patterns: RegExp[] }[] = [
  { tag: "비대면", patterns: [/비대면/, /무인/] },
  { tag: "안전화", patterns: [/안전화/] },
  { tag: "도크지정", patterns: [/\d+\s*번\s*도크/, /도크/] },
  { tag: "혼적금지", patterns: [/혼적\s*X/i, /혼적\s*금지/, /품목별로\s*적재/] },
  { tag: "맞교환", patterns: [/맞교환/] },
  { tag: "랩핑", patterns: [/랩핑/] },
  { tag: "온도기록", patterns: [/온도\s*기록/] },
  { tag: "유통기한기재", patterns: [/유통기한/, /소비기한/] },
  { tag: "사전연락", patterns: [/전화/, /연락/] },
  { tag: "검수실경유", patterns: [/검수실/] },
  { tag: "차량톤수제한", patterns: [/(\d+(?:\.\d+)?)\s*톤\s*이하/] },
  { tag: "제품한정", patterns: [/제품으로만/, /만\s*배송/] },
  { tag: "점심배제", patterns: [/점심/, /제외/, /12[~\-–]1?3?시?\s*X/i] },
  { tag: "수작업", patterns: [/수작업/] },
];

/** 차량 톤수 제한 추출 (R-10) — 예: "3.5톤이하" → 3.5 */
export const TONNAGE_LIMIT_RE = /(\d+(?:\.\d+)?)\s*톤\s*이하/;

/** 지오코딩 전 제거할 주소 부가정보 (FR-20) */
export const ADDRESS_NOISE_PATTERNS: RegExp[] = [
  /\([^)]*센터[^)]*\)/g,          // (시화센터)
  /\d+\s*번?\s*~?\s*\d*\s*번?\s*도크/g, // 7번~10번도크
  /지하\s*\d+\s*층/g,
  /\d+\s*층/g,
  /\(?\s*상온\s*,?\s*저온\s*동일\s*\)?/g,
  /\(\s*1층\s*검수실\s*\)/g,
  /검수실/g,
  /[가-힣]+동\s*\d+\s*번?~?\d*\s*번?도크/g,
];

/** 기사별 지도 마커 색상 (§11 ①) */
export const DRIVER_COLORS = [
  "#2563eb", "#dc2626", "#16a34a", "#ea580c", "#9333ea",
  "#0891b2", "#ca8a04", "#db2777", "#4f46e5",
] as const;
