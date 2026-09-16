/**
 * 납품처 문자열 파서 (FR-10 / PRD §5.1.1)
 *
 * 관측 패턴: `{코스코드}/{업체명}/{권역}/{조건}`
 *   55건 중 4토큰 49건, 5토큰 3건, 3토큰 3건.
 *
 * 업체명·권역 토큰 자체에 괄호와 하이픈이 섞여 있으므로
 * (`다봄푸드(오포저온물류센터)`, `광주-문형산안길`, `광주새말길(2창고)`)
 * 슬래시 분해만 하고 토큰 내부는 건드리지 않는다.
 */

import { TAG_PATTERNS, TONNAGE_LIMIT_RE, ADDRESS_NOISE_PATTERNS } from "@/lib/domain/constants";
import type { DeliveryTag, ParsedDeliveryName } from "@/lib/domain/types";

export function parseDeliveryName(raw: string): ParsedDeliveryName {
  const text = (raw ?? "").normalize("NFC").trim();
  const tokens = text.split("/").map((t) => t.trim());

  // 선두 토큰이 순수 숫자일 때만 코스코드로 인정한다 (OI-1: 의미 확인 필요)
  const head = tokens[0] ?? "";
  const hasCourse = /^\d+$/.test(head);
  const courseCode = hasCourse ? Number(head) : null;

  const rest = hasCourse ? tokens.slice(1) : tokens;
  const company = rest[0] ?? text;
  const region = rest[1] ?? "";
  const conditionText = rest.slice(2).join("/");

  return {
    courseCode,
    company,
    region,
    conditionText,
    tokenCount: tokens.length,
    raw: text,
  };
}

/**
 * 권역 정규화 — `광주-문형산안길`, `광주새말길(2창고)`, `이천(양녕로)` 처럼
 * 세부 지점이 붙은 표기에서 시·군 단위를 뽑는다. 권역 묶음의 1차 키로 쓴다 (R-07).
 */
export function normalizeRegion(region: string): string {
  if (!region) return "미상";
  return (
    region
      .replace(/\([^)]*\)/g, "")
      .split(/[-–—]/)[0]
      .replace(/\s+/g, "")
      .trim() || "미상"
  );
}

// ─────────────────────────────────────────────────────────────
// 특이사항 태그 (FR-13)
// ─────────────────────────────────────────────────────────────

/**
 * 납품처명 조건 텍스트 + 비고 필드에서 하차 조건 태그를 뽑는다.
 * 실데이터에서 확인된 어휘만 사전에 올려 두고, 사전에 없는 표현은
 * 생성형 AI 계층이 보완한다 (FR-13 · llm.ts).
 */
export function extractTags(...sources: (string | null | undefined)[]): DeliveryTag[] {
  const haystack = sources.filter(Boolean).join(" ").normalize("NFC");
  if (!haystack) return [];

  const found = new Set<DeliveryTag>();
  for (const { tag, patterns } of TAG_PATTERNS) {
    if (patterns.some((re) => re.test(haystack))) found.add(tag);
  }
  return [...found];
}

/** 차량 톤수 제한 추출 (R-10) — `13시전(3.5톤이하)` → 3.5 */
export function extractTonnageLimit(...sources: (string | null | undefined)[]): number | null {
  const haystack = sources.filter(Boolean).join(" ").normalize("NFC");
  const m = TONNAGE_LIMIT_RE.exec(haystack);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

// ─────────────────────────────────────────────────────────────
// 주소 정제 (FR-20 / PRD §5.3-(4))
// ─────────────────────────────────────────────────────────────

/**
 * 지오코딩 호출 전 층·도크·검수실 등 부가정보를 제거한다.
 * 원문은 보존하고 정제본만 API에 넘긴다 — 실패 시 원문으로 재시도할 수 있어야 한다.
 */
export function cleanAddress(raw: string): string {
  let s = (raw ?? "").normalize("NFC").trim();

  for (const re of ADDRESS_NOISE_PATTERNS) s = s.replace(re, " ");

  s = s
    .replace(/,/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*\(\s*\)\s*/g, " ")
    .trim();

  // 붙여 쓴 주소에 최소한의 띄어쓰기를 넣는다
  // `경기도하남시감초로184번길53-49(초이동)` → `경기도 하남시 감초로 184번길 53-49 (초이동)`
  s = s
    .replace(/(도|특별시|광역시)(?=[가-힣]{2,}시)/g, "$1 ")
    .replace(/(시|군|구)(?=[가-힣]{2,}(로|길|읍|면|동))/g, "$1 ")
    .replace(/(읍|면)(?=[가-힣]{2,}(로|길))/g, "$1 ")
    .replace(/(로|길)(?=\d)/g, "$1 ")
    .replace(/(\d)(?=번길)/g, "$1 ")
    .replace(/(번길)(?=\d)/g, "$1 ")
    .replace(/(\d)(?=[가-힣]{2,}(동|리)\b)/g, "$1 ")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*\)\s*/g, ") ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return s;
}

/** 납품처 그룹 키 — 납품처명 + 정규화 주소 (R-02) */
export function pointKey(납품처: string, 주소: string): string {
  const addr = (주소 ?? "").normalize("NFC").replace(/\s+/g, "").trim();
  return `${(납품처 ?? "").normalize("NFC").trim()}|${addr}`;
}

/**
 * 같은 장소 판정 키 (R-17)
 *
 * 대형차 회전에 **2번째 업체를 붙여도 되는지**를 가르는 기준이다.
 * 도로명은 `…로/길 + 건물번호(+번길 + 번호)`까지, 지번은 `…동/리/가 + 번지`까지만 남기고
 * 층·도크·건물명·회사명 같은 꼬리는 버린다. 시·도 표기는 축약형으로 통일한다.
 *
 *   `경기도 광주시 새말길 126`      → `경기광주시새말길126`
 *   `경기 광주시 새말길 126 3층`    → `경기광주시새말길126`   (같은 장소)
 *   `경기도 광주시 세피내길 25`     → `경기광주시세피내길25`  (다른 장소)
 *
 * 판정이 빗나가도 안전한 쪽으로 기운다 — 못 알아보면 1업체(원칙)로 가고,
 * 알아보면 같은 건물에 2업체를 허용한다.
 */
const SIDO_ALIASES: [string, string][] = [
  ["서울특별시", "서울"],
  ["부산광역시", "부산"],
  ["대구광역시", "대구"],
  ["인천광역시", "인천"],
  ["광주광역시", "광주"],
  ["대전광역시", "대전"],
  ["울산광역시", "울산"],
  ["세종특별자치시", "세종"],
  ["경기도", "경기"],
  ["강원특별자치도", "강원"],
  ["강원도", "강원"],
  ["충청북도", "충북"],
  ["충청남도", "충남"],
  ["전북특별자치도", "전북"],
  ["전라북도", "전북"],
  ["전라남도", "전남"],
  ["경상북도", "경북"],
  ["경상남도", "경남"],
  ["제주특별자치도", "제주"],
];

/**
 * 도로명 — `…로/길 + 번호`(+ `번길 + 번호`)
 * 공백을 먼저 지우면 `새말길 126 3층`이 `새말길1263`으로 붙어 버린다.
 * 띄어쓰기를 살린 채로 끊고 나서 공백을 지운다.
 */
const ROAD_RE = /^(.*?(?:로|길)\s?\d+(?:\s?번길\s?\d+)?(?:-\d+)?)/;
/** 지번 — `…동/리/가 + 번지` */
const JIBUN_RE = /^(.*?(?:동|리|가)\s?\d+(?:-\d+)?)/;

export function siteKey(주소: string): string {
  let s = (주소 ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!s) return "";

  for (const [long, short] of SIDO_ALIASES) {
    if (s.startsWith(long)) {
      s = short + s.slice(long.length);
      break;
    }
  }

  const head = ROAD_RE.exec(s)?.[1] ?? JIBUN_RE.exec(s)?.[1] ?? s;
  return head.replace(/\s+/g, "");
}

/** 비고(건)에서 박스 수를 추출한다 — `ok/50박스` → [50] (§5.3-(5) 교차 검증) */
export function extractMemoBoxes(memo: string | null | undefined): number[] {
  if (!memo) return [];
  const out: number[] = [];
  const re = /(\d[\d,]*)\s*박스/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(memo)) !== null) {
    const v = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}
