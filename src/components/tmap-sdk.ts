"use client";

/**
 * TMAP Map JS(jsv2) SDK 로더 (FR-28)
 *
 * 지도 SDK는 브라우저에서 App Key를 쿼리스트링에 실어 부른다. 서버 프록시로 감쌀 수 없으므로
 * **운영 키(TMAP_APP_KEY)와 분리된 별도 웹 키**를 쓰고, SK open API 콘솔에서 도메인 제한을 건다.
 * 키가 없거나 로딩에 실패하면 지도는 내장 SVG로 되돌아간다 — 배차 자체는 영향받지 않는다.
 */

import { useSyncExternalStore } from "react";

export const TMAP_WEB_KEY = process.env.NEXT_PUBLIC_TMAP_WEB_KEY ?? "";

export type SdkStatus = "disabled" | "loading" | "ready" | "error";

const SCRIPT_ID = "tmap-jsv2";
/** 부트스트랩이 끌어오는 SDK 본체 — 재마운트 시 중복 적재를 막는 표식 */
const CORE_SCRIPT_ID = "tmap-jsv2-core";

// ─────────────────────────────────────────────────────────────
// jsv2 최소 타입 — SDK가 전역 `Tmapv2`로 올라온다
// ─────────────────────────────────────────────────────────────

export interface TmapLatLng {
  _lat: number;
  _lng: number;
}

export interface TmapMarker {
  setMap(map: unknown | null): void;
  addListener(event: string, handler: () => void): void;
}

export interface TmapPolyline {
  setMap(map: unknown | null): void;
}

export interface TmapInfoWindow {
  setMap(map: unknown | null): void;
  setVisible(v: boolean): void;
}

export interface TmapMapInstance {
  fitBounds(bounds: unknown): void;
  setCenter(latlng: TmapLatLng): void;
  setZoom(z: number): void;
  destroy?(): void;
  addListener(event: string, handler: () => void): void;
}

export interface TmapBounds {
  extend(latlng: TmapLatLng): void;
}

export interface Tmapv2Namespace {
  Map: new (
    el: string | HTMLElement,
    opts: Record<string, unknown>
  ) => TmapMapInstance;
  LatLng: new (lat: number, lng: number) => TmapLatLng;
  LatLngBounds: new () => TmapBounds;
  Marker: new (opts: Record<string, unknown>) => TmapMarker;
  Polyline: new (opts: Record<string, unknown>) => TmapPolyline;
  InfoWindow: new (opts: Record<string, unknown>) => TmapInfoWindow;
  Size: new (w: number, h: number) => unknown;
  Point: new (x: number, y: number) => unknown;
}

declare global {
  interface Window {
    Tmapv2?: Tmapv2Namespace;
  }
}

/**
 * 실제로 쓰는 생성자 목록.
 * jsv2는 스크립트 `onload` 이후에도 네임스페이스를 **비동기로 채운다**.
 * `window.Tmapv2`가 있다는 것만으로 준비됐다고 보면
 * `T.LatLng is not a constructor` 런타임 오류가 난다.
 */
const REQUIRED_MEMBERS = [
  "Map",
  "LatLng",
  "LatLngBounds",
  "Marker",
  "Polyline",
  "InfoWindow",
  "Size",
] as const;

/** 필요한 생성자가 전부 올라왔는지 확인한다 */
export function isTmapReady(ns: unknown): ns is Tmapv2Namespace {
  if (!ns || typeof ns !== "object") return false;
  const o = ns as Record<string, unknown>;
  return REQUIRED_MEMBERS.every((k) => typeof o[k] === "function");
}

/** 쓸 준비가 된 네임스페이스만 돌려준다. 아직 채워지는 중이면 null. */
export function getTmap(): Tmapv2Namespace | null {
  if (typeof window === "undefined") return null;
  return isTmapReady(window.Tmapv2) ? window.Tmapv2 : null;
}

/** 아직 준비되지 않은 멤버 이름 — 오류 메시지에 쓴다 */
function missingMembers(): string[] {
  const o = (typeof window === "undefined" ? undefined : window.Tmapv2) as
    | Record<string, unknown>
    | undefined;
  if (!o) return [...REQUIRED_MEMBERS];
  return REQUIRED_MEMBERS.filter((k) => typeof o[k] !== "function");
}

// ─────────────────────────────────────────────────────────────
// 로더
//
// `apis.openapi.sk.com/tmap/jsv2`가 돌려주는 건 1KB짜리 **부트스트랩**이고,
// SDK 본체(`tmapjs2.min.js`)는 그 안에서 `document.write`로 끼워 넣는다.
// 문서 파싱이 끝난 뒤 동적으로 붙인 스크립트의 `document.write`는 브라우저가
// **무시한다**(HTML 명세). 그래서 `window.Tmapv2`에는 `_getScriptLocation`만 올라오고
// 생성자는 끝내 생기지 않아 "초기화가 끝나지 않았습니다 — 준비되지 않은 항목:
// Map, LatLng, …"로 15초 만에 실패했다. 지도가 늘 SVG 폴백으로 떨어진 원인이다.
// → 부트스트랩이 쓰려던 마크업을 가로채 우리가 직접 <script>로 붙인다.
//
// 부트스트랩 <script> 태그는 **DOM에 그대로 남겨 둬야 한다.** SDK 본체가
// 문서의 모든 `<script src>`를 훑어 `appKey=`를 뽑아 쓰기 때문이다
// (`getParameterFromURL("appKey")`). 태그를 지우면 타일 요청이 인증 없이 나간다.
// ─────────────────────────────────────────────────────────────

/** 부트스트랩을 못 가로챘을 때 쓰는 본체 파일명 */
const CORE_FILE = "tmapjs2.min.js";

/** 부트스트랩이 `document.write`로 넘긴 마크업에서 `<script src>`만 뽑아낸다 */
export function scriptSrcsFromMarkup(html: string): string[] {
  const re = /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const out: string[] = [];
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const src = m[1] ?? m[2] ?? m[3] ?? "";
    if (src) out.push(src);
  }
  return out;
}

/**
 * `document.write`/`writeln`을 잠깐 가로챈다. 부트스트랩은 스크립트 평가 중
 * **동기로** 호출하므로, 붙이기 직전에 걸고 onload에서 풀면 그 사이만 가린다.
 */
function captureDocumentWrite(sink: string[]): () => void {
  const write = document.write;
  const writeln = document.writeln;
  const capture = (...html: unknown[]): void => {
    sink.push(html.join(""));
  };
  document.write = capture as typeof document.write;
  document.writeln = capture as typeof document.writeln;
  return () => {
    document.write = write;
    document.writeln = writeln;
  };
}

function appendScript(src: string, id: string | undefined, onErrorMessage: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    if (id) el.id = id;
    // 여러 개면 부트스트랩이 적어 준 순서대로 실행돼야 한다
    el.async = false;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(onErrorMessage));
    el.src = src;
    document.head.appendChild(el);
  });
}

/** 부트스트랩이 알려준 배포 위치에서 본체 주소를 만든다 (마크업을 못 가로챘을 때) */
function coreSrcFromNamespace(): string | null {
  const ns = (typeof window === "undefined" ? undefined : window.Tmapv2) as
    | { _getScriptLocation?: () => string }
    | undefined;
  const base = typeof ns?._getScriptLocation === "function" ? ns._getScriptLocation() : "";
  return base ? `${base}${CORE_FILE}` : null;
}

/**
 * 본체가 올라온 뒤에도 네임스페이스가 곧바로 다 차 있다는 보장은 없다.
 * **필요한 생성자가 전부 함수일 때까지** 폴링한다 (`isTmapReady`).
 */
const POLL_MS = 100;
const POLL_LIMIT = 150; // 최대 15초

function waitForNamespace(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      if (getTmap()) {
        resolve();
        return;
      }
      if (++tries > POLL_LIMIT) {
        reject(
          new Error(
            `TMAP SDK 초기화가 끝나지 않았습니다 (대기 ${Math.round(
              (POLL_LIMIT * POLL_MS) / 1000
            )}초) — 준비되지 않은 항목: ${missingMembers().join(", ")}`
          )
        );
        return;
      }
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

let loadPromise: Promise<void> | null = null;

async function loadSdk(key: string): Promise<void> {
  loadPromise ??= (async () => {
    if (getTmap()) return;

    const written: string[] = [];

    // HMR·재마운트로 부트스트랩이 이미 있으면 다시 실행시킬 수 없다 —
    // 그때는 아래에서 네임스페이스가 알려준 위치로 본체를 직접 받는다.
    if (!document.getElementById(SCRIPT_ID)) {
      const restore = captureDocumentWrite(written);
      try {
        await appendScript(
          `https://apis.openapi.sk.com/tmap/jsv2?version=1&appKey=${encodeURIComponent(key)}`,
          SCRIPT_ID,
          "TMAP 지도 SDK를 불러오지 못했습니다 — 웹 키가 유효한지, 도메인 제한에 현재 주소가 포함됐는지 확인하십시오"
        );
      } finally {
        restore();
      }
    }

    if (!getTmap() && !document.getElementById(CORE_SCRIPT_ID)) {
      const fromMarkup = written.flatMap(scriptSrcsFromMarkup);
      const fallback = coreSrcFromNamespace();
      const srcs = fromMarkup.length > 0 ? fromMarkup : fallback ? [fallback] : [];

      if (srcs.length === 0) {
        throw new Error(
          "TMAP 지도 SDK 본체 주소를 찾지 못했습니다 — 부트스트랩 응답이 예상과 다릅니다"
        );
      }

      // 첫 번째에만 id를 달아 재마운트 시 중복 적재를 막는다
      for (const [i, src] of srcs.entries()) {
        await appendScript(
          src,
          i === 0 ? CORE_SCRIPT_ID : undefined,
          `TMAP 지도 SDK 본체를 불러오지 못했습니다 — ${src}`
        );
      }
    }

    await waitForNamespace();
  })();

  return loadPromise;
}

export interface SdkState {
  status: SdkStatus;
  error: string | null;
}

/**
 * SDK 로딩 상태는 React 바깥(전역 스크립트)에 있으므로 모듈 스토어에 두고
 * `useSyncExternalStore`로 읽는다. effect 안에서 setState를 부르지 않아도 되고,
 * 여러 지도 인스턴스가 상태를 공유한다.
 */
const DISABLED: SdkState = { status: "disabled", error: null };
const LOADING: SdkState = { status: "loading", error: null };
const READY: SdkState = { status: "ready", error: null };

let state: SdkState = TMAP_WEB_KEY ? LOADING : DISABLED;
const listeners = new Set<() => void>();

function publish(next: SdkState): void {
  state = next;
  for (const l of listeners) l();
}

let started = false;

function ensureLoad(): void {
  if (started || !TMAP_WEB_KEY) return;
  started = true;

  if (getTmap()) {
    publish(READY);
    return;
  }

  loadSdk(TMAP_WEB_KEY)
    .then(() => publish(READY))
    .catch((e: unknown) => {
      // 다음 시도를 위해 캐시를 비운다
      loadPromise = null;
      started = false;
      publish({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureLoad();
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): SdkState => state;
/** 서버 렌더에서는 항상 같은 객체를 돌려줘야 무한 루프가 나지 않는다 */
const getServerSnapshot = (): SdkState => (TMAP_WEB_KEY ? LOADING : DISABLED);

/** 웹 키가 있으면 jsv2를 한 번만 로드한다. 키가 없으면 곧바로 disabled. */
export function useTmapSdk(): SdkState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
