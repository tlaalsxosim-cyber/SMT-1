/**
 * TMAP API 응답 타입 (PRD §2.2)
 *
 * 문서에 없는 필드가 섞여 오는 경우가 있어 전부 optional로 두고
 * 사용하는 쪽에서 분기·검증한다.
 */

// ── ① 지오코딩 fullAddrGeo
export interface TmapGeoCoordinate {
  /** 도로명 매칭 좌표 */
  newLat?: string;
  newLon?: string;
  /** 건물 입구 좌표 — 배송 실무에 우선 사용 */
  newLatEntr?: string;
  newLonEntr?: string;
  /** 지번 매칭 좌표 */
  lat?: string;
  lon?: string;
  newRoadName?: string;
  buildingIndex?: string;
  buildingName?: string;
  /** 값이 있으면 주소 정제 대상 */
  remainder?: string;
  city_do?: string;
  gu_gun?: string;
  eup_myun?: string;
  legalDong?: string;
  adminDong?: string;
  bunji?: string;
  roadName?: string;
  firstBuildNo?: string;
  secondBuildNo?: string;
  matchFlag?: string;
}

export interface TmapGeoResponse {
  coordinateInfo?: {
    /** 문자열로 온다. "0"이면 변환 실패 */
    totalCount?: string;
    coordinate?: TmapGeoCoordinate[];
  };
}

// ── ③ 자동차 경로안내 /tmap/routes
export interface TmapRouteFeature {
  type?: string;
  geometry?: {
    type?: string;
    /** LineString: [경도, 위도][] · Point: [경도, 위도] */
    coordinates?: number[][] | number[];
  };
  properties?: {
    /** 미터 */
    totalDistance?: number;
    /** 초 */
    totalTime?: number;
    totalFare?: number;
    taxiFare?: number;
    index?: number;
    pointIndex?: number;
    name?: string;
    description?: string;
    distance?: number;
    time?: number;
    /** 다중 경유지 응답의 경유지 도착 예정 시각 */
    arriveTime?: string;
    /** 경유지 구분 — "B1"이 경유지 */
    pointType?: string;
    viaPointId?: string;
    viaPointName?: string;
  };
}

export interface TmapRouteResponse {
  type?: string;
  features?: TmapRouteFeature[];
}

// ── ⑤ 경유지 최적화 routeOptimization10
export interface TmapOptimizationResponse {
  properties?: {
    totalDistance?: number;
    totalTime?: number;
    totalFare?: number;
  };
  features?: TmapRouteFeature[];
  /** 오류 응답 */
  error?: { id?: string; category?: string; message?: string };
}

export interface TmapErrorBody {
  error?: { id?: string; category?: string; message?: string };
  errorMessage?: string;
}
