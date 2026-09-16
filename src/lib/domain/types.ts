/**
 * 도메인 타입 정의
 * PRD §5 입력 데이터 명세 · §6 도메인 규칙 기준
 */

// ─────────────────────────────────────────────────────────────
// 공통
// ─────────────────────────────────────────────────────────────

/** 자정으로부터 경과한 분 (예: 08:30 → 510) */
export type Minutes = number;

/** 시간창 하나. 점심 등 배제 구간이 있으면 시간창 2개로 분리한다 (R-14) */
export interface TimeWindow {
  start: Minutes;
  end: Minutes;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** 지오코딩 결과 출처 — 도로명/지번/입구 좌표 분기 (FR-21) */
export type GeoSource = "entrance" | "road" | "jibun" | "demo" | "manual";

export interface GeoResult extends GeoPoint {
  source: GeoSource;
  /** TMAP 응답의 매칭 도로명 — 입력 주소와 교차 확인 (FR-23) */
  matchedRoadName?: string;
  /** TMAP 응답의 remainder — 값이 있으면 주소 정제 대상 */
  remainder?: string;
  /** 지오코딩에 실제로 사용한 정제 주소 */
  queriedAddress: string;
}

/** 검증 결과 심각도 */
export type IssueLevel = "error" | "warning" | "info";

/** 담당자 확인 목록의 한 항목 */
export interface Issue {
  level: IssueLevel;
  /** 규칙/요구사항 ID (예: "FR-03", "R-05") */
  code: string;
  message: string;
  /** 관련 대상 식별자 (납품처 키, 기사명, 행 번호 등) */
  subject?: string;
  /** 원문과 해석을 나란히 보여주기 위한 부가 정보 */
  detail?: string;
}

// ─────────────────────────────────────────────────────────────
// 출고등록현황 (§5.1)
// ─────────────────────────────────────────────────────────────

/** 엑셀 원본 1행 */
export interface ShipmentRow {
  rowNo: number;
  출고일자: string;
  고객코드: string;
  고객: string;
  납품처코드: string;
  납품처우편번호: string | null;
  납품처: string;
  납품처주소: string;
  납품처담당자: string | null;
  납품처전화번호: string | null;
  납품시간: string | null;
  납품처휴대폰번호: string | null;
  배송방법코드: string;
  배송방법: string | null;
  품번: string | null;
  품명: string | null;
  규격: string | null;
  관리단위: string | null;
  재고단위수량: number;
  출고수량: number | null;
  재고단위: string | null;
  "비고(건)": string | null;
  "비고(내역)": string | null;
  출고창고코드: string | null;
  출고창고: string | null;
}

/** 배차 제외 사유 (R-01) */
export type ExclusionReason = "픽업" | "이체" | "취소" | "기타";

export interface ExcludedRow {
  rowNo: number;
  납품처: string;
  배송방법: string;
  reason: ExclusionReason;
  boxes: number;
}

/** 납품처 문자열 파싱 결과 (§5.1.1 / FR-10) */
export interface ParsedDeliveryName {
  /** 선두 코스코드 — 3/4/5/10/20. 권역 묶음 1차 힌트 (OI-1) */
  courseCode: number | null;
  company: string;
  region: string;
  /** 슬래시 4번째 이후 토큰 전부 — 시간·하차 조건 원문 */
  conditionText: string;
  /** 파싱된 토큰 수 (3/4/5) */
  tokenCount: number;
  raw: string;
}

/** 특이사항 태그 (§5.3-(6) / FR-13) */
export type DeliveryTag =
  | "비대면"
  | "안전화"
  | "도크지정"
  | "혼적금지"
  | "맞교환"
  | "랩핑"
  | "온도기록"
  | "유통기한기재"
  | "사전연락"
  | "검수실경유"
  | "차량톤수제한"
  | "제품한정"
  | "점심배제"
  | "수작업";

/** 시간창의 출처와 신뢰도 (FR-11) */
export interface TimeWindowResolution {
  /** 최종 채택된 시간창 배열. 빈 배열이면 시간 무제약 */
  windows: TimeWindow[];
  /** 납품시간 컬럼 원문 */
  columnRaw: string | null;
  /** 납품시간 컬럼을 해석한 시간창 */
  fromColumn: TimeWindow[];
  /** 납품처명 조건 텍스트 원문 */
  nameRaw: string;
  /** 납품처명을 해석한 시간창 */
  fromName: TimeWindow[];
  /** 두 소스가 어긋나면 true — 담당자 확인 목록으로 (§5.3-(1)) */
  conflict: boolean;
  /**
   * 불일치 유형
   *  - boundary : 외곽 경계가 다름 (마감/시작 오차 — 시간 위반 직결)
   *  - missing  : 한쪽만 시간 정보를 가짐 (컬럼 결손 회수)
   *  - refine   : 경계는 같고 내부만 세분화 (점심 배제 등)
   */
  mismatch: "none" | "boundary" | "missing" | "refine";
  /** "권장" 표현이면 true — 필수 제약으로 강제하지 않는다 */
  advisory: boolean;
  /** 배제 구간만 주어져 운영 시간 08:00~18:00을 가정했는지 */
  assumedOperating: boolean;
  /**
   * 원문에 **시작 시각이 명시**되어 있었는지.
   * 마감만 있는 표현(`13시착`)은 시작을 08:00 기본값으로 채우므로,
   * 이 플래그 없이는 "시작이 이르다"를 판정할 수 없다 (R-08 startBy9).
   */
  hasExplicitStart: boolean;
  /** 어느 소스를 채택했는지 */
  adopted: "column" | "name" | "both" | "none";
  /** 채택 근거 설명 (화면·엑셀에 원문과 함께 표시) */
  note: string;
}

/**
 * 배차 단위. 납품처명 + 주소로 그룹핑한다 (R-02).
 * 납품처코드는 중복·비정규 값이라 식별자로 쓰지 않는다 (§5.1 #4).
 */
export interface DeliveryPoint {
  /** `${납품처}|${정규화 주소}` */
  id: string;
  raw납품처: string;
  address: string;
  /** 지오코딩용으로 층·도크 등 부가정보를 제거한 주소 (FR-20) */
  cleanAddress: string;
  parsedName: ParsedDeliveryName;
  boxes: number;
  /** 구성 오더 행 번호 */
  rowNos: number[];
  /** 대표 연락처 1개 (FR: 배차표에 1개만 전재) */
  contact: string | null;
  /** 비고(건) 원문 모음 */
  memos: string[];
  /** 비고(건)에서 추출한 박스 수 합계 — 교차 검증용 (§5.3-(5)) */
  memoBoxes: number | null;
  time: TimeWindowResolution;
  tags: DeliveryTag[];
  /** 차량 톤수 제한 (예: 3.5 = 3.5톤 이하만) — R-10 */
  maxTonnage: number | null;
  geo?: GeoResult;
  /** 초과 물량 분할로 생성된 조각이면 원본 id (R-06) */
  splitFrom?: string;
  splitIndex?: number;
}

export interface ShipmentParseResult {
  /** 배차 일자 (YYYYMMDD) */
  date: string;
  totalRows: number;
  targetRows: number;
  excluded: ExcludedRow[];
  points: DeliveryPoint[];
  totalBoxes: number;
  issues: Issue[];
}

// ─────────────────────────────────────────────────────────────
// 차량 마스터 (§5.2)
// ─────────────────────────────────────────────────────────────

export interface Vehicle {
  id: string;
  기사명: string;
  톤수라벨: string;
  /** 숫자 톤수 (예: "3.5톤" → 3.5) */
  tonnage: number;
  최소수량: number;
  최대수량: number;
  회전수: number;
  최소업체수: number;
  최대업체수: number;
  도착지: string;
  cleanArrival: string;
  arrivalGeo?: GeoResult;
}

/** 업로드 즉시 표시하는 파생 지표 (FR-07) */
export interface FleetCapacity {
  driverCount: number;
  totalTrips: number;
  /** 전 차량 최대수량 × 회전수 합계 */
  maxBoxes: number;
  /** 전 차량 최소수량 × 회전수 합계 */
  minBoxes: number;
  /** 회전당 최대업체수 합계 */
  maxCompanies: number;
  minCompanies: number;
}

export interface FleetParseResult {
  vehicles: Vehicle[];
  capacity: FleetCapacity;
  issues: Issue[];
}

// ─────────────────────────────────────────────────────────────
// 배차 결과 (§6 / FR-40~44)
// ─────────────────────────────────────────────────────────────

/** 미배차 사유 코드 (FR-43) */
export type UnassignedReason =
  | "회전초과"
  | "적재상한"
  | "업체수상한"
  | "시간창불가"
  | "원거리"
  | "분할잔여"
  | "주소미확인"
  | "차량제약"
  | "대형차단독"
  | "수도권외"
  | "적재하한미달";

export interface Stop {
  seq: number;
  pointId: string;
  company: string;
  region: string;
  address: string;
  boxes: number;
  tags: DeliveryTag[];
  /** 차량 톤수 상한 (R-10). 제약이 없으면 null */
  maxTonnage: number | null;
  /** 원문에 시작 시각이 명시되어 있었는지 (R-08 startBy9 판정용) */
  hasExplicitStart: boolean;
  timeRaw: string;
  windows: TimeWindow[];
  /** TMAP arriveTime (분). 최적화 전에는 null */
  arriveAt: Minutes | null;
  /** 시간창 충족 여부 */
  timeOk: boolean | null;
  contact: string | null;
  geo?: GeoResult;
}

export interface Trip {
  id: string;
  vehicleId: string;
  기사명: string;
  톤수라벨: string;
  tripNo: number;
  stops: Stop[];
  boxes: number;
  /** 적재율 = boxes / 최대수량 */
  loadRate: number;
  /** 센터 → 마지막 하차지 주행거리 (km) */
  driveKm: number;
  /** 마지막 하차지 → 기사 도착지 공차 귀가 거리 (km) */
  homeKm: number;
  /** 회전 출발 시각 */
  departAt: Minutes;
  /** 귀가 도착 예정 시각 */
  homeAt: Minutes | null;
  /** 실도로 값이 반영되었는지 (직선 근사 → TMAP 교체, FR-30/44) */
  distanceSource: "haversine" | "tmap";
}

export interface UnassignedItem {
  pointId: string;
  company: string;
  region: string;
  address: string;
  boxes: number;
  timeRaw: string;
  reason: UnassignedReason;
  note: string;
}

export interface ApiUsage {
  geocode: number;
  routes: number;
  sequential: number;
  optimize: number;
  map: number;
}

export interface DispatchResult {
  date: string;
  trips: Trip[];
  unassigned: UnassignedItem[];
  addressIssues: AddressIssue[];
  totalBoxes: number;
  assignedBoxes: number;
  unassignedBoxes: number;
  usedTrips: number;
  violations: Issue[];
  issues: Issue[];
  apiUsage: ApiUsage;
  /** AI 브리핑 (FR-19) */
  briefing?: string;
  generatedAt: string;
  demoMode: boolean;
}

/** 주소확인필요 시트 항목 (R-13 / FR-15) */
export interface AddressIssue {
  pointId: string;
  company: string;
  rawAddress: string;
  queriedAddress: string;
  failureType: "변환실패" | "도로명불일치" | "remainder존재" | "도착지실패";
  suggestion: string | null;
  note: string;
}
