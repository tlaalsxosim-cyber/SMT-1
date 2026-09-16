"use client";

/**
 * 배차 지도 (FR-28, FR-29 / §11 ①)
 *
 * TMAP Map JS(jsv2)는 브라우저에서 App Key를 실어 부른다. 운영 키(TMAP_APP_KEY)를
 * 그대로 노출하면 NFR-03 위반이므로, **도메인 제한을 건 별도 웹 키**
 * `NEXT_PUBLIC_TMAP_WEB_KEY`가 있을 때만 jsv2를 띄운다.
 * 키가 없거나 SDK 로딩에 실패하면 외부 호출이 전혀 없는 내장 SVG 지도로 되돌아간다 —
 * 좌표·마커·경로선·클릭 팝업·자동 범위 조절은 양쪽이 동일하게 동작한다.
 *
 * 좌표 순서 주의: 내부 데이터는 전부 [위도, 경도]로 통일한다 (TMAP 응답의 [경도, 위도]는
 * client.ts에서 이미 뒤집어 두었다).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  getTmap,
  useTmapSdk,
  TMAP_WEB_KEY,
  type TmapInfoWindow,
  type TmapMapInstance,
  type TmapMarker,
  type TmapPolyline,
} from "@/components/tmap-sdk";
import type { DispatchResponse } from "@/lib/api/contracts";
import { driverColor, hhmm, n } from "@/lib/format";

interface Props {
  result: DispatchResponse;
  /** 선택된 회전 id — 있으면 해당 회전만 강조 */
  focusTripId: string | null;
  onFocusTrip: (id: string | null) => void;
}

interface Marker {
  lat: number;
  lon: number;
  label: string;
  sub: string;
  color: string;
  tripId: string;
  seq: number;
}

export function MapView({ result, focusTripId, onFocusTrip }: Props) {
  const vehicleIds = useMemo(() => result.vehicles.map((v) => v.id), [result.vehicles]);

  const markers = useMemo<Marker[]>(() => {
    const out: Marker[] = [];
    for (const t of result.trips) {
      const color = driverColor(vehicleIds, t.vehicleId);
      for (const s of t.stops) {
        if (!s.geo) continue;
        out.push({
          lat: s.geo.lat,
          lon: s.geo.lon,
          label: s.company,
          sub: `${n(s.boxes)}박스 · ${hhmm(s.arriveAt)} · ${s.timeRaw || "시간 제약 없음"}`,
          color,
          tripId: t.id,
          seq: s.seq,
        });
      }
    }
    return out;
  }, [result.trips, vehicleIds]);

  const paths = useMemo(
    () =>
      result.trips
        .map((t) => ({
          id: t.id,
          color: driverColor(vehicleIds, t.vehicleId),
          points: result.routePaths[t.id] ?? [],
        }))
        .filter((p) => p.points.length >= 2),
    [result.trips, result.routePaths, vehicleIds]
  );

  const homes = useMemo(
    () =>
      result.vehicles
        .filter((v) => v.arrivalGeo)
        .map((v) => ({
          lat: v.arrivalGeo!.lat,
          lon: v.arrivalGeo!.lon,
          label: v.기사명,
          color: driverColor(vehicleIds, v.id),
        })),
    [result.vehicles, vehicleIds]
  );

  const sdk = useTmapSdk();
  const useTmapCanvas = TMAP_WEB_KEY !== "" && sdk.status !== "error";

  if (useTmapCanvas) {
    return (
      <TmapCanvas
        center={result.centerGeo}
        markers={markers}
        paths={paths}
        homes={homes}
        focusTripId={focusTripId}
        onFocusTrip={onFocusTrip}
        demoMode={result.demoMode}
        loading={sdk.status !== "ready"}
      />
    );
  }

  return (
    <SvgMap
      center={result.centerGeo}
      markers={markers}
      paths={paths}
      homes={homes}
      focusTripId={focusTripId}
      onFocusTrip={onFocusTrip}
      demoMode={result.demoMode}
      fallbackNote={sdk.error ?? undefined}
    />
  );
}

// ─────────────────────────────────────────────────────────────
// 내장 SVG 지도 — 외부 호출 없음
// ─────────────────────────────────────────────────────────────

interface SvgProps {
  center: { lat: number; lon: number };
  markers: Marker[];
  paths: { id: string; color: string; points: [number, number][] }[];
  homes: { lat: number; lon: number; label: string; color: string }[];
  focusTripId: string | null;
  onFocusTrip: (id: string | null) => void;
  demoMode: boolean;
  /** jsv2 로딩 실패 사유 — 있으면 배지로 알린다 */
  fallbackNote?: string;
}

const PADDING = 36;

function SvgMap({
  center,
  markers,
  paths,
  homes,
  focusTripId,
  onFocusTrip,
  demoMode,
  fallbackNote,
}: SvgProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });
  const [hover, setHover] = useState<Marker | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ w: Math.max(320, r.width), h: Math.max(360, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 모든 좌표가 한 화면에 들어오도록 자동 범위 조절 (FR-29)
  const bounds = useMemo(() => {
    const lats = [center.lat, ...markers.map((m) => m.lat), ...homes.map((h) => h.lat)];
    const lons = [center.lon, ...markers.map((m) => m.lon), ...homes.map((h) => h.lon)];
    for (const p of paths) {
      for (const [la, lo] of p.points) {
        lats.push(la);
        lons.push(lo);
      }
    }
    if (lats.length === 0) return { minLat: 36.5, maxLat: 37.8, minLon: 126.5, maxLon: 127.6 };

    const pad = 0.04;
    return {
      minLat: Math.min(...lats) - pad,
      maxLat: Math.max(...lats) + pad,
      minLon: Math.min(...lons) - pad,
      maxLon: Math.max(...lons) + pad,
    };
  }, [center, markers, homes, paths]);

  const project = useMemo(() => {
    const spanLat = Math.max(1e-6, bounds.maxLat - bounds.minLat);
    const spanLon = Math.max(1e-6, bounds.maxLon - bounds.minLon);
    const innerW = size.w - PADDING * 2;
    const innerH = size.h - PADDING * 2;
    // 위도 1도가 경도 1도보다 길다 — 종횡비를 맞춘다
    const scale = Math.min(innerW / spanLon, innerH / (spanLat * 1.28));
    const offsetX = (innerW - spanLon * scale) / 2;
    const offsetY = (innerH - spanLat * 1.28 * scale) / 2;

    return (lat: number, lon: number): [number, number] => [
      PADDING + offsetX + (lon - bounds.minLon) * scale,
      PADDING + offsetY + (bounds.maxLat - lat) * 1.28 * scale,
    ];
  }, [bounds, size]);

  const [cx, cy] = project(center.lat, center.lon);
  const dimmed = (tripId: string) => focusTripId !== null && focusTripId !== tripId;

  return (
    <div ref={wrapRef} className="relative h-[520px] w-full overflow-hidden rounded-lg border bg-card">
      <svg width={size.w} height={size.h} className="block" role="img" aria-label="배차 지도">
        <defs>
          <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path
              d="M 48 0 L 0 0 0 48"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.07"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width={size.w} height={size.h} fill="url(#grid)" className="text-foreground" />

        {/* 회전별 경로선 */}
        {paths.map((p) => (
          <polyline
            key={p.id}
            points={p.points.map(([la, lo]) => project(la, lo).join(",")).join(" ")}
            fill="none"
            stroke={p.color}
            strokeWidth={focusTripId === p.id ? 3.5 : 2}
            strokeOpacity={dimmed(p.id) ? 0.12 : 0.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={demoMode ? "6 4" : undefined}
          />
        ))}

        {/* 기사 도착지 */}
        {homes.map((h, i) => {
          const [x, y] = project(h.lat, h.lon);
          return (
            <g key={`home-${i}`} opacity={0.85}>
              <path
                d={`M ${x} ${y - 9} L ${x + 8} ${y} L ${x + 5} ${y} L ${x + 5} ${y + 8} L ${x - 5} ${y + 8} L ${x - 5} ${y} L ${x - 8} ${y} Z`}
                fill={h.color}
                fillOpacity={0.28}
                stroke={h.color}
                strokeWidth={1.4}
              />
            </g>
          );
        })}

        {/* 납품처 마커 */}
        {markers.map((m, i) => {
          const [x, y] = project(m.lat, m.lon);
          const faded = dimmed(m.tripId);
          return (
            <g
              key={`${m.tripId}-${i}`}
              opacity={faded ? 0.18 : 1}
              className="cursor-pointer"
              onMouseEnter={() => setHover(m)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onFocusTrip(focusTripId === m.tripId ? null : m.tripId)}
            >
              <circle cx={x} cy={y} r={11} fill={m.color} fillOpacity={0.18} />
              <circle cx={x} cy={y} r={7.5} fill={m.color} stroke="white" strokeWidth={1.6} />
              <text
                x={x}
                y={y + 3}
                textAnchor="middle"
                fontSize={8}
                fontWeight={700}
                fill="white"
                pointerEvents="none"
              >
                {m.seq}
              </text>
            </g>
          );
        })}

        {/* 평택센터 — 구분 마커 */}
        <g>
          <rect
            x={cx - 9}
            y={cy - 9}
            width={18}
            height={18}
            rx={3}
            fill="#0f172a"
            stroke="white"
            strokeWidth={2}
            transform={`rotate(45 ${cx} ${cy})`}
          />
          <text x={cx} y={cy - 16} textAnchor="middle" fontSize={11} fontWeight={700} className="fill-foreground">
            평택센터
          </text>
        </g>
      </svg>

      {hover && (
        <div
          className="pointer-events-none absolute left-3 top-3 max-w-xs rounded-md border bg-popover/95 px-3 py-2 shadow-lg backdrop-blur"
          role="tooltip"
        >
          <div className="text-sm font-semibold">{hover.label}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{hover.sub}</div>
        </div>
      )}

      <div className="absolute bottom-3 left-3 flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-[11px]">
          {demoMode ? "Demo Mode — 근사 좌표·점선 경로" : "TMAP 실도로 경로"}
        </Badge>
        {fallbackNote && (
          <Badge variant="outline" className="max-w-md border-amber-500/50 text-[11px] text-amber-600">
            지도 SDK 미사용 — {fallbackNote}
          </Badge>
        )}
        {focusTripId && (
          <button
            type="button"
            onClick={() => onFocusTrip(null)}
            className="rounded-md border bg-background/90 px-2 py-1 text-[11px] hover:bg-accent"
          >
            전체 보기
          </button>
        )}
      </div>

      <div className="absolute bottom-3 right-3 rounded-md border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground">
        ◆ 센터 · ● 납품처(방문순서) · ⌂ 기사 도착지
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TMAP jsv2 지도 — NEXT_PUBLIC_TMAP_WEB_KEY가 있을 때만 사용
// ─────────────────────────────────────────────────────────────

interface TmapCanvasProps extends SvgProps {
  loading: boolean;
}

/** 마커 아이콘을 data URI SVG로 만든다 — 외부 이미지 호스팅이 필요 없다 */
function markerIcon(color: string, seq: number, dimmed = false): string {
  const opacity = dimmed ? 0.25 : 1;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26" opacity="${opacity}">
    <circle cx="13" cy="13" r="12" fill="${color}" fill-opacity="0.22"/>
    <circle cx="13" cy="13" r="8.5" fill="${color}" stroke="#fff" stroke-width="2"/>
    <text x="13" y="16.5" text-anchor="middle" font-size="9" font-weight="700" fill="#fff"
      font-family="sans-serif">${seq}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function centerIcon(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">
    <rect x="5" y="5" width="16" height="16" rx="3" fill="#0f172a" stroke="#fff" stroke-width="2"
      transform="rotate(45 13 13)"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function homeIcon(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <path d="M11 3 L20 11 L17 11 L17 19 L5 19 L5 11 L2 11 Z" fill="${color}" fill-opacity="0.3"
      stroke="${color}" stroke-width="1.6"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}

function TmapCanvas({
  center,
  markers,
  paths,
  homes,
  focusTripId,
  onFocusTrip,
  demoMode,
  loading,
}: TmapCanvasProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<TmapMapInstance | null>(null);
  const overlaysRef = useRef<{ markers: TmapMarker[]; lines: TmapPolyline[] }>({
    markers: [],
    lines: [],
  });
  const infoRef = useRef<TmapInfoWindow | null>(null);

  const clearOverlays = useCallback(() => {
    for (const m of overlaysRef.current.markers) m.setMap(null);
    for (const l of overlaysRef.current.lines) l.setMap(null);
    overlaysRef.current = { markers: [], lines: [] };
    infoRef.current?.setMap(null);
    infoRef.current = null;
  }, []);

  /**
   * 지도 인스턴스 생성. 상태를 두지 않고 ref만 쓴다 —
   * 아래 그리기 effect가 같은 커밋에서 **이 effect 다음에** 실행되므로
   * mapRef가 이미 채워져 있다 (effect는 선언 순서대로 실행된다).
   */
  useEffect(() => {
    if (loading || mapRef.current || !divRef.current) return;
    // getTmap()은 필요한 생성자가 전부 올라왔을 때만 네임스페이스를 돌려준다
    const T = getTmap();
    if (!T) return;

    try {
      mapRef.current = new T.Map(divRef.current, {
        center: new T.LatLng(center.lat, center.lon),
        width: "100%",
        height: "520px",
        zoom: 10,
        zoomControl: true,
        scrollwheel: true,
        // 기본값이 http라 HTTPS 배포에서 타일이 Mixed Content로 전부 차단된다
        httpsMode: true,
      });
    } catch (e) {
      // 지도 생성에 실패해도 배차 결과는 그대로 보여야 한다
      console.error("TMAP 지도 생성 실패", e);
      mapRef.current = null;
      return;
    }

    return () => {
      clearOverlays();
      mapRef.current?.destroy?.();
      mapRef.current = null;
    };
    // center는 최초 1회만 쓴다 — 이후 범위는 fitBounds가 잡는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, clearOverlays]);

  // 마커·경로선을 다시 그린다
  useEffect(() => {
    const T = getTmap();
    const map = mapRef.current;
    if (loading || !T || !map) return;

    clearOverlays();

    try {
      drawOverlays(T, map);
    } catch (e) {
      console.error("TMAP 오버레이 그리기 실패", e);
    }

    function drawOverlays(T: NonNullable<ReturnType<typeof getTmap>>, map: TmapMapInstance) {
    const bounds = new T.LatLngBounds();
    const extend = (lat: number, lon: number) => bounds.extend(new T.LatLng(lat, lon));

    // 회전별 경로선
    for (const p of paths) {
      const dimmed = focusTripId !== null && focusTripId !== p.id;
      const line = new T.Polyline({
        path: p.points.map(([la, lo]) => new T.LatLng(la, lo)),
        strokeColor: p.color,
        strokeWeight: focusTripId === p.id ? 6 : 4,
        strokeOpacity: dimmed ? 0.15 : 0.75,
        strokeStyle: demoMode ? "dash" : "solid",
        map,
      });
      overlaysRef.current.lines.push(line);
      for (const [la, lo] of p.points) extend(la, lo);
    }

    // 납품처 마커. 다른 회전이 선택돼 있으면 흐리게 그린다.
    for (const m of markers) {
      const dimmed = focusTripId !== null && focusTripId !== m.tripId;
      const marker = new T.Marker({
        position: new T.LatLng(m.lat, m.lon),
        icon: markerIcon(m.color, m.seq, dimmed),
        iconSize: new T.Size(26, 26),
        title: m.label,
        map,
      });
      marker.addListener("click", () => {
        infoRef.current?.setMap(null);
        infoRef.current = new T.InfoWindow({
          position: new T.LatLng(m.lat, m.lon),
          content: `<div style="padding:8px 10px;font-size:12px;line-height:1.5">
              <b>${escapeHtml(m.label)}</b><br/>${escapeHtml(m.sub)}
            </div>`,
          type: 2,
          border: "1px solid #cbd5e1",
          map,
        });
        onFocusTrip(focusTripId === m.tripId ? null : m.tripId);
      });
      overlaysRef.current.markers.push(marker);
      extend(m.lat, m.lon);
    }

    // 기사 도착지
    for (const h of homes) {
      overlaysRef.current.markers.push(
        new T.Marker({
          position: new T.LatLng(h.lat, h.lon),
          icon: homeIcon(h.color),
          iconSize: new T.Size(22, 22),
          title: `${h.label} 도착지`,
          map,
        })
      );
      extend(h.lat, h.lon);
    }

    // 평택센터
    overlaysRef.current.markers.push(
      new T.Marker({
        position: new T.LatLng(center.lat, center.lon),
        icon: centerIcon(),
        iconSize: new T.Size(26, 26),
        title: "평택센터",
        map,
      })
    );
    extend(center.lat, center.lon);

    // 모든 좌표가 한 화면에 들어오게 (FR-29)
    try {
      map.fitBounds(bounds);
    } catch {
      map.setCenter(new T.LatLng(center.lat, center.lon));
    }
    }
  }, [loading, markers, paths, homes, center, focusTripId, onFocusTrip, demoMode, clearOverlays]);

  return (
    <div className="relative h-[520px] w-full overflow-hidden rounded-lg border bg-card">
      <div ref={divRef} className="h-full w-full" aria-label="배차 지도 (TMAP)" />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/80 text-sm text-muted-foreground">
          TMAP 지도 SDK를 불러오는 중…
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-[11px]">
          TMAP 지도 · {demoMode ? "Demo Mode 좌표(점선)" : "실도로 경로"}
        </Badge>
      </div>

      {focusTripId && (
        <button
          type="button"
          onClick={() => onFocusTrip(null)}
          className="absolute bottom-3 right-3 z-10 rounded-md border bg-background/90 px-2 py-1 text-[11px] hover:bg-accent"
        >
          전체 보기
        </button>
      )}
    </div>
  );
}
