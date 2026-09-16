/**
 * TMAP 도착예정시각에 대기 시간을 반영한다 (FR-25 / R-14)
 *
 * TMAP `arriveTime`은 **주행 시간만** 계산한다. 시간창이 열리기 전에 도착하면
 * 기사는 기다렸다가 하차하고, 그만큼 이후 배송지 도착이 모두 밀린다.
 * 이 보정을 하지 않으면 "일찍 도착"이 시간창 위반으로 잘못 잡혀
 * 멀쩡한 배송지가 무더기로 기타로 빠진다.
 *
 * 위반은 **마감을 넘긴 경우에만** 성립한다.
 */

import { UNLOAD_MINUTES } from "@/lib/domain/constants";
import type { Minutes, TimeWindow } from "@/lib/domain/types";
import { fitIntoWindows } from "./feasibility";

export interface WaitingStop {
  id: string;
  windows: TimeWindow[];
}

export interface WaitingResult {
  /** 대기를 반영한 실제 하차 시각 */
  arriveAt: Record<string, Minutes>;
  /** 대기로 밀린 시간 (분) */
  waited: Record<string, Minutes>;
  /** 마감을 넘겨 실제로 위반인 배송지 */
  violations: string[];
  /** 마지막 하차 완료 시각 */
  lastDoneAt: Minutes | null;
}

/**
 * @param sequence  확정된 방문 순서
 * @param rawArrive TMAP(또는 Demo)이 계산한 주행 기준 도착 시각
 */
export function applyWaiting(
  sequence: WaitingStop[],
  rawArrive: Record<string, Minutes>
): WaitingResult {
  const arriveAt: Record<string, Minutes> = {};
  const waited: Record<string, Minutes> = {};
  const violations: string[] = [];

  /** 앞선 배송지의 대기로 누적된 지연 */
  let delay = 0;
  let lastDoneAt: Minutes | null = null;

  for (const stop of sequence) {
    const raw = rawArrive[stop.id];
    if (raw === undefined) continue;

    const shifted = raw + delay;
    const fitted = fitIntoWindows(stop.windows, shifted);

    if (fitted === null) {
      // 모든 시간창을 넘겼다 — 진짜 위반
      violations.push(stop.id);
      arriveAt[stop.id] = shifted;
      waited[stop.id] = 0;
      lastDoneAt = shifted + UNLOAD_MINUTES;
      continue;
    }

    const wait = fitted - shifted;
    delay += wait;
    arriveAt[stop.id] = fitted;
    waited[stop.id] = wait;
    lastDoneAt = fitted + UNLOAD_MINUTES;
  }

  return { arriveAt, waited, violations, lastDoneAt };
}
