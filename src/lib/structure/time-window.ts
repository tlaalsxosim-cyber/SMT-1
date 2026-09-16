/**
 * 납품 시간창 규칙 파서 (FR-11, FR-12, FR-17 / R-14)
 *
 * 두 개의 소스를 각각 해석한 뒤 대조·병합한다.
 *  - 납품시간 컬럼:  `~13:00` `8:00~14:00` 형태의 반정형 값
 *  - 납품처명 조건:  `8~11또는13~14:30(점심11:30~13)` 형태의 비정형 텍스트
 *
 * 실데이터(2026-09-15)에서 두 소스는 어긋나는 건이 존재한다 (PRD §5.3-(1)).
 * 컬럼만 신뢰하면 마감 시각이 최대 2시간 과대 계상되어 시간 위반 배송이 발생한다.
 */

import type { Minutes, TimeWindow } from "@/lib/domain/types";

/**
 * 납품 시작 시각 기본값 — **08:00** (현업 확정, 2026-09-16)
 *
 * `13시착`, `~13:00` 처럼 마감만 주어진 배송지도 08:00 이전에는 하차할 수 없다.
 * 이 값을 00:00으로 두면 두 가지 문제가 생긴다.
 *   1. 기사가 새벽에 도착해도 하차 가능한 것으로 계산되어 도착예정시각이 비현실적이 된다.
 *   2. "시작 ≤ 09:00" 판정(R-08)에 마감만 있는 배송지가 전부 걸려 기준이 무의미해진다.
 */
export const ASSUMED_DELIVERY_START: Minutes = 8 * 60;

/** 시간 정보가 없고 배제 구간만 주어졌을 때 가정하는 운영 시간 */
export const ASSUMED_OPERATING: TimeWindow = {
  start: ASSUMED_DELIVERY_START,
  end: 18 * 60,
};

export interface SegmentParse {
  windows: TimeWindow[];
  exclusions: TimeWindow[];
  /** "권장" 표현이면 true — 필수 제약으로 강제하지 않는다 */
  advisory: boolean;
  /** 배제 구간만 있어 운영 시간을 가정했는지 */
  assumedOperating: boolean;
  /**
   * 원문에 **시작 시각이 명시**되어 있었는지.
   * 마감만 있는 표현은 시작을 08:00 기본값으로 채우므로, 이 플래그가 없으면
   * "시작이 이르다"는 판정을 할 수 없다 (R-08 startBy9).
   */
  explicitStart: boolean;
  /** 시간 표현을 하나도 찾지 못했으면 false */
  recognized: boolean;
}

/** 마감만 주어진 표현을 시간창으로 만든다 — 시작은 08:00 기본값 */
function deadlineWindow(end: Minutes): TimeWindow[] {
  // 마감이 08:00 이전인 비정상 값은 시작을 열어 둔다 (검증에서 걸러진다)
  const start = end > ASSUMED_DELIVERY_START ? ASSUMED_DELIVERY_START : 0;
  return [{ start, end }];
}

// ─────────────────────────────────────────────────────────────
// 정규화
// ─────────────────────────────────────────────────────────────

/** 구분자·표기 흔들림을 흡수한다 */
export function normalizeTimeText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\s+/g, "")
    .replace(/[～〜⁓]/g, "~")
    .replace(/[‐-―－]/g, "-")
    .replace(/또는|OR|&/g, "|")
    .replace(/부터/g, "~")
    .replace(/이내|이전|까지|안에/g, "전")
    .replace(/정오/g, "12시");
}

/** `8:30-13:00` 처럼 하이픈을 범위 구분자로 쓴 경우에만 `~`로 바꾼다 */
function hyphenToTilde(seg: string): string {
  return seg.replace(/(\d{1,2}(?::\d{2})?)-(\d{1,2}(?::\d{2})?)/g, "$1~$2");
}

// ─────────────────────────────────────────────────────────────
// 시각 토큰 파싱
// ─────────────────────────────────────────────────────────────

const TIME_TOKEN =
  /(오전|오후)?\s*(\d{1,2})\s*(?::|시)\s*(\d{1,2})?\s*분?|(오전|오후)?\s*(\d{1,2})(?![:\d])/;

export interface TimeToken {
  minutes: Minutes;
  meridiem: "am" | "pm" | null;
}

/**
 * 문자열에서 첫 번째 시각 표현을 추출해 분 단위로 반환한다.
 * `13시30분` → 810, `오후2:30분` → 870, `10시` → 600, `2` → 120 (AM/PM 미확정)
 */
export function parseTimeToken(text: string): TimeToken | null {
  const m = TIME_TOKEN.exec(text);
  if (!m) return null;

  const meridiemRaw = m[1] ?? m[4] ?? null;
  const hourRaw = m[2] ?? m[5];
  if (hourRaw === undefined) return null;

  let hour = Number(hourRaw);
  const minute = m[3] !== undefined ? Number(m[3]) : 0;
  if (!Number.isFinite(hour) || hour > 24 || minute > 59) return null;

  const meridiem = meridiemRaw === "오전" ? "am" : meridiemRaw === "오후" ? "pm" : null;

  // "오후 3시" → 15시. "오전 12시"는 관용적으로 정오를 뜻하므로 그대로 둔다.
  if (meridiem === "pm" && hour < 12) hour += 12;

  return { minutes: hour * 60 + minute, meridiem };
}

/** 범위의 종료 시각이 시작보다 작으면 오후로 해석한다 (`11:30~2` → 11:30~14:00) */
function resolveEnd(start: Minutes, end: Minutes): Minutes {
  let e = end;
  while (e <= start && e + 12 * 60 <= 24 * 60) e += 12 * 60;
  return e;
}

/** 마감 단독 표현의 오후 추정 (`2시전` → 14:00). 8시 미만이면 오후로 본다. */
function resolveDeadline(parsed: TimeToken): Minutes {
  if (parsed.meridiem) return parsed.minutes;
  if (parsed.minutes < 8 * 60) return parsed.minutes + 12 * 60;
  return parsed.minutes;
}

// ─────────────────────────────────────────────────────────────
// 괄호 처리 — 배제 구간 추출
// ─────────────────────────────────────────────────────────────

const EXCLUSION_HINT = /점심|제외|X$|엑스$/i;

interface ParenSplit {
  body: string;
  exclusions: TimeWindow[];
  /** 배제 구간이 아닌 괄호 내용 (하차 조건 등) */
  notes: string[];
}

function splitParens(text: string): ParenSplit {
  const exclusions: TimeWindow[] = [];
  const notes: string[] = [];

  const body = text.replace(/\(([^)]*)\)/g, (_all: string, inner: string) => {
    const content = hyphenToTilde(inner);
    const isExclusion = EXCLUSION_HINT.test(content) && content.includes("~");
    if (isExclusion) {
      const w = parseRange(content);
      if (w) {
        exclusions.push(w);
        return "";
      }
    }
    notes.push(inner);
    return "";
  });

  return { body, exclusions, notes };
}

/** `12:30~13:30` `11:30~13` 형태를 시간창 하나로 */
function parseRange(seg: string): TimeWindow | null {
  const idx = seg.indexOf("~");
  if (idx < 0) return null;
  const left = parseTimeToken(seg.slice(0, idx));
  const right = parseTimeToken(seg.slice(idx + 1));
  if (!left || !right) return null;
  const start = left.minutes;
  const end = resolveEnd(start, right.minutes);
  if (end <= start) return null;
  return { start, end };
}

// ─────────────────────────────────────────────────────────────
// 세그먼트 파싱
// ─────────────────────────────────────────────────────────────

interface SegmentResult {
  windows: TimeWindow[];
  /** 이 세그먼트가 시작 시각을 명시했는지 */
  explicitStart: boolean;
}

function parseSegment(segRaw: string): SegmentResult {
  const seg = hyphenToTilde(segRaw);
  const none: SegmentResult = { windows: [], explicitStart: false };
  if (!seg) return none;

  // `~13:00` — 선행 물결표 마감
  if (seg.startsWith("~")) {
    const t = parseTimeToken(seg.slice(1));
    if (!t) return none;
    return { windows: deadlineWindow(resolveDeadline(t)), explicitStart: false };
  }

  // `8~14시` — 범위. 시작이 명시된 유일한 형태다.
  const range = parseRange(seg);
  if (range) return { windows: [range], explicitStart: true };

  const t = parseTimeToken(seg);

  if (!t) {
    // 숫자 없는 표현
    if (/오전/.test(seg)) return { windows: deadlineWindow(12 * 60), explicitStart: false };
    if (/오후/.test(seg)) {
      return { windows: [{ start: 12 * 60, end: 18 * 60 }], explicitStart: true };
    }
    return none;
  }

  // `13시30분전` `10시` `13시착` — 단독 시각은 마감으로 해석
  return { windows: deadlineWindow(resolveDeadline(t)), explicitStart: false };
}

// ─────────────────────────────────────────────────────────────
// 배제 구간 차감 (R-14)
// ─────────────────────────────────────────────────────────────

/** 시간창에서 배제 구간을 빼 분리된 시간창 배열을 만든다 */
export function subtractExclusions(
  windows: TimeWindow[],
  exclusions: TimeWindow[]
): TimeWindow[] {
  if (exclusions.length === 0) return windows;

  let result = windows.map((w) => ({ ...w }));
  for (const ex of exclusions) {
    const next: TimeWindow[] = [];
    for (const w of result) {
      if (ex.end <= w.start || ex.start >= w.end) {
        next.push(w);
        continue;
      }
      if (ex.start > w.start) next.push({ start: w.start, end: Math.min(ex.start, w.end) });
      if (ex.end < w.end) next.push({ start: Math.max(ex.end, w.start), end: w.end });
    }
    result = next;
  }
  // 1분 이하 잔여 구간 제거
  return result.filter((w) => w.end - w.start > 1);
}

/** 겹치는 시간창 병합 */
export function mergeWindows(windows: TimeWindow[]): TimeWindow[] {
  if (windows.length <= 1) return windows;
  const sorted = windows.map((w) => ({ ...w })).sort((a, b) => a.start - b.start);
  const out: TimeWindow[] = [sorted[0]];
  for (const w of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (w.start <= last.end) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 공개 API
// ─────────────────────────────────────────────────────────────

/**
 * 비정형 시간 텍스트 한 덩어리를 시간창 배열로 해석한다.
 * 납품시간 컬럼과 납품처명 조건 텍스트 모두 이 함수를 통과한다.
 */
export function parseTimeText(raw: string | null | undefined): SegmentParse {
  const empty: SegmentParse = {
    windows: [],
    exclusions: [],
    advisory: false,
    assumedOperating: false,
    explicitStart: false,
    recognized: false,
  };
  if (!raw) return empty;

  const normalized = normalizeTimeText(raw);
  if (!normalized) return empty;

  const advisory = /권장|가능하면|되도록/.test(normalized);
  const { body, exclusions } = splitParens(normalized);

  // `점심11~12시30분` — 배제 구간이 본문에 그대로 나온 경우
  let bodyText = body;
  const leadingLunch = /^점심(.+)$/.exec(bodyText);
  if (leadingLunch) {
    const w = parseRange(hyphenToTilde(leadingLunch[1]));
    if (w) {
      exclusions.push(w);
      bodyText = "";
    }
  }

  const segments = bodyText.split(/[|/]/).filter(Boolean);
  const collected: TimeWindow[] = [];
  let explicitStart = false;
  for (const seg of segments) {
    const parsed = parseSegment(seg);
    collected.push(...parsed.windows);
    if (parsed.windows.length > 0 && parsed.explicitStart) explicitStart = true;
  }
  let windows = mergeWindows(collected);

  let assumedOperating = false;
  if (windows.length === 0 && exclusions.length > 0) {
    windows = [{ ...ASSUMED_OPERATING }];
    assumedOperating = true;
  }

  const finalWindows = subtractExclusions(windows, exclusions);

  return {
    windows: finalWindows,
    exclusions,
    advisory,
    assumedOperating,
    explicitStart,
    recognized: finalWindows.length > 0,
  };
}

// ─────────────────────────────────────────────────────────────
// 형식 검증 (FR-17)
// ─────────────────────────────────────────────────────────────

export function validateWindows(windows: TimeWindow[]): string | null {
  for (const w of windows) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) return "시간 값이 숫자가 아님";
    if (w.start < 0 || w.end > 24 * 60) return "00:00~24:00 범위를 벗어남";
    if (w.start >= w.end) return "시작 시각이 종료 시각 이상";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 표시·비교 유틸
// ─────────────────────────────────────────────────────────────

export function toHHMM(m: Minutes): string {
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function formatWindows(windows: TimeWindow[]): string {
  if (windows.length === 0) return "제약없음";
  return windows
    .map((w) => (w.start === 0 ? `~${toHHMM(w.end)}` : `${toHHMM(w.start)}~${toHHMM(w.end)}`))
    .join(", ");
}

/**
 * 가장 늦은 마감 시각 — "이 배송지는 몇 시까지 갈 수 있는가".
 * 점심으로 나뉜 시간창에서는 마지막 구간의 종료가 실질 마감이다.
 * (`earliestDeadline`은 첫 구간의 종료라 2회전 판정에 쓰면 안 된다.)
 */
export function latestDeadline(windows: TimeWindow[]): Minutes | null {
  if (windows.length === 0) return null;
  return Math.max(...windows.map((w) => w.end));
}

/** 시간창 총 가용 시간 (분) — 엄격도 비교용 */
export function windowSpan(windows: TimeWindow[]): number {
  return windows.reduce((s, w) => s + (w.end - w.start), 0);
}

/** 시간창 배열의 외곽 경계 */
export function envelope(windows: TimeWindow[]): TimeWindow | null {
  if (windows.length === 0) return null;
  return {
    start: Math.min(...windows.map((w) => w.start)),
    end: Math.max(...windows.map((w) => w.end)),
  };
}

export function windowsEqual(a: TimeWindow[], b: TimeWindow[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x.start - y.start);
  const sb = [...b].sort((x, y) => x.start - y.start);
  return sa.every((w, i) => w.start === sb[i].start && w.end === sb[i].end);
}

/** 특정 시각이 시간창 중 하나에 들어가는지. 시간창이 없으면 무제약으로 본다. */
export function isWithin(windows: TimeWindow[], at: Minutes): boolean {
  if (windows.length === 0) return true;
  return windows.some((w) => at >= w.start && at <= w.end);
}

/** 가장 이른 마감 시각 */
export function earliestDeadline(windows: TimeWindow[]): Minutes | null {
  if (windows.length === 0) return null;
  return Math.min(...windows.map((w) => w.end));
}

/** 가장 이른 시작 시각 */
export function earliestStart(windows: TimeWindow[]): Minutes | null {
  if (windows.length === 0) return null;
  return Math.min(...windows.map((w) => w.start));
}
