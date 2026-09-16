/**
 * AI 보완 대상 선별 및 결과 반영 (FR-16)
 *
 * 규칙 파서가 자신 있게 처리한 건은 AI에 보내지 않는다.
 * 호출 비용을 줄이려는 목적이 아니라, **검증 가능한 규칙 결과를 흔들지 않기 위해서**다.
 */

import type { DeliveryPoint, Issue } from "@/lib/domain/types";
import { formatWindows } from "./time-window";
import type { ConditionRequestItem, ConditionResultItem } from "./llm";

/**
 * AI에 보낼 대상을 고른다.
 *   a) 조건 텍스트가 있는데 규칙 파서가 시간창을 못 뽑은 경우
 *   b) 두 소스의 경계가 어긋난 경우 (boundary)
 *   c) 배제 구간만 있어 운영 시간을 가정한 경우
 *   d) 슬래시 토큰 수가 표준(4)을 벗어난 경우 — 파싱 자체가 흔들릴 수 있다
 */
export function selectForAi(points: DeliveryPoint[]): ConditionRequestItem[] {
  return points
    .filter((p) => {
      const hasConditionText = p.parsedName.conditionText.trim().length > 0;
      const ruleFoundNothing = p.time.windows.length === 0;
      const nonStandardTokens = p.parsedName.tokenCount !== 4;

      if (hasConditionText && ruleFoundNothing) return true;
      if (p.time.mismatch === "boundary") return true;
      if (p.time.assumedOperating) return true;
      if (nonStandardTokens && hasConditionText) return true;
      return false;
    })
    .map((p) => ({
      key: p.id,
      raw납품처: p.raw납품처,
      columnRaw: p.time.columnRaw,
      conditionText: p.parsedName.conditionText,
      ruleWindows: p.time.windows,
      mismatch: p.time.mismatch,
      memos: p.memos,
    }));
}

export interface ApplyOutcome {
  points: DeliveryPoint[];
  issues: Issue[];
  /** 규칙 결과와 AI 결과가 달라 담당자 확인이 필요한 건 */
  divergences: {
    company: string;
    rule: string;
    ai: string;
    confidence: string;
    reasoning: string;
    applied: boolean;
  }[];
}

/**
 * AI 결과를 반영한다.
 *
 * 반영 정책
 *   - 규칙 검증(accepted)을 통과하지 못하면 반영하지 않는다.
 *   - confidence가 low면 반영하지 않고 담당자 확인 목록으로만 보낸다.
 *   - 규칙 파서가 아무것도 못 뽑았던 자리(빈 시간창)는 AI 결과로 채운다.
 *   - 규칙 파서에 값이 있는데 AI가 다른 값을 내면, **더 엄격한 쪽**을 택한다.
 *     (FR-11의 병합 원칙을 AI에도 동일하게 적용한다)
 *   - 태그와 톤수 제한은 규칙 결과에 합집합으로 더한다 — 빼지 않는다.
 */
export function applyAiConditions(
  points: DeliveryPoint[],
  results: ConditionResultItem[]
): ApplyOutcome {
  const byKey = new Map(results.map((r) => [r.key, r]));
  const issues: Issue[] = [];
  const divergences: ApplyOutcome["divergences"] = [];

  const next = points.map((p) => {
    const ai = byKey.get(p.id);
    if (!ai) return p;

    const ruleText = formatWindows(p.time.windows);
    const aiText = formatWindows(ai.windows);
    const differs = ruleText !== aiText;

    // 태그·톤수는 확신도와 무관하게 합집합 (제약을 느슨하게 만들지 않는다)
    const tags = [...new Set([...p.tags, ...ai.tags])];
    const maxTonnage =
      p.maxTonnage === null
        ? ai.maxTonnage
        : ai.maxTonnage === null
          ? p.maxTonnage
          : Math.min(p.maxTonnage, ai.maxTonnage);

    let windows = p.time.windows;
    let applied = false;
    let note = p.time.note;

    if (ai.accepted && ai.confidence !== "low" && ai.windows.length > 0) {
      if (p.time.windows.length === 0) {
        windows = ai.windows;
        applied = true;
        note = `AI가 시간창을 회수: ${aiText} (${ai.reasoning})`;
      } else if (differs) {
        const ruleSpan = p.time.windows.reduce((s, w) => s + (w.end - w.start), 0);
        const aiSpan = ai.windows.reduce((s, w) => s + (w.end - w.start), 0);
        if (aiSpan < ruleSpan) {
          windows = ai.windows;
          applied = true;
          note = `AI가 더 엄격한 시간창을 제시해 채택: 규칙 ${ruleText} → AI ${aiText} (${ai.reasoning})`;
        }
      }
    }

    if (differs) {
      divergences.push({
        company: p.parsedName.company,
        rule: ruleText,
        ai: aiText,
        confidence: ai.confidence,
        reasoning: ai.reasoning,
        applied,
      });

      issues.push({
        level: applied ? "info" : "warning",
        code: "FR-18",
        message: applied
          ? "AI 해석을 채택했습니다 — 원문과 대조해 확인하십시오"
          : "AI 해석이 규칙 결과와 다릅니다 — 규칙 결과를 유지했습니다",
        subject: p.parsedName.company,
        detail: `규칙 ${ruleText} / AI ${aiText} (확신도 ${ai.confidence}) — ${ai.reasoning}`,
      });
    }

    return {
      ...p,
      tags,
      maxTonnage,
      time: { ...p.time, windows, note },
    };
  });

  return { points: next, issues, divergences };
}
