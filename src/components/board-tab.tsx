"use client";

/**
 * ① 배차 보드 (§11 ① / FR-28, FR-29, FR-42, FR-43, FR-50)
 *
 * 지도 · 기사별 배차 티켓 · 기타(미배차) 권역별 패널 · 주소 확인 필요 · AI 브리핑.
 */

import { useMemo, useState } from "react";
import type { DragEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Download,
  GripVertical,
  Home,
  Map as MapIcon,
  MapPin,
  Package,
  Sparkles,
  Truck,
} from "lucide-react";

import { MapView } from "@/components/map-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DispatchResponse } from "@/lib/api/contracts";
import type { Trip, UnassignedItem } from "@/lib/domain/types";
import { driverColor, formatDate, hhmm, km, loadRateTone, n, pct } from "@/lib/format";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

interface DragPayload {
  pointId: string;
  /** "unassigned"면 기타(미배차) 패널에서 끌어온 것 */
  from: string;
}

const DRAG_MIME = "application/json";

function setDragPayload(e: DragEvent, payload: DragPayload) {
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "move";
}

function readDragPayload(e: DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData(DRAG_MIME);
    return raw ? (JSON.parse(raw) as DragPayload) : null;
  } catch {
    return null;
  }
}

export function BoardTab() {
  const { result, downloadResult, downloaded, moveToTrip, moveToUnassigned } = useApp();
  const [focusTripId, setFocusTripId] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(true);

  if (!result) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
          <Truck className="size-10 text-muted-foreground" />
          <div className="text-lg font-medium">아직 배차 결과가 없습니다</div>
          <p className="max-w-md text-sm text-muted-foreground">
            데이터 업로드 탭에서 출고등록현황과 차량_톤수 파일을 올린 뒤 배차를 실행하십시오.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <SummaryBar result={result} onDownload={() => void downloadResult()} downloaded={downloaded} />

      {result.violations.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>제약 위반 {result.violations.length}건</AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-0.5 text-sm">
              {result.violations.map((v, i) => (
                <li key={i}>
                  [{v.code}] {v.subject} — {v.message}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-4">
          <Card>
            <CardHeader
              className="flex flex-row items-center justify-between gap-2 cursor-pointer pb-3"
              onClick={() => setMapOpen((v) => !v)}
            >
              <CardTitle className="flex items-center gap-2 text-base">
                <MapIcon className="size-4" /> 배차 지도
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setMapOpen((v) => !v);
                }}
              >
                {mapOpen ? (
                  <>
                    <ChevronUp /> 접기
                  </>
                ) : (
                  <>
                    <ChevronDown /> 펼치기
                  </>
                )}
              </Button>
            </CardHeader>
            {/* 접었을 때도 지도(특히 TMAP jsv2)는 마운트 상태를 유지한다 — CSS로만 숨겨야
                펼칠 때마다 지도를 다시 만들며 타일을 재호출하지 않는다 */}
            <CardContent className={cn(!mapOpen && "hidden")}>
              <MapView result={result} focusTripId={focusTripId} onFocusTrip={setFocusTripId} />
              <MapLegend
                trips={result.trips}
                vehicleIds={result.vehicles.map((v) => v.id)}
                focusTripId={focusTripId}
                onFocusTrip={setFocusTripId}
              />
            </CardContent>
          </Card>

          {result.briefing && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="size-4 text-violet-500" /> AI 브리핑
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{result.briefing}</p>
              </CardContent>
            </Card>
          )}

          <Tabs defaultValue="unassigned">
            <TabsList>
              <TabsTrigger value="unassigned">
                기타(미배차)
                <Badge variant="secondary" className="ml-1.5">
                  {result.unassigned.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="address">
                주소 확인 필요
                <Badge
                  variant={result.addressIssues.length ? "destructive" : "secondary"}
                  className="ml-1.5"
                >
                  {result.addressIssues.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="log">
                실행 로그
                <Badge variant="secondary" className="ml-1.5">
                  {result.issues.length}
                </Badge>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="unassigned">
              <UnassignedPanel
                items={result.unassigned}
                totalBoxes={result.totalBoxes}
                onDropUnassigned={(payload) => {
                  if (payload.from !== "unassigned") moveToUnassigned(payload.pointId, payload.from);
                }}
              />
            </TabsContent>

            <TabsContent value="address">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">주소 확인 필요</CardTitle>
                  <CardDescription>
                    좌표 확정은 지오코딩 재호출 성공으로만 이루어집니다. AI 제안은 참고용이며,
                    원본 파일의 주소를 고쳐 다시 업로드해야 합니다 (FR-15).
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {result.addressIssues.length === 0 && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 className="size-4 text-emerald-600" />
                      모든 주소가 좌표로 변환되었습니다.
                    </div>
                  )}
                  {result.addressIssues.map((a) => (
                    <div key={a.pointId} className="rounded-md border p-3 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{a.company}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {a.failureType}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">원문 · {a.rawAddress}</div>
                      <div className="text-xs text-muted-foreground">
                        조회 · {a.queriedAddress}
                      </div>
                      {a.suggestion && (
                        <div className="mt-1 text-xs text-sky-700 dark:text-sky-400">
                          AI 제안 · {a.suggestion}
                        </div>
                      )}
                      <div className="mt-1 text-xs text-muted-foreground">{a.note}</div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="log">
              <Card>
                <CardContent className="max-h-[420px] space-y-1.5 overflow-auto pt-6">
                  {result.issues.map((i, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        "rounded-md border px-3 py-2 text-sm",
                        i.level === "error" && "border-destructive/40 bg-destructive/5",
                        i.level === "warning" && "border-amber-500/40 bg-amber-500/5"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          {i.code}
                        </Badge>
                        {i.subject && <span className="text-xs font-medium">{i.subject}</span>}
                      </div>
                      <div className="mt-0.5">{i.message}</div>
                      {i.detail && (
                        <div className="mt-0.5 text-xs text-muted-foreground">{i.detail}</div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        {/* 기사별 배차 티켓 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-muted-foreground">
              기사별 배차 티켓 ({result.usedTrips}회전)
            </h3>
            {focusTripId && (
              <Button variant="ghost" size="sm" onClick={() => setFocusTripId(null)}>
                강조 해제
              </Button>
            )}
          </div>

          <div className="space-y-3 xl:max-h-[calc(100vh-14rem)] xl:overflow-auto xl:pr-1">
            {[...result.trips]
              .sort((a, b) => a.기사명.localeCompare(b.기사명, "ko") || a.tripNo - b.tripNo)
              .map((trip) => (
                <TripTicket
                  key={trip.id}
                  trip={trip}
                  color={driverColor(
                    result.vehicles.map((v) => v.id),
                    trip.vehicleId
                  )}
                  capacity={result.vehicles.find((v) => v.id === trip.vehicleId)}
                  active={focusTripId === trip.id}
                  onToggle={() => setFocusTripId(focusTripId === trip.id ? null : trip.id)}
                  onDropStop={(payload) => {
                    if (payload.from === trip.id) return;
                    moveToTrip(payload.pointId, payload.from === "unassigned" ? null : payload.from, trip.id);
                  }}
                />
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function SummaryBar({
  result,
  onDownload,
  downloaded,
}: {
  result: DispatchResponse;
  onDownload: () => void;
  downloaded: boolean;
}) {
  const totalDrive = result.trips.reduce((s, t) => s + t.driveKm, 0);
  const totalHome = result.trips.reduce((s, t) => s + t.homeKm, 0);
  const rates = result.trips.filter((t) => t.stops.length).map((t) => t.loadRate);
  const avgRate = rates.length ? rates.reduce((s, r) => s + r, 0) / rates.length : 0;
  const timeWarnings = result.trips.flatMap((t) => t.stops).filter((s) => s.timeOk === false).length;

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <Stat label="출고일자" value={formatDate(result.date)} />
            <Stat
              label="배차"
              value={`${n(result.assignedBoxes)} 박스`}
              sub={pct(result.assignedBoxes / Math.max(1, result.totalBoxes), 1)}
              tone="text-emerald-600 dark:text-emerald-400"
            />
            <Stat
              label="기타"
              value={`${n(result.unassignedBoxes)} 박스`}
              sub={`${result.unassigned.length}건`}
              tone="text-amber-600 dark:text-amber-400"
            />
            <Stat
              label="사용 회전"
              value={`${result.usedTrips} / ${result.sourceSummary.totalTrips}`}
            />
            <Stat label="평균 적재율" value={pct(avgRate)} tone={loadRateTone(avgRate)} />
            <Stat label="주행 / 귀가" value={`${km(totalDrive)} / ${km(totalHome)}`} />
            <Stat
              label="제약 위반"
              value={`${result.violations.length}건`}
              tone={result.violations.length ? "text-destructive" : "text-emerald-600"}
            />
            <Stat
              label="시간 경고"
              value={`${timeWarnings}건`}
              tone={timeWarnings ? "text-destructive" : "text-emerald-600"}
            />
          </div>

          <div className="flex flex-col items-end gap-2">
            <Button onClick={onDownload} size="lg">
              <Download /> 결과 엑셀 다운로드
            </Button>
            <div className="flex items-center gap-2 text-xs">
              {result.demoMode && <Badge variant="secondary">Demo Mode</Badge>}
              {result.aiEnabled && (
                <Badge variant="secondary" className="gap-1">
                  <Sparkles className="size-3" /> AI 구조화
                </Badge>
              )}
              <span className="text-muted-foreground">
                {(result.elapsedMs / 1000).toFixed(1)}초 소요
              </span>
            </div>
            {!downloaded && (
              <p className="max-w-xs text-right text-[11px] text-amber-600 dark:text-amber-400">
                다운로드 전에 페이지를 벗어나면 결과가 사라집니다 (무저장 구조)
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("text-lg font-semibold tabular-nums", tone)}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

/**
 * 지도 색상 범례 — 어느 선이 어느 기사인지 색만으로는 구분이 안 된다는 피드백(2026-09-21)에
 * 대응한다. 칩을 클릭하면 지도의 focusTripId와 똑같이 그 회전만 강조하고 나머지는 흐려지며,
 * ‹ › 로 한 회전씩 순서대로 넘겨 볼 수 있다.
 */
function MapLegend({
  trips,
  vehicleIds,
  focusTripId,
  onFocusTrip,
}: {
  trips: Trip[];
  vehicleIds: string[];
  focusTripId: string | null;
  onFocusTrip: (id: string | null) => void;
}) {
  const ordered = useMemo(
    () => [...trips].sort((a, b) => a.기사명.localeCompare(b.기사명, "ko") || a.tripNo - b.tripNo),
    [trips]
  );

  if (ordered.length === 0) return null;

  const step = (dir: 1 | -1) => {
    const idx = ordered.findIndex((t) => t.id === focusTripId);
    const next =
      idx === -1 ? (dir === 1 ? 0 : ordered.length - 1) : (idx + dir + ordered.length) % ordered.length;
    onFocusTrip(ordered[next].id);
  };

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          선 색 = 기사 — 클릭하거나 ‹ › 로 하나씩 확인하십시오
        </span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="size-6" onClick={() => step(-1)}>
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="size-6" onClick={() => step(1)}>
            <ChevronRight className="size-3.5" />
          </Button>
          {focusTripId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => onFocusTrip(null)}
            >
              전체 보기
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ordered.map((t) => {
          const color = driverColor(vehicleIds, t.vehicleId);
          const active = focusTripId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onFocusTrip(active ? null : t.id)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] transition-colors",
                active ? "border-transparent" : "hover:bg-accent"
              )}
              style={active ? { background: color, color: "white" } : undefined}
            >
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: active ? "white" : color }}
              />
              {t.기사명} · {t.tripNo}회전
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function TripTicket({
  trip,
  color,
  capacity,
  active,
  onToggle,
  onDropStop,
}: {
  trip: Trip;
  color: string;
  capacity?: { 최소수량: number; 최대수량: number; 최대업체수: number; 도착지: string };
  active: boolean;
  onToggle: () => void;
  onDropStop: (payload: DragPayload) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const overCapacity = capacity ? trip.boxes > capacity.최대수량 : false;
  const overCompanyCap = capacity ? trip.stops.length > capacity.최대업체수 : false;

  return (
    <Card
      className={cn(
        "cursor-pointer transition-shadow hover:shadow-md",
        active && "ring-2 ring-offset-1",
        dragOver && "ring-2 ring-primary"
      )}
      style={active && !dragOver ? { boxShadow: `0 0 0 2px ${color}` } : undefined}
      onClick={onToggle}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const payload = readDragPayload(e);
        if (payload) onDropStop(payload);
      }}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full" style={{ background: color }} />
            <div>
              <CardTitle className="flex items-center gap-1.5 text-base">
                {trip.기사명}
                {trip.manualEdit && (
                  <Badge variant="outline" className="text-[10px] font-normal">
                    수동 조정
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                {trip.톤수라벨} · {trip.tripNo}회전 · 출발 {hhmm(trip.departAt)}
              </CardDescription>
            </div>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold tabular-nums">{n(trip.boxes)}</div>
            <div className={cn("text-xs font-medium", loadRateTone(trip.loadRate))}>
              적재율 {pct(trip.loadRate)}
            </div>
          </div>
        </div>
        <Progress value={Math.min(100, trip.loadRate * 100)} className="mt-1 h-1.5" />
        {capacity && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              적재 범위 {n(capacity.최소수량)}~{n(capacity.최대수량)} 박스 · 업체 최대{" "}
              {capacity.최대업체수}곳
            </span>
            {overCapacity && <Badge variant="destructive" className="text-[10px]">적재 초과</Badge>}
            {overCompanyCap && (
              <Badge variant="destructive" className="text-[10px]">
                업체수 초과
              </Badge>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-2 pb-4">
        {trip.stops.length === 0 && (
          <div className="rounded-md border border-dashed px-2.5 py-4 text-center text-xs text-muted-foreground">
            배송지가 없습니다 — 기타에서 끌어다 놓으십시오
          </div>
        )}
        {trip.stops.map((s) => (
          <div
            key={s.pointId}
            draggable
            onDragStart={(e) => setDragPayload(e, { pointId: s.pointId, from: trip.id })}
            className="cursor-grab rounded-md border px-2.5 py-2 active:cursor-grabbing"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <GripVertical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
                <span
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                  style={{ background: color }}
                >
                  {s.seq}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{s.company}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{s.region}</div>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm tabular-nums">{n(s.boxes)}</div>
                <div
                  className={cn(
                    "flex items-center gap-1 text-[11px] tabular-nums",
                    s.timeOk === false ? "text-destructive" : "text-muted-foreground"
                  )}
                >
                  <Clock className="size-3" />
                  {hhmm(s.arriveAt)}
                </div>
              </div>
            </div>

            {(s.timeRaw || s.tags.length > 0 || s.manual) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {s.timeRaw && (
                  <span className="text-[10px] text-muted-foreground">{s.timeRaw}</span>
                )}
                {s.tags.map((t) => (
                  <Badge key={t} variant="outline" className="px-1 py-0 text-[10px] font-normal">
                    {t}
                  </Badge>
                ))}
                {s.manual && (
                  <Badge variant="secondary" className="px-1 py-0 text-[10px] font-normal">
                    수동 배정
                  </Badge>
                )}
              </div>
            )}
          </div>
        ))}

        <Separator />

        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <MapPin className="size-3" /> 주행 {km(trip.driveKm)}
          </span>
          <span className="flex items-center gap-1">
            <Home className="size-3" /> 귀가 {km(trip.homeKm)}
          </span>
          <span>{hhmm(trip.homeAt)} 도착</span>
        </div>
        {capacity && (
          <div className="truncate text-[11px] text-muted-foreground">→ {capacity.도착지}</div>
        )}
        {trip.manualEdit && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            수동 조정된 회전입니다 — 거리·도착시각은 직선거리 근사값입니다. 2회전 이상 차량이면
            다음 회전 출발 시각을 다시 확인하십시오.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────

function UnassignedPanel({
  items,
  totalBoxes,
  onDropUnassigned,
}: {
  items: UnassignedItem[];
  totalBoxes: number;
  onDropUnassigned: (payload: DragPayload) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const byRegion = useMemo(() => {
    const map = new Map<string, UnassignedItem[]>();
    for (const u of items) {
      const key = u.region || "미상";
      map.set(key, [...(map.get(key) ?? []), u]);
    }
    return [...map.entries()]
      .map(([region, list]) => ({
        region,
        list: list.sort((a, b) => b.boxes - a.boxes),
        boxes: list.reduce((s, x) => s + x.boxes, 0),
      }))
      .sort((a, b) => b.boxes - a.boxes);
  }, [items]);

  const unassignedBoxes = items.reduce((s, x) => s + x.boxes, 0);

  const dropHandlers = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const payload = readDragPayload(e);
      if (payload) onDropUnassigned(payload);
    },
  };

  if (items.length === 0) {
    return (
      <Card className={cn(dragOver && "ring-2 ring-primary")} {...dropHandlers}>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-emerald-600" /> 전량 배차되었습니다. 기사 티켓에서
          끌어다 놓으면 여기로 미배차 처리할 수 있습니다.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn(dragOver && "ring-2 ring-primary")} {...dropHandlers}>
      <CardHeader>
        <CardTitle className="text-base">기타 (미배차) — 권역별</CardTitle>
        <CardDescription>
          총 {n(unassignedBoxes)} 박스 ({pct(unassignedBoxes / Math.max(1, totalBoxes), 1)}).
          권역별 소계로 용차 1대에 묶을 수 있는지 판단하십시오. 용차 투입은 담당자 결정입니다 (R-12).
          업체를 끌어다 기사 티켓에 놓으면 수동으로 배정할 수 있습니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {byRegion.map(({ region, list, boxes }) => (
          <div key={region} className="rounded-md border">
            <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
              <div className="flex items-center gap-2">
                <Package className="size-3.5 text-muted-foreground" />
                <span className="text-sm font-semibold">{region}</span>
                <Badge variant="secondary" className="text-[10px]">
                  {list.length}개사
                </Badge>
              </div>
              <span className="text-sm font-semibold tabular-nums">{n(boxes)} 박스</span>
            </div>
            <div className="divide-y">
              {list.map((u) => {
                const draggableItem = !!u.geo;
                return (
                  <div
                    key={u.pointId}
                    draggable={draggableItem}
                    onDragStart={(e) =>
                      draggableItem && setDragPayload(e, { pointId: u.pointId, from: "unassigned" })
                    }
                    className={cn(
                      "px-3 py-2",
                      draggableItem ? "cursor-grab active:cursor-grabbing" : "opacity-70"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2">
                        {draggableItem && (
                          <GripVertical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{u.company}</div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {u.address}
                          </div>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-sm tabular-nums">{n(u.boxes)}</div>
                        <Badge variant="outline" className="text-[10px]">
                          {u.reason}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-1 text-[11px] text-muted-foreground">{u.note}</div>
                    {!draggableItem && (
                      <div className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                        좌표가 없어 회전에 끌어다 놓을 수 없습니다
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
