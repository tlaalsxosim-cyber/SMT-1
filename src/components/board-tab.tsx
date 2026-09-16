"use client";

/**
 * ① 배차 보드 (§11 ① / FR-28, FR-29, FR-42, FR-43, FR-50)
 *
 * 지도 · 기사별 배차 티켓 · 기타(미배차) 권역별 패널 · 주소 확인 필요 · AI 브리핑.
 */

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Home,
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

export function BoardTab() {
  const { result, downloadResult, downloaded } = useApp();
  const [focusTripId, setFocusTripId] = useState<string | null>(null);

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
          <MapView result={result} focusTripId={focusTripId} onFocusTrip={setFocusTripId} />

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
              <UnassignedPanel items={result.unassigned} totalBoxes={result.totalBoxes} />
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

function TripTicket({
  trip,
  color,
  capacity,
  active,
  onToggle,
}: {
  trip: Trip;
  color: string;
  capacity?: { 최소수량: number; 최대수량: number; 도착지: string };
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <Card
      className={cn(
        "cursor-pointer transition-shadow hover:shadow-md",
        active && "ring-2 ring-offset-1"
      )}
      style={active ? { boxShadow: `0 0 0 2px ${color}` } : undefined}
      onClick={onToggle}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full" style={{ background: color }} />
            <div>
              <CardTitle className="text-base">{trip.기사명}</CardTitle>
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
        <Progress value={trip.loadRate * 100} className="mt-1 h-1.5" />
        {capacity && (
          <div className="text-[11px] text-muted-foreground">
            적재 범위 {n(capacity.최소수량)}~{n(capacity.최대수량)} 박스
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-2 pb-4">
        {trip.stops.map((s) => (
          <div key={s.pointId} className="rounded-md border px-2.5 py-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
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

            {(s.timeRaw || s.tags.length > 0) && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                {s.timeRaw && (
                  <span className="text-[10px] text-muted-foreground">{s.timeRaw}</span>
                )}
                {s.tags.map((t) => (
                  <Badge key={t} variant="outline" className="px-1 py-0 text-[10px] font-normal">
                    {t}
                  </Badge>
                ))}
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
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────

function UnassignedPanel({
  items,
  totalBoxes,
}: {
  items: UnassignedItem[];
  totalBoxes: number;
}) {
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

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-emerald-600" /> 전량 배차되었습니다.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">기타 (미배차) — 권역별</CardTitle>
        <CardDescription>
          총 {n(unassignedBoxes)} 박스 ({pct(unassignedBoxes / Math.max(1, totalBoxes), 1)}).
          권역별 소계로 용차 1대에 묶을 수 있는지 판단하십시오. 용차 투입은 담당자 결정입니다 (R-12).
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
              {list.map((u) => (
                <div key={u.pointId} className="px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{u.company}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{u.address}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-sm tabular-nums">{n(u.boxes)}</div>
                      <Badge variant="outline" className="text-[10px]">
                        {u.reason}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">{u.note}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
