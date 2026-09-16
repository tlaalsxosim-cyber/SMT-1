"use client";

/**
 * 클라이언트 상태 (NFR-01 무저장)
 *
 * localStorage·sessionStorage·IndexedDB를 일절 쓰지 않는다.
 * 새로고침하면 전부 사라지는 것이 **의도된 동작**이며, 다운로드 전 이탈 시
 * 경고를 띄워(FR-51) 담당자가 결과를 잃지 않게 한다.
 */

import { create } from "zustand";

import type {
  DispatchRequestOptions,
  DispatchResponse,
  ParseResponse,
  ServerStatus,
} from "@/lib/api/contracts";
import { DEFAULT_DEPART_MINUTES } from "@/lib/domain/constants";

export type TabKey = "board" | "upload" | "download" | "settings";

export interface Settings {
  demo: boolean;
  useAi: boolean;
  departAt: number;
  earlyMode: DispatchRequestOptions["earlyMode"];
  centerAddress: string;
  drawRoutes: boolean;
  includeCoordinates: boolean;
}

interface AppState {
  tab: TabKey;
  setTab: (t: TabKey) => void;

  shipmentFile: File | null;
  fleetFile: File | null;
  setShipmentFile: (f: File | null) => void;
  setFleetFile: (f: File | null) => void;

  preview: ParseResponse | null;
  parsing: boolean;
  parseError: string | null;

  result: DispatchResponse | null;
  dispatching: boolean;
  dispatchError: string | null;
  /** 결과를 한 번이라도 내려받았는지 — 이탈 경고 해제 기준 (FR-51) */
  downloaded: boolean;

  status: ServerStatus | null;

  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;

  parseFiles: () => Promise<void>;
  runDispatch: () => Promise<void>;
  downloadResult: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  reset: () => void;
}

const DEFAULT_SETTINGS: Settings = {
  demo: true,
  useAi: false,
  departAt: DEFAULT_DEPART_MINUTES,
  earlyMode: "endBy10",
  centerAddress: "",
  drawRoutes: true,
  includeCoordinates: false,
};

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string; hint?: string; detail?: string };
    return [j.error, j.detail, j.hint].filter(Boolean).join("\n");
  } catch {
    return `요청 실패 (HTTP ${res.status})`;
  }
}

export const useApp = create<AppState>((set, get) => ({
  tab: "upload",
  setTab: (tab) => set({ tab }),

  shipmentFile: null,
  fleetFile: null,
  setShipmentFile: (shipmentFile) =>
    set({ shipmentFile, preview: null, result: null, parseError: null }),
  setFleetFile: (fleetFile) =>
    set({ fleetFile, preview: null, result: null, parseError: null }),

  preview: null,
  parsing: false,
  parseError: null,

  result: null,
  dispatching: false,
  dispatchError: null,
  downloaded: false,

  status: null,

  settings: DEFAULT_SETTINGS,
  updateSettings: (patch) => set({ settings: { ...get().settings, ...patch } }),

  async parseFiles() {
    const { shipmentFile, fleetFile } = get();
    if (!shipmentFile || !fleetFile) {
      set({ parseError: "출고등록현황과 차량 톤수 파일을 모두 올려야 합니다" });
      return;
    }

    set({ parsing: true, parseError: null, preview: null, result: null });

    const form = new FormData();
    form.append("shipment", shipmentFile);
    form.append("fleet", fleetFile);

    try {
      const res = await fetch("/api/parse", { method: "POST", body: form });
      if (!res.ok) {
        set({ parseError: await readError(res), parsing: false });
        return;
      }
      const preview = (await res.json()) as ParseResponse;
      set({ preview, parsing: false, status: preview.serverStatus });
    } catch (e) {
      set({
        parseError: e instanceof Error ? e.message : "파싱 요청에 실패했습니다",
        parsing: false,
      });
    }
  },

  async runDispatch() {
    const { shipmentFile, fleetFile, settings, dispatching } = get();
    if (dispatching) return; // FR-33 클라이언트 측 1차 잠금
    if (!shipmentFile || !fleetFile) {
      set({ dispatchError: "파일 2개를 먼저 업로드하십시오" });
      return;
    }

    set({ dispatching: true, dispatchError: null, downloaded: false });

    const form = new FormData();
    form.append("shipment", shipmentFile);
    form.append("fleet", fleetFile);
    form.append(
      "options",
      JSON.stringify({
        demo: settings.demo,
        useAi: settings.useAi,
        departAt: settings.departAt,
        earlyMode: settings.earlyMode,
        centerAddress: settings.centerAddress || undefined,
        drawRoutes: settings.drawRoutes,
      } satisfies DispatchRequestOptions)
    );

    try {
      const res = await fetch("/api/dispatch", { method: "POST", body: form });
      if (!res.ok) {
        set({ dispatchError: await readError(res), dispatching: false });
        return;
      }
      const result = (await res.json()) as DispatchResponse;
      set({
        result,
        dispatching: false,
        status: result.serverStatus,
        tab: "board",
      });
    } catch (e) {
      set({
        dispatchError: e instanceof Error ? e.message : "배차 실행에 실패했습니다",
        dispatching: false,
      });
    }
  },

  async downloadResult() {
    const { result, settings } = get();
    if (!result) return;

    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ result, includeCoordinates: settings.includeCoordinates }),
    });

    if (!res.ok) {
      set({ dispatchError: await readError(res) });
      return;
    }

    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const match = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    const filename = match
      ? decodeURIComponent(match[1])
      : `배차결과_${result.date}.xlsx`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    set({ downloaded: true });
  },

  async refreshStatus() {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      if (res.ok) set({ status: (await res.json()) as ServerStatus });
    } catch {
      // 상태 조회 실패는 배차를 막지 않는다
    }
  },

  reset: () =>
    set({
      shipmentFile: null,
      fleetFile: null,
      preview: null,
      result: null,
      parseError: null,
      dispatchError: null,
      downloaded: false,
      tab: "upload",
    }),
}));

/** 결과가 있는데 아직 내려받지 않았으면 true — 이탈 경고 대상 (FR-51) */
export function useUnsavedResult(): boolean {
  return useApp((s) => s.result !== null && !s.downloaded);
}
