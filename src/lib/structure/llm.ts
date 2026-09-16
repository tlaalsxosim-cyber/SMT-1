/**
 * 생성형 AI 조건 구조화 계층 (FR-10 ~ FR-19 / PRD §3)
 *
 * 설계 원칙 — AI는 **규칙 파서를 대체하지 않고 보완한다**.
 *   1. 규칙 파서(time-window.ts / delivery-name.ts)가 먼저 전부 처리한다.
 *      2026-09-15 실데이터에서 규칙만으로 55곳 중 45곳의 시간창을 확보한다.
 *   2. AI는 규칙이 해석하지 못했거나 어긋난 건만 받아 재해석한다.
 *   3. AI 출력은 구조화 JSON으로만 받고, 반드시 규칙 검증(validateWindows)을
 *      통과해야 배차에 반영한다. 통과하지 못하면 담당자 확인 목록으로 뺀다.
 *   4. 주소는 제안까지만 — 좌표 확정은 지오코딩 재호출 성공으로만 이루어진다 (FR-15).
 *
 * API 키가 없으면 전 과정이 규칙 기반으로만 동작하고, 그 사실을 이슈로 보고한다.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import type { DeliveryTag, Issue } from "@/lib/domain/types";
import { formatWindows, toHHMM, validateWindows } from "./time-window";

const MODEL = "claude-opus-5";

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function client(): Anthropic {
  return new Anthropic();
}

// ─────────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────────

const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-4]):[0-5]\d$/, "HH:MM 24시간 형식이어야 합니다");

const WindowSchema = z.object({
  start: HHMM.describe("배송 가능 시작 시각. 마감만 있으면 00:00"),
  end: HHMM.describe("배송 마감 시각"),
});

const ConditionSchema = z.object({
  key: z.string().describe("입력으로 준 key를 그대로 반환"),
  company: z.string().describe("업체명. 판단이 어려우면 입력값 그대로"),
  region: z.string().describe("시·군 단위 권역명"),
  windows: z
    .array(WindowSchema)
    .describe(
      "배송 가능 시간창. 점심 등 배제 구간이 있으면 구간을 나눠 2개 이상으로. 제약이 없으면 빈 배열"
    ),
  advisory: z.boolean().describe("'권장'처럼 강제가 아닌 표현이면 true"),
  earlyDelivery: z.boolean().describe("이른 아침(9시 이전) 납품이 요구되면 true"),
  maxTonnage: z
    .number()
    .nullable()
    .describe("차량 톤수 상한이 명시되면 숫자(예: 3.5), 없으면 null"),
  tags: z
    .array(z.string())
    .describe("하차 조건 태그. 비대면/안전화/도크지정/혼적금지/맞교환/랩핑/온도기록/유통기한기재/사전연락/검수실경유/차량톤수제한/제품한정/점심배제/수작업 중에서만"),
  confidence: z.enum(["high", "medium", "low"]).describe("해석 확신도"),
  reasoning: z.string().describe("한 문장으로 해석 근거"),
});

const ConditionBatchSchema = z.object({
  items: z.array(ConditionSchema),
});

const AddressSuggestionSchema = z.object({
  key: z.string(),
  suggestion: z
    .string()
    .nullable()
    .describe("도로명 또는 지번 표준 주소 후보. 확신이 없으면 null"),
  reason: z.string().describe("판단 근거 한 문장"),
});

const AddressBatchSchema = z.object({
  items: z.array(AddressSuggestionSchema),
});

const BriefingSchema = z.object({
  summary: z.string().describe("배차 결과 전체 요약 3~4문장"),
  drivers: z
    .array(z.object({ 기사명: z.string(), brief: z.string() }))
    .describe("기사별 1~2문장 브리핑"),
  charterAdvice: z.string().describe("기타(미배차) 물량에 대한 용차 판단 참고 2~3문장"),
});

// ─────────────────────────────────────────────────────────────
// 입출력 타입
// ─────────────────────────────────────────────────────────────

export interface ConditionRequestItem {
  key: string;
  /** 납품처 원문 전체 */
  raw납품처: string;
  /** 납품시간 컬럼 원문 */
  columnRaw: string | null;
  /** 규칙 파서가 뽑은 조건 텍스트 */
  conditionText: string;
  /** 규칙 파서가 도출한 시간창 (없으면 빈 배열) */
  ruleWindows: { start: number; end: number }[];
  /** 규칙 파서가 붙인 불일치 유형 */
  mismatch: string;
  memos: string[];
}

export interface ConditionResultItem {
  key: string;
  windows: { start: number; end: number }[];
  advisory: boolean;
  earlyDelivery: boolean;
  maxTonnage: number | null;
  tags: DeliveryTag[];
  confidence: "high" | "medium" | "low";
  reasoning: string;
  /** 규칙 검증을 통과했는지 — false면 배차에 반영하지 않는다 */
  accepted: boolean;
  rejectReason?: string;
}

export interface LlmOutcome<T> {
  enabled: boolean;
  items: T[];
  issues: Issue[];
  /** 호출 토큰 사용량 — 요약 시트에 기록 */
  usage?: { input: number; output: number };
}

const VALID_TAGS = new Set<string>([
  "비대면", "안전화", "도크지정", "혼적금지", "맞교환", "랩핑", "온도기록",
  "유통기한기재", "사전연락", "검수실경유", "차량톤수제한", "제품한정",
  "점심배제", "수작업",
]);

function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function describeIssue(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "ANTHROPIC_API_KEY가 유효하지 않습니다";
  if (e instanceof Anthropic.RateLimitError) return "Anthropic API 호출 한도에 걸렸습니다";
  if (e instanceof Anthropic.BadRequestError) return `요청 형식 오류: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Anthropic API에 연결하지 못했습니다";
  if (e instanceof Anthropic.APIError) return `Anthropic API 오류 ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

// ─────────────────────────────────────────────────────────────
// ① 조건 구조화 (FR-10~14, FR-16, FR-17)
// ─────────────────────────────────────────────────────────────

const CONDITION_SYSTEM = `당신은 냉장·냉동 식자재 물류센터의 배차 데이터를 정규화하는 전문가입니다.

입력은 한국 물류 현장에서 손으로 입력한 납품처 문자열과 납품시간 값입니다.
표기가 제각각이므로 아래 실제 사례를 기준으로 해석하십시오.

납품처 문자열 구조: {코스코드}/{업체명}/{권역}/{조건}
  예) 5/굿엉클스/하남/창고안적재(비대면)
  예) 3/스마트푸드/오산/9시~14시/안전화필히착용   ← 조건이 2토큰인 경우
  예) 5/신선한식탁/인천                            ← 조건이 없는 경우

시간 표기 해석 규칙:
- "13시30분전", "13시착", "2시전" 은 모두 마감 시각. 시작은 00:00으로 둡니다.
- "2시전"처럼 8시 미만의 숫자는 오후로 해석합니다 (2시 → 14:00).
- "오전"은 ~12:00, "오후"는 12:00~18:00 입니다.
- "8~11또는13~14:30" 처럼 또는/OR/& 로 나뉜 표기는 시간창 2개입니다.
- "(점심12-13시)", "(11:30~13시점심)", "(12~1:30X)", "(12시30분~13시30분제외)" 는
  배제 구간이므로 전체 범위에서 빼서 시간창을 2개로 나눕니다.
  "1:30" 처럼 시작보다 작은 종료 시각은 오후로 봅니다 (13:30).
- 시간 정보가 전혀 없으면 windows 를 빈 배열로 둡니다. 추측해서 만들지 마십시오.

중요: 납품시간 컬럼과 납품처명 원문이 어긋나면 **더 엄격한(가용 시간이 좁은) 쪽**을
채택하십시오. 컬럼 값이 실제보다 늦은 마감을 담고 있는 사례가 실재합니다.

규칙 파서가 이미 도출한 결과(ruleWindows)를 함께 드립니다.
규칙 파서가 맞다고 판단되면 같은 값을 반환하고, 규칙 파서가 놓친 것이 보이면 고치십시오.
확신이 없으면 confidence 를 low 로 두십시오 — 담당자가 확인합니다.`;

export async function structureConditions(
  items: ConditionRequestItem[]
): Promise<LlmOutcome<ConditionResultItem>> {
  const issues: Issue[] = [];

  if (items.length === 0) {
    return { enabled: hasApiKey(), items: [], issues };
  }
  if (!hasApiKey()) {
    return {
      enabled: false,
      items: [],
      issues: [
        {
          level: "info",
          code: "FR-16",
          message:
            "ANTHROPIC_API_KEY가 설정되지 않아 규칙 기반 해석만 사용합니다 — AI 보완 단계를 건너뜁니다",
        },
      ],
    };
  }

  const payload = items.map((it) => ({
    key: it.key,
    납품처원문: it.raw납품처,
    납품시간컬럼: it.columnRaw ?? "(비어있음)",
    조건텍스트: it.conditionText || "(없음)",
    규칙파서결과: it.ruleWindows.length
      ? it.ruleWindows.map((w) => `${toHHMM(w.start)}~${toHHMM(w.end)}`).join(", ")
      : "(해석 실패)",
    불일치유형: it.mismatch,
    비고: it.memos.slice(0, 3),
  }));

  try {
    const response = await client().messages.parse({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: CONDITION_SYSTEM,
      messages: [
        {
          role: "user",
          content: `다음 ${items.length}건의 납품 조건을 구조화하십시오. items 배열에 key를 그대로 담아 같은 개수로 반환하십시오.\n\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      output_config: { format: zodOutputFormat(ConditionBatchSchema) },
    });

    if (response.stop_reason === "refusal") {
      return {
        enabled: true,
        items: [],
        issues: [
          {
            level: "warning",
            code: "FR-16",
            message: "AI가 요청을 거절했습니다 — 규칙 기반 해석만 사용합니다",
            detail: response.stop_details?.explanation ?? undefined,
          },
        ],
      };
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      return {
        enabled: true,
        items: [],
        issues: [
          {
            level: "warning",
            code: "FR-16",
            message: "AI 응답이 스키마 검증에 실패했습니다 — 규칙 기반 해석만 사용합니다",
          },
        ],
      };
    }

    const results: ConditionResultItem[] = [];
    const seen = new Set<string>();

    for (const item of parsed.items) {
      if (seen.has(item.key)) continue;
      seen.add(item.key);

      const windows = item.windows.map((w) => ({
        start: hhmmToMinutes(w.start),
        end: hhmmToMinutes(w.end),
      }));

      // ── 규칙 검증 (FR-17) — 통과하지 못하면 배차에 반영하지 않는다
      const err = validateWindows(windows);
      const accepted = err === null;
      if (!accepted) {
        issues.push({
          level: "warning",
          code: "FR-17",
          message: `AI 시간창이 형식 검증에 실패해 반영하지 않습니다 — ${err}`,
          subject: item.company,
          detail: `${formatWindows(windows)} · ${item.reasoning}`,
        });
      }
      if (item.confidence === "low") {
        issues.push({
          level: "warning",
          code: "FR-18",
          message: "AI 해석 확신도가 낮아 담당자 확인이 필요합니다",
          subject: item.company,
          detail: `${formatWindows(windows)} · ${item.reasoning}`,
        });
      }

      results.push({
        key: item.key,
        windows,
        advisory: item.advisory,
        earlyDelivery: item.earlyDelivery,
        maxTonnage: item.maxTonnage,
        tags: item.tags.filter((t): t is DeliveryTag => VALID_TAGS.has(t)),
        confidence: item.confidence,
        reasoning: item.reasoning,
        accepted,
        rejectReason: err ?? undefined,
      });
    }

    const returned = new Set(results.map((r) => r.key));
    const dropped = items.filter((i) => !returned.has(i.key));
    if (dropped.length) {
      issues.push({
        level: "warning",
        code: "FR-16",
        message: `AI가 ${dropped.length}건을 반환하지 않아 규칙 결과를 유지합니다`,
        detail: dropped.map((d) => d.raw납품처).join(", "),
      });
    }

    return {
      enabled: true,
      items: results,
      issues,
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };
  } catch (e) {
    return {
      enabled: true,
      items: [],
      issues: [
        {
          level: "warning",
          code: "FR-16",
          message: `AI 조건 구조화에 실패해 규칙 기반 해석만 사용합니다 — ${describeIssue(e)}`,
        },
      ],
    };
  }
}

// ─────────────────────────────────────────────────────────────
// ② 주소 정제 제안 (FR-15) — 제안까지만, 자동 확정 금지
// ─────────────────────────────────────────────────────────────

const ADDRESS_SYSTEM = `당신은 한국 주소를 표준화하는 전문가입니다.
지오코딩에 실패한 물류 배송지 주소를 받아 표준 주소 후보를 제안하십시오.

- 도로명주소를 우선 제안하고, 확신이 없으면 지번주소를 제안합니다.
- 층·도크·검수실 같은 건물 내부 정보는 제거합니다.
- 오래된 행정구역 표기나 오타를 바로잡습니다.
  예) "경기도 화성시 만세구 남양읍 시청로 159" → 화성시에 만세구는 없습니다.
- 추측이 서지 않으면 반드시 suggestion 을 null 로 두십시오.
  잘못된 제안은 오배차로 이어지므로, 모르면 모른다고 하는 편이 낫습니다.`;

export interface AddressRequestItem {
  key: string;
  company: string;
  rawAddress: string;
  queriedAddress: string;
  failureNote: string;
}

export interface AddressResultItem {
  key: string;
  suggestion: string | null;
  reason: string;
}

export async function suggestAddresses(
  items: AddressRequestItem[]
): Promise<LlmOutcome<AddressResultItem>> {
  if (items.length === 0) return { enabled: hasApiKey(), items: [], issues: [] };
  if (!hasApiKey()) {
    return {
      enabled: false,
      items: [],
      issues: [
        {
          level: "info",
          code: "FR-15",
          message: "ANTHROPIC_API_KEY가 없어 주소 정제 제안을 건너뜁니다",
        },
      ],
    };
  }

  try {
    const response = await client().messages.parse({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: ADDRESS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `지오코딩에 실패한 주소 ${items.length}건입니다. 표준 주소 후보를 제안하십시오.\n\n${JSON.stringify(
            items.map((i) => ({
              key: i.key,
              업체명: i.company,
              원문주소: i.rawAddress,
              조회에사용한주소: i.queriedAddress,
              실패사유: i.failureNote,
            })),
            null,
            2
          )}`,
        },
      ],
      output_config: { format: zodOutputFormat(AddressBatchSchema) },
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return {
        enabled: true,
        items: [],
        issues: [
          { level: "warning", code: "FR-15", message: "AI 주소 제안을 받지 못했습니다" },
        ],
      };
    }

    return {
      enabled: true,
      items: response.parsed_output.items,
      issues: [],
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };
  } catch (e) {
    return {
      enabled: true,
      items: [],
      issues: [
        {
          level: "warning",
          code: "FR-15",
          message: `AI 주소 제안에 실패했습니다 — ${describeIssue(e)}`,
        },
      ],
    };
  }
}

// ─────────────────────────────────────────────────────────────
// ③ 배차 결과 브리핑 (FR-19)
// ─────────────────────────────────────────────────────────────

export interface BriefingInput {
  date: string;
  totalBoxes: number;
  assignedBoxes: number;
  unassignedBoxes: number;
  usedTrips: number;
  totalTrips: number;
  trips: {
    기사명: string;
    톤수라벨: string;
    tripNo: number;
    boxes: number;
    loadRate: number;
    homeKm: number;
    stops: { company: string; region: string; boxes: number; arriveAt: string | null }[];
  }[];
  unassigned: { company: string; region: string; boxes: number; reason: string }[];
}

export async function generateBriefing(
  input: BriefingInput
): Promise<LlmOutcome<never> & { briefing: string | null }> {
  if (!hasApiKey()) {
    return {
      enabled: false,
      items: [],
      briefing: null,
      issues: [
        {
          level: "info",
          code: "FR-19",
          message: "ANTHROPIC_API_KEY가 없어 AI 브리핑을 생성하지 않습니다",
        },
      ],
    };
  }

  try {
    const response = await client().messages.parse({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: `당신은 물류센터 배차 담당자에게 당일 배차 결과를 브리핑합니다.
숫자를 나열하지 말고 담당자가 바로 판단할 수 있는 정보를 주십시오.
특히 다음을 짚어 주십시오.
- 적재율이 낮은 회전과 그 이유
- 시간창이 빠듯해 주의가 필요한 배송지
- 귀가 거리가 유난히 긴 기사
- 미배차 물량의 권역 분포와 용차 1대로 묶을 수 있는지 여부
문장은 간결하게, 존댓말로 작성하십시오.`,
      messages: [
        {
          role: "user",
          content: `${input.date} 배차 결과입니다. 브리핑을 작성하십시오.\n\n${JSON.stringify(input, null, 2)}`,
        },
      ],
      output_config: { format: zodOutputFormat(BriefingSchema) },
    });

    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return {
        enabled: true,
        items: [],
        briefing: null,
        issues: [{ level: "info", code: "FR-19", message: "AI 브리핑을 받지 못했습니다" }],
      };
    }

    const p = response.parsed_output;
    const briefing = [
      p.summary,
      "",
      ...p.drivers.map((d) => `· ${d.기사명}: ${d.brief}`),
      "",
      `[용차 판단] ${p.charterAdvice}`,
    ].join("\n");

    return {
      enabled: true,
      items: [],
      briefing,
      issues: [],
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };
  } catch (e) {
    return {
      enabled: true,
      items: [],
      briefing: null,
      issues: [
        {
          level: "info",
          code: "FR-19",
          message: `AI 브리핑 생성에 실패했습니다 — ${describeIssue(e)}`,
        },
      ],
    };
  }
}
