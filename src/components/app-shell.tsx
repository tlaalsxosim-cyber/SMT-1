"use client";

import { useEffect } from "react";
import { Database, Download, LayoutDashboard, Settings2, Upload } from "lucide-react";

import { BoardTab } from "@/components/board-tab";
import { DownloadTab } from "@/components/download-tab";
import { SettingsTab } from "@/components/settings-tab";
import { UploadTab } from "@/components/upload-tab";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApp, useUnsavedResult, type TabKey } from "@/lib/store";

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "board", label: "배차 보드", icon: LayoutDashboard },
  { key: "upload", label: "데이터 업로드", icon: Upload },
  { key: "download", label: "결과 다운로드", icon: Download },
  { key: "settings", label: "설정", icon: Settings2 },
];

export function AppShell() {
  const { tab, setTab, result, status, refreshStatus, settings } = useApp();
  const unsaved = useUnsavedResult();

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // FR-51 — 다운로드 전 이탈 경고
  useEffect(() => {
    if (!unsaved) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [unsaved]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Database className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold leading-tight">
                AI 기반 일일 배송 최적화 시스템
              </h1>
              <p className="text-xs text-muted-foreground">
                평택센터 · 기사 9명 · 12회전 · 무저장(DB 미사용) 구조
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {settings.demo && <Badge variant="secondary">Demo Mode</Badge>}
            {status && !status.tmapKeyPresent && (
              <Badge variant="outline" className="border-amber-500/50 text-amber-600">
                TMAP 키 미설정
              </Badge>
            )}
            {status && status.usage.counts.optimize > 0 && (
              <Badge variant="outline" className="tabular-nums">
                최적화 {status.usage.counts.optimize}/{status.usage.limits.optimize}
              </Badge>
            )}
            {unsaved && (
              <Badge variant="destructive">미다운로드 — 이탈 시 결과 소멸</Badge>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-4 py-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
          <TabsList className="mb-6">
            {TABS.map(({ key, label, icon: Icon }) => (
              <TabsTrigger key={key} value={key} className="gap-1.5">
                <Icon className="size-4" />
                {label}
                {key === "board" && result && (
                  <Badge variant="secondary" className="ml-1 text-[10px]">
                    {result.usedTrips}
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="board">
            <BoardTab />
          </TabsContent>
          <TabsContent value="upload">
            <UploadTab />
          </TabsContent>
          <TabsContent value="download">
            <DownloadTab />
          </TabsContent>
          <TabsContent value="settings">
            <SettingsTab />
          </TabsContent>
        </Tabs>
      </main>

      <footer className="border-t py-4">
        <p className="mx-auto max-w-[1600px] px-4 text-xs text-muted-foreground">
          업로드 데이터·좌표·경로는 서버와 브라우저 어디에도 저장되지 않습니다. 결과는 다운로드한
          엑셀이 유일한 산출물입니다. TMAP 경로 좌표의 24시간 초과 보관은 약관상 금지됩니다.
        </p>
      </footer>
    </div>
  );
}
