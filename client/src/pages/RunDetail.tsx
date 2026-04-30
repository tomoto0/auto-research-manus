import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { PIPELINE_STAGES, type PipelineEvent } from "../../../shared/pipeline";
import { Streamdown } from "streamdown";
import {
  Loader2, CheckCircle2, XCircle, Clock, AlertCircle, Play,
  Download, FileText, Code, BookOpen, Users, ArrowLeft, RefreshCw,
  Search, Filter, Target, Lightbulb, Compass, Bug, Database,
  BarChart, Image, Table, List, PenTool, Link, FileCode, Package, RotateCcw,
  ChevronDown, ChevronRight, Eye, Copy, StopCircle, FileType, Archive,
  PauseCircle, ThumbsUp, ThumbsDown, Edit, ExternalLink, GraduationCap,
  FileSpreadsheet, FlaskConical, Activity, TrendingUp
} from "lucide-react";
import { useLocation } from "wouter";

const ICON_MAP: Record<string, React.ElementType> = {
  Search, BookOpen, Filter, FileText, Target, Lightbulb, Compass, CheckCircle: CheckCircle2,
  Code, Bug, Play, Database, BarChart, Image, Table, List, FileEdit: PenTool,
  PenTool, Link, FileCode, Users, RotateCcw, Package,
};

const STATUS_STYLES: Record<string, { label: string; color: string; bg: string }> = {
  running: { label: "Running", color: "text-blue-400", bg: "bg-blue-500/15 text-blue-400 border-blue-500/25" },
  completed: { label: "Completed", color: "text-emerald-400", bg: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" },
  failed: { label: "Failed", color: "text-red-400", bg: "bg-red-500/15 text-red-400 border-red-500/25" },
  pending: { label: "Pending", color: "text-amber-400", bg: "bg-amber-500/15 text-amber-400 border-amber-500/25" },
  stopped: { label: "Stopped", color: "text-gray-400", bg: "bg-gray-500/15 text-gray-400 border-gray-500/25" },
  awaiting_approval: { label: "Awaiting Approval", color: "text-orange-400", bg: "bg-orange-500/15 text-orange-400 border-orange-500/25" },
};

const SOURCE_COLORS: Record<string, string> = {
  arxiv: "bg-red-500/15 text-red-400 border-red-500/25",
  semanticScholar: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  springer: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  pubmed: "bg-violet-500/15 text-violet-400 border-violet-500/25",
  crossref: "bg-amber-500/15 text-amber-400 border-amber-500/25",
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMetricValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(4);
  }
  return String(value);
}

function formatMetricLabel(key: string): string {
  const normalized = key
    .replace(/^sample_waterfall_/, "")
    .replace(/^panel_fe_/, "")
    .replace(/^analysis_design_/, "")
    .replace(/^analysis_inputs_/, "");
  return normalized
    .split("_")
    .filter(Boolean)
    .map(part => part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function hasAnyAnalysisInputs(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(entry => Array.isArray(entry) ? entry.length > 0 : Boolean(entry));
}

export default function RunDetail({ runId }: { runId: string }) {
  const [, setLocation] = useLocation();
  const runQuery = trpc.pipeline.get.useQuery({ runId }, {
    // Only poll while the run is active; SSE provides real-time updates
    // so we use a longer interval just as a fallback safety net.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "running" || status === "pending" || status === "awaiting_approval") {
        return 10_000; // 10s fallback while running
      }
      return false; // stop polling once completed/failed/stopped
    },
    structuralSharing: true,
    staleTime: 2_000, // avoid rapid re-fetches from SSE + polling overlap
  });
  const papersQuery = trpc.literature.forRun.useQuery({ runId });
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const eventsEndRef = useRef<HTMLDivElement>(null);
  const [expandedStages, setExpandedStages] = useState<Set<number>>(new Set());
  const [editingPaper, setEditingPaper] = useState(false);
  const [paperContent, setPaperContent] = useState("");
  // Approval state
  const [approvalEditing, setApprovalEditing] = useState(false);
  const [approvalEditContent, setApprovalEditContent] = useState("");

  const phases = useMemo(() => {
    const grouped: Record<string, typeof PIPELINE_STAGES> = {};
    PIPELINE_STAGES.forEach(s => {
      if (!grouped[s.phase]) grouped[s.phase] = [];
      grouped[s.phase].push(s);
    });
    return Object.entries(grouped);
  }, []);

  const approveMutation = trpc.pipeline.approve.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        toast.success("Stage approved! Pipeline continuing...");
        setApprovalEditing(false);
        setApprovalEditContent("");
        runQuery.refetch();
      } else {
        toast.error(data.message || "Failed to approve");
      }
    },
    onError: (err) => toast.error(`Approval failed: ${err.message}`),
  });

  const rejectMutation = trpc.pipeline.reject.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        toast.info("Stage rejected. Pipeline stopped.");
        runQuery.refetch();
      } else {
        toast.error(data.message || "Failed to reject");
      }
    },
    onError: (err) => toast.error(`Rejection failed: ${err.message}`),
  });

  useEffect(() => {
    let evtSource: EventSource | null = null;
    let cancelled = false;
    // Debounce refetch to avoid rapid-fire re-fetches from SSE bursts
    let refetchTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = () => {
      if (refetchTimer) return; // already scheduled
      refetchTimer = setTimeout(() => {
        refetchTimer = null;
        runQuery.refetch();
      }, 1_000);
    };

    const connectEventStream = async () => {
      try {
        const streamUrl = new URL(`/api/pipeline/events/${runId}`, window.location.origin);
        const probeResponse = await fetch(streamUrl.toString(), {
          method: "HEAD",
          credentials: "include",
        });
        const contentType = probeResponse.headers.get("content-type") || "";
        if (!probeResponse.ok || !contentType.includes("text/event-stream")) {
          scheduleRefetch();
          return;
        }
        if (cancelled) return;

        evtSource = new EventSource(streamUrl.toString());
        evtSource.onmessage = (e) => {
          try {
            const event = JSON.parse(e.data) as PipelineEvent;
            setEvents(prev => [...prev.slice(-200), event]);
            // Only refetch on state-changing events (approval, completion, failure)
            if (
              event.type === "stage_awaiting_approval" ||
              event.type === "stage_approved" ||
              event.type === "stage_rejected" ||
              event.type === "run_complete" ||
              event.type === "run_fail"
            ) {
              scheduleRefetch();
            }
          } catch {}
        };
        evtSource.onerror = () => {
          // Keep the EventSource instance open: browsers auto-reconnect on transient failures.
          // Closing here can permanently stop live updates during long-running stages.
          scheduleRefetch();
        };
      } catch {
        scheduleRefetch();
      }
    };

    connectEventStream();

    return () => {
      cancelled = true;
      evtSource?.close();
      if (refetchTimer) clearTimeout(refetchTimer);
    };
  }, [runId]);

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const toggleStage = useCallback((num: number) => {
    setExpandedStages(prev => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num); else next.add(num);
      return next;
    });
  }, []);

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  }, []);

  const run = runQuery.data;
  if (runQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-64 gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">Loading pipeline...</span>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="text-center py-20 space-y-3">
        <p className="text-muted-foreground">Run not found</p>
        <Button variant="outline" size="sm" onClick={() => setLocation("/dashboard")}>
          <ArrowLeft className="h-3 w-3 mr-1.5" /> Back to Dashboard
        </Button>
      </div>
    );
  }

  const progress = run.totalStages > 0 ? (run.stagesDone / run.totalStages) * 100 : 0;
  const isActive = run.status === "running" || run.status === "pending" || run.status === "awaiting_approval";
  const isAwaiting = run.status === "awaiting_approval";
  const statusStyle = STATUS_STYLES[run.status] || STATUS_STYLES.pending;

  const getStageLog = (num: number) => (run as any).stages?.find((s: any) => s.stageNumber === num);

  const awaitingStage = isAwaiting ? (run as any).stages?.find((s: any) => s.status === "blocked_approval") : null;
  const awaitingStageOutput = awaitingStage?.output || "";

  const datasets = (run as any).datasets || [];
  const experiments = (run as any).experiments || [];
  const analysisInputs = (run as any).config?.analysisInputs;
  const showAnalysisInputs = hasAnyAnalysisInputs(analysisInputs);

  const stageStatusIcon = (status: string) => {
    switch (status) {
      case "done": return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
      case "failed": return <XCircle className="h-3.5 w-3.5 text-red-400" />;
      case "running": return <Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />;
      case "skipped": return <AlertCircle className="h-3.5 w-3.5 text-amber-400" />;
      case "blocked_approval": return <PauseCircle className="h-3.5 w-3.5 text-orange-400 animate-pulse" />;
      default: return <div className="h-3.5 w-3.5 rounded-full border border-border/60" />;
    }
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  };

  const papers = papersQuery.data || [];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <Button variant="ghost" size="sm" className="mb-2 -ml-2 text-xs text-muted-foreground h-7 gap-1" onClick={() => setLocation("/dashboard")}>
          <ArrowLeft className="h-3 w-3" /> Dashboard
        </Button>
        <h1 className="text-lg font-bold tracking-tight">{run.topic}</h1>
        <div className="flex items-center gap-2.5 mt-2 flex-wrap">
          <Badge variant="outline" className={`text-[11px] ${statusStyle.bg}`}>{statusStyle.label}</Badge>
          <span className="text-xs text-muted-foreground">Stage {run.currentStage}/{run.totalStages}</span>
          <span className="text-xs text-muted-foreground">{run.stagesDone} completed</span>
          {run.stagesFailed > 0 && <span className="text-xs text-red-400">{run.stagesFailed} failed</span>}
          {datasets.length > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 bg-violet-500/10 text-violet-400 border-violet-500/20">
              <Database className="h-2.5 w-2.5 mr-1" />
              {datasets.length} dataset{datasets.length > 1 ? "s" : ""}
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={() => runQuery.refetch()} className="h-6 w-6 p-0 ml-auto">
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Progress */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Progress</span>
          <span className="font-mono font-medium">{Math.round(progress)}%</span>
        </div>
        <Progress value={progress} className="h-1.5" />
        {run.status === "running" && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Running... Updates in real-time.
          </p>
        )}
      </div>

      {showAnalysisInputs && (
        <Card className="bg-card/40 border-border/30">
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <Compass className="h-4 w-4 text-primary" />
              Research Setup
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {analysisInputs.outcome && (
              <div className="rounded-md border border-border/20 bg-background/50 p-2.5">
                <p className="text-[10px] text-muted-foreground">Outcome</p>
                <p className="text-sm font-mono mt-0.5">{analysisInputs.outcome}</p>
              </div>
            )}
            {analysisInputs.treatment && (
              <div className="rounded-md border border-border/20 bg-background/50 p-2.5">
                <p className="text-[10px] text-muted-foreground">Treatment</p>
                <p className="text-sm font-mono mt-0.5">{analysisInputs.treatment}</p>
              </div>
            )}
            {analysisInputs.entity && (
              <div className="rounded-md border border-border/20 bg-background/50 p-2.5">
                <p className="text-[10px] text-muted-foreground">Entity / Panel ID</p>
                <p className="text-sm font-mono mt-0.5">{analysisInputs.entity}</p>
              </div>
            )}
            {analysisInputs.time && (
              <div className="rounded-md border border-border/20 bg-background/50 p-2.5">
                <p className="text-[10px] text-muted-foreground">Time</p>
                <p className="text-sm font-mono mt-0.5">{analysisInputs.time}</p>
              </div>
            )}
            {Array.isArray(analysisInputs.controls) && analysisInputs.controls.length > 0 && (
              <div className="rounded-md border border-border/20 bg-background/50 p-2.5">
                <p className="text-[10px] text-muted-foreground">Controls</p>
                <p className="text-sm mt-0.5">{analysisInputs.controls.join(", ")}</p>
              </div>
            )}
            {analysisInputs.missingDataMode && (
              <div className="rounded-md border border-border/20 bg-background/50 p-2.5">
                <p className="text-[10px] text-muted-foreground">Missing-data option</p>
                <p className="text-sm mt-0.5">{analysisInputs.missingDataMode}</p>
              </div>
            )}
            {analysisInputs.subgroup && (
              <div className="rounded-md border border-border/20 bg-background/50 p-2.5">
                <p className="text-[10px] text-muted-foreground">Subgroup</p>
                <p className="text-sm font-mono mt-0.5">{analysisInputs.subgroup}</p>
              </div>
            )}
            {analysisInputs.missingDataStrategy && (
              <div className="rounded-md border border-border/20 bg-background/50 p-2.5 md:col-span-2 lg:col-span-3">
                <p className="text-[10px] text-muted-foreground">Missing-data plan</p>
                <p className="text-sm mt-0.5 whitespace-pre-wrap">{analysisInputs.missingDataStrategy}</p>
              </div>
            )}
            {analysisInputs.variableNotes && (
              <div className="rounded-md border border-border/20 bg-background/50 p-2.5 md:col-span-2 lg:col-span-3">
                <p className="text-[10px] text-muted-foreground">Variable notes</p>
                <p className="text-sm mt-0.5 whitespace-pre-wrap">{analysisInputs.variableNotes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Approval Banner ─── */}
      {isAwaiting && awaitingStage && (
        <Card className="border-orange-500/30 bg-orange-500/5">
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm flex items-center gap-2 text-orange-400">
              <PauseCircle className="h-4 w-4 animate-pulse" />
              Stage {awaitingStage.stageNumber} — Awaiting Your Approval
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Review the output below. You can approve to continue, edit the output before approving, or reject to stop the pipeline.
            </p>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            {approvalEditing ? (
              <Textarea
                value={approvalEditContent}
                onChange={(e) => setApprovalEditContent(e.target.value)}
                className="min-h-[200px] font-mono text-xs bg-background/50"
                placeholder="Edit the stage output..."
              />
            ) : (
              <ScrollArea className="max-h-[300px]">
                <pre className="text-[11px] font-mono text-muted-foreground/80 whitespace-pre-wrap p-3 rounded-md bg-background/50 border border-border/20 leading-relaxed">
                  {awaitingStageOutput.substring(0, 5000)}{awaitingStageOutput.length > 5000 ? "\n\n... (truncated)" : ""}
                </pre>
              </ScrollArea>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                className="h-8 text-xs gap-1.5 bg-emerald-600 hover:bg-emerald-700"
                onClick={() => {
                  approveMutation.mutate({
                    runId,
                    editedOutput: approvalEditing ? approvalEditContent : undefined,
                  });
                }}
                disabled={approveMutation.isPending}
              >
                {approveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ThumbsUp className="h-3 w-3" />}
                {approvalEditing ? "Approve with Edits" : "Approve & Continue"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5"
                onClick={() => {
                  if (!approvalEditing) {
                    setApprovalEditContent(awaitingStageOutput);
                    setApprovalEditing(true);
                  } else {
                    setApprovalEditing(false);
                  }
                }}
              >
                <Edit className="h-3 w-3" />
                {approvalEditing ? "Cancel Edit" : "Edit Output"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5 text-red-400 border-red-500/30 hover:bg-red-500/10"
                onClick={() => rejectMutation.mutate({ runId, reason: "Rejected by user" })}
                disabled={rejectMutation.isPending}
              >
                {rejectMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ThumbsDown className="h-3 w-3" />}
                Reject & Stop
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs defaultValue="stages" className="space-y-4">
        <TabsList className="bg-card/50 border border-border/30 h-9 flex-wrap">
          <TabsTrigger value="stages" className="text-xs h-7">Stages</TabsTrigger>
          {datasets.length > 0 && (
            <TabsTrigger value="datasets" className="text-xs h-7">
              Data
              <Badge variant="secondary" className="ml-1.5 text-[9px] px-1 py-0 h-4">{datasets.length}</Badge>
            </TabsTrigger>
          )}
          {experiments.length > 0 && (
            <TabsTrigger value="experiments" className="text-xs h-7">
              <FlaskConical className="h-3 w-3 mr-1" />
              Results
            </TabsTrigger>
          )}
          <TabsTrigger value="literature" className="text-xs h-7">
            Literature
            {papers.length > 0 && <Badge variant="secondary" className="ml-1.5 text-[9px] px-1 py-0 h-4">{papers.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="paper" className="text-xs h-7">Paper</TabsTrigger>
          <TabsTrigger value="latex" className="text-xs h-7">LaTeX</TabsTrigger>
          <TabsTrigger value="artifacts" className="text-xs h-7">Artifacts</TabsTrigger>
          <TabsTrigger value="events" className="text-xs h-7">Events</TabsTrigger>
        </TabsList>

        {/* ─── Stages Tab ─── */}
        <TabsContent value="stages" className="space-y-3">
          {phases.map(([phase, stgs]) => (
            <Card key={phase} className="bg-card/40 border-border/30">
              <CardHeader className="py-3 px-4">
                <CardTitle className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">{phase}</CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-3 space-y-0.5">
                {stgs.map(s => {
                  const log = getStageLog(s.number);
                  const st = log?.status || "pending";
                  const output = log?.output;
                  const duration = log?.durationMs;
                  const IconComp = ICON_MAP[s.icon] || Clock;
                  const isExpanded = expandedStages.has(s.number);
                  return (
                    <div key={s.number}>
                      <div
                        className={`flex items-center gap-2.5 py-2 px-2.5 rounded-md transition-colors ${output ? "cursor-pointer" : ""} ${
                          st === "running" ? "bg-blue-500/5" :
                          st === "blocked_approval" ? "bg-orange-500/5 border border-orange-500/20" :
                          st === "done" && output ? "hover:bg-accent/30" :
                          st === "failed" ? "bg-red-500/5" : ""
                        }`}
                        onClick={() => output && toggleStage(s.number)}
                      >
                        {stageStatusIcon(st)}
                        <IconComp className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
                        <span className="text-[11px] font-mono text-muted-foreground/50 shrink-0 w-5">{String(s.number).padStart(2, "0")}</span>
                        <span className={`text-sm flex-1 truncate ${
                          st === "done" ? "text-foreground" :
                          st === "running" ? "text-blue-400" :
                          st === "blocked_approval" ? "text-orange-400" :
                          "text-muted-foreground"
                        }`}>{s.description}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {st === "blocked_approval" && <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-orange-500/10 text-orange-400 border-orange-500/25">Awaiting</Badge>}
                          {duration && <span className="text-[10px] text-muted-foreground/60 font-mono">{formatDuration(duration)}</span>}
                          {output && (isExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground/40" /> : <ChevronRight className="h-3 w-3 text-muted-foreground/40" />)}
                        </div>
                      </div>
                      {isExpanded && output && (
                        <div className="ml-[52px] mr-2 mt-0.5 mb-1.5 p-3 rounded-md bg-background/60 border border-border/20 relative">
                          <Button variant="ghost" size="sm" className="absolute top-1.5 right-1.5 h-6 w-6 p-0 opacity-50 hover:opacity-100" onClick={(e) => { e.stopPropagation(); copyToClipboard(output); }}>
                            <Copy className="h-3 w-3" />
                          </Button>
                          <ScrollArea className="max-h-[280px]">
                            <pre className="text-[11px] font-mono text-muted-foreground/80 whitespace-pre-wrap pr-6 leading-relaxed">{output.substring(0, 5000)}{output.length > 5000 ? "\n\n... (truncated)" : ""}</pre>
                          </ScrollArea>
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        {/* ─── Datasets Tab ─── */}
        <TabsContent value="datasets">
          <Card className="bg-card/40 border-border/30">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Database className="h-4 w-4 text-violet-400" />
                Uploaded Datasets
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">{datasets.length} file{datasets.length > 1 ? "s" : ""}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4 space-y-3">
              {datasets.map((ds: any) => (
                <Card key={ds.id} className="bg-background/50 border-border/20">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <FileSpreadsheet className="h-5 w-5 text-violet-400 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-sm font-medium truncate">{ds.originalName}</h3>
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-violet-500/10 text-violet-400 border-violet-500/20 shrink-0">
                            {ds.fileType}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                          {ds.sizeBytes && <span>{formatFileSize(ds.sizeBytes)}</span>}
                          {ds.rowCount && <span>{ds.rowCount.toLocaleString()} rows</span>}
                          {ds.columnNames && <span>{(ds.columnNames as string[]).length} columns</span>}
                        </div>
                        {ds.columnNames && (
                          <div className="flex flex-wrap gap-1">
                            {(ds.columnNames as string[]).slice(0, 12).map((col: string, i: number) => (
                              <Badge key={i} variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-card text-muted-foreground/70 border-border/30 font-mono">
                                {col}
                              </Badge>
                            ))}
                            {(ds.columnNames as string[]).length > 12 && (
                              <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-card text-muted-foreground/50 border-border/20">
                                +{(ds.columnNames as string[]).length - 12} more
                              </Badge>
                            )}
                          </div>
                        )}
                        {ds.preview && (
                          <details className="text-[10px]">
                            <summary className="text-muted-foreground/60 cursor-pointer hover:text-muted-foreground">Preview data</summary>
                            <pre className="mt-1 p-2 rounded bg-background/80 border border-border/20 font-mono text-muted-foreground/70 overflow-x-auto whitespace-pre">
                              {ds.preview}
                            </pre>
                          </details>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Experiment Results Tab ─── */}
        <TabsContent value="experiments">
          <div className="space-y-4">
            {experiments.map((exp: any) => {
              const metricEntries = Object.entries(exp.metrics || {}) as [string, any][];
              const isPanelFeMetric = (key: string) =>
                key.startsWith("panel_fe_complete_case_") ||
                key.startsWith("panel_fe_repeated_") ||
                key.startsWith("panel_fe_informative_") ||
                key.startsWith("panel_fe_min_") ||
                key.startsWith("panel_fe_median_") ||
                key.startsWith("panel_fe_max_") ||
                key.startsWith("panel_fe_transformed_");
              const designMetrics = metricEntries.filter(([key]) => key.startsWith("analysis_design_") || key.startsWith("analysis_inputs_"));
              const sampleWaterfallMetrics = metricEntries.filter(([key]) => key.startsWith("sample_waterfall_"));
              const panelFeMetrics = metricEntries.filter(([key]) => isPanelFeMetric(key));
              const keyMetrics = metricEntries.filter(([key]) =>
                !key.startsWith("analysis_design_") &&
                !key.startsWith("analysis_inputs_") &&
                !key.startsWith("sample_waterfall_") &&
                !isPanelFeMetric(key)
              );
              const panelFeStatus = exp.metrics?.panel_fe_gate_status;
              const panelFeReason = exp.metrics?.panel_fe_gate_reason;

              return (
              <Card key={exp.id} className="bg-card/40 border-border/30">
                <CardHeader className="py-3 px-4">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <FlaskConical className="h-4 w-4 text-emerald-400" />
                      Experiment Execution
                      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 ${
                        exp.executionStatus === "success" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                        exp.executionStatus === "error" ? "bg-red-500/10 text-red-400 border-red-500/20" :
                        "bg-amber-500/10 text-amber-400 border-amber-500/20"
                      }`}>
                        {exp.executionStatus}
                      </Badge>
                    </CardTitle>
                    {exp.executionTimeMs && (
                      <span className="text-[10px] text-muted-foreground font-mono">
                        {(exp.executionTimeMs / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="px-4 pb-4 space-y-4">
                  {designMetrics.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <Compass className="h-3 w-3" /> Resolved Design
                      </h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {designMetrics.map(([key, value]) => (
                          <div key={key} className="bg-background/50 rounded-md p-2.5 border border-border/20">
                            <p className="text-[10px] text-muted-foreground">{formatMetricLabel(key)}</p>
                            <p className="text-sm mt-0.5 break-words">{formatMetricValue(value)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {sampleWaterfallMetrics.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <TrendingUp className="h-3 w-3" /> Sample Waterfall
                      </h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                        {sampleWaterfallMetrics.map(([key, value]) => (
                          <div key={key} className="bg-background/50 rounded-md p-2.5 border border-border/20">
                            <p className="text-[10px] text-muted-foreground">{formatMetricLabel(key)}</p>
                            <p className="text-sm font-mono font-bold mt-0.5">{formatMetricValue(value)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {(panelFeStatus || panelFeMetrics.length > 0) && (
                    <div className="rounded-lg border border-border/20 bg-background/40 p-3">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                          <Activity className="h-3 w-3" /> Fixed Effects Gate
                        </h4>
                        {panelFeStatus && (
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 h-5 ${
                              panelFeStatus === "passed"
                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                : "bg-amber-500/10 text-amber-400 border-amber-500/20"
                            }`}
                          >
                            {panelFeStatus}
                          </Badge>
                        )}
                      </div>
                      {panelFeReason && (
                        <p className="text-xs text-muted-foreground mb-3">{panelFeReason}</p>
                      )}
                      {panelFeMetrics.length > 0 && (
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                          {panelFeMetrics.map(([key, value]) => (
                            <div key={key} className="bg-background/50 rounded-md p-2.5 border border-border/20">
                              <p className="text-[10px] text-muted-foreground">{formatMetricLabel(key)}</p>
                              <p className="text-sm font-mono font-bold mt-0.5">{formatMetricValue(value)}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Metrics */}
                  {keyMetrics.length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <TrendingUp className="h-3 w-3" /> Key Metrics
                      </h4>
                      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                        {keyMetrics.map(([key, value]) => (
                          <div key={key} className="bg-background/50 rounded-md p-2.5 border border-border/20">
                            <p className="text-[10px] text-muted-foreground truncate">{key}</p>
                            <p className="text-sm font-mono font-bold mt-0.5">{formatMetricValue(value)}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Charts */}
                  {exp.generatedCharts && (exp.generatedCharts as any[]).length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <BarChart className="h-3 w-3" /> Generated Charts
                      </h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {(exp.generatedCharts as any[]).map((chart: any, i: number) => (
                          <Card key={i} className="bg-background/50 border-border/20 overflow-hidden">
                            <div className="aspect-[4/3] bg-black/20 flex items-center justify-center">
                              {chart.url ? (
                                <img
                                  src={chart.url}
                                  alt={chart.name || `Chart ${i + 1}`}
                                  className="w-full h-full object-contain"
                                  loading="lazy"
                                />
                              ) : (
                                <Image className="h-8 w-8 text-muted-foreground/20" />
                              )}
                            </div>
                            <div className="p-2.5">
                              <p className="text-xs font-medium">{chart.name || `Chart ${i + 1}`}</p>
                              {chart.description && (
                                <p className="text-[10px] text-muted-foreground mt-0.5">{chart.description}</p>
                              )}
                            </div>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Tables */}
                  {exp.generatedTables && (exp.generatedTables as any[]).length > 0 && (
                    <div>
                      <h4 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                        <Table className="h-3 w-3" /> Generated Tables
                      </h4>
                      <div className="space-y-3">
                        {(exp.generatedTables as any[]).map((tbl: any, i: number) => (
                          <Card key={i} className="bg-background/50 border-border/20">
                            <CardContent className="p-3">
                              <p className="text-xs font-medium mb-1">{tbl.name || `Table ${i + 1}`}</p>
                              {tbl.description && <p className="text-[10px] text-muted-foreground mb-2">{tbl.description}</p>}
                              {tbl.data && (
                                <ScrollArea className="max-h-[200px]">
                                  <pre className="text-[10px] font-mono text-muted-foreground/80 whitespace-pre overflow-x-auto">
                                    {tbl.data}
                                  </pre>
                                </ScrollArea>
                              )}
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Python Code */}
                  {exp.pythonCode && (
                    <details className="text-xs">
                      <summary className="text-muted-foreground/60 cursor-pointer hover:text-muted-foreground flex items-center gap-1.5">
                        <Code className="h-3 w-3" /> View Python Code
                      </summary>
                      <div className="mt-2 relative">
                        <Button variant="ghost" size="sm" className="absolute top-1.5 right-1.5 h-6 w-6 p-0 opacity-50 hover:opacity-100 z-10" onClick={() => copyToClipboard(exp.pythonCode)}>
                          <Copy className="h-3 w-3" />
                        </Button>
                        <ScrollArea className="max-h-[300px]">
                          <pre className="text-[10px] font-mono text-muted-foreground/80 whitespace-pre-wrap p-3 rounded-md bg-background/80 border border-border/20 leading-relaxed">
                            {exp.pythonCode}
                          </pre>
                        </ScrollArea>
                      </div>
                    </details>
                  )}

                  {/* Stdout/Stderr */}
                  {exp.stdout && (
                    <details className="text-xs">
                      <summary className="text-muted-foreground/60 cursor-pointer hover:text-muted-foreground flex items-center gap-1.5">
                        <Activity className="h-3 w-3" /> Execution Output
                      </summary>
                      <ScrollArea className="max-h-[200px] mt-2">
                        <pre className="text-[10px] font-mono text-muted-foreground/70 whitespace-pre-wrap p-3 rounded-md bg-background/80 border border-border/20">
                          {exp.stdout}
                        </pre>
                      </ScrollArea>
                      {exp.stderr && (
                        <ScrollArea className="max-h-[100px] mt-1">
                          <pre className="text-[10px] font-mono text-red-400/70 whitespace-pre-wrap p-3 rounded-md bg-red-500/5 border border-red-500/10">
                            {exp.stderr}
                          </pre>
                        </ScrollArea>
                      )}
                    </details>
                  )}
                </CardContent>
              </Card>
            )})}

            {experiments.length === 0 && (
              <Card className="bg-card/40 border-border/30">
                <CardContent className="p-8 text-center">
                  <FlaskConical className="h-8 w-8 mx-auto text-muted-foreground/20 mb-3" />
                  <p className="text-sm text-muted-foreground">Experiment results will appear after the execution stage completes.</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Upload datasets when starting a pipeline to enable real Python execution.</p>
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* ─── Literature Tab ─── */}
        <TabsContent value="literature">
          <Card className="bg-card/40 border-border/30">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <GraduationCap className="h-4 w-4 text-primary" />
                Referenced Literature
                {papers.length > 0 && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">{papers.length} papers</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {papersQuery.isLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="animate-pulse bg-background/50 rounded-lg p-4 h-24" />
                  ))}
                </div>
              ) : papers.length === 0 ? (
                <div className="text-center py-16 text-muted-foreground">
                  <BookOpen className="h-8 w-8 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">Literature will appear after the search stage completes.</p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {papers.map((paper: any, idx: number) => (
                    <Card key={paper.id || idx} className="bg-background/50 border-border/20 hover:border-border/40 transition-colors">
                      <CardContent className="p-4">
                        <div className="flex items-start gap-3">
                          <div className="flex items-center justify-center h-6 w-6 rounded-full bg-primary/10 text-primary text-[10px] font-bold shrink-0 mt-0.5">
                            {idx + 1}
                          </div>
                          <div className="flex-1 min-w-0 space-y-1.5">
                            <div className="flex items-start gap-2">
                              <h3 className="text-sm font-medium leading-snug flex-1">{paper.title}</h3>
                              {paper.url && (
                                <a href={paper.url} target="_blank" rel="noopener noreferrer" className="shrink-0 mt-0.5">
                                  <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-primary transition-colors" />
                                </a>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {paper.authors || "Unknown authors"} {paper.year ? `(${paper.year})` : ""}
                            </p>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${SOURCE_COLORS[paper.source] || "bg-gray-500/15 text-gray-400 border-gray-500/25"}`}>
                                {paper.source}
                              </Badge>
                              {paper.venue && (
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-card text-muted-foreground border-border/30">
                                  {paper.venue.length > 40 ? paper.venue.substring(0, 40) + "..." : paper.venue}
                                </Badge>
                              )}
                              {paper.citationCount > 0 && (
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-amber-500/10 text-amber-400 border-amber-500/20">
                                  {paper.citationCount} citations
                                </Badge>
                              )}
                              {paper.doi && (
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 h-4 bg-card text-muted-foreground/60 border-border/20 font-mono">
                                  DOI
                                </Badge>
                              )}
                            </div>
                            {paper.abstract && (
                              <p className="text-[11px] text-muted-foreground/70 leading-relaxed line-clamp-3">
                                {paper.abstract}
                              </p>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Paper Tab ─── */}
        <TabsContent value="paper">
          <Card className="bg-card/40 border-border/30">
            <CardHeader className="py-3 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" /> Generated Paper
                </CardTitle>
                {run.paperMarkdown && (
                  <div className="flex gap-1.5">
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => copyToClipboard(run.paperMarkdown || "")}>
                      <Copy className="h-3 w-3 mr-1" /> Copy
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setEditingPaper(!editingPaper); if (!editingPaper) setPaperContent(run.paperMarkdown || ""); }}>
                      {editingPaper ? <Eye className="h-3 w-3 mr-1" /> : <PenTool className="h-3 w-3 mr-1" />}
                      {editingPaper ? "Preview" : "Edit"}
                    </Button>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {run.paperMarkdown ? (
                editingPaper ? (
                  <Textarea value={paperContent} onChange={(e) => setPaperContent(e.target.value)} className="min-h-[500px] font-mono text-xs bg-background/50" />
                ) : (
                  <div className="prose prose-invert prose-sm max-w-none">
                    <Streamdown>{run.paperMarkdown}</Streamdown>
                  </div>
                )
              ) : (
                <div className="text-center py-16 text-muted-foreground">
                  <FileText className="h-8 w-8 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">Paper will appear here once writing stages complete.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── LaTeX Tab ─── */}
        <TabsContent value="latex">
          <Card className="bg-card/40 border-border/30">
            <CardHeader className="py-3 px-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <FileCode className="h-4 w-4 text-primary" /> LaTeX Source
                </CardTitle>
                {run.paperLatex && (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => copyToClipboard(run.paperLatex || "")}>
                    <Copy className="h-3 w-3 mr-1" /> Copy
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {run.paperLatex ? (
                <ScrollArea className="max-h-[600px]">
                  <pre className="text-[11px] font-mono text-muted-foreground/80 whitespace-pre-wrap p-4 rounded-md bg-background/50 border border-border/20 leading-relaxed">{run.paperLatex}</pre>
                </ScrollArea>
              ) : (
                <div className="text-center py-16 text-muted-foreground">
                  <FileCode className="h-8 w-8 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">LaTeX source will appear after the compilation stage.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Artifacts Tab ─── */}
        <TabsContent value="artifacts">
          <Card className="bg-card/40 border-border/30">
            <CardHeader className="py-3 px-4 flex flex-row items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Download className="h-4 w-4 text-primary" /> Generated Artifacts
              </CardTitle>
              {(run as any).artifacts?.length > 0 && (
                <Button
                  variant="default"
                  size="sm"
                  className="h-8 text-xs gap-1.5"
                  onClick={() => {
                    const link = document.createElement('a');
                    link.href = `/api/download/zip/${run.runId}`;
                    link.download = `${run.runId}-artifacts.zip`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    toast.success('Downloading ZIP bundle...');
                  }}
                >
                  <Archive className="h-3.5 w-3.5" /> Download All (ZIP)
                </Button>
              )}
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {(run as any).artifacts?.length > 0 ? (
                <div className="space-y-2">
                  {[...(run as any).artifacts]
                    .sort((a: any, b: any) => {
                      const order: Record<string, number> = { paper_pdf: 0, paper_tex: 1, references_bib: 2, experiment_code: 3, experiment_chart: 4, review_report: 5, pdf_error_log: 6 };
                      return (order[a.artifactType] ?? 99) - (order[b.artifactType] ?? 99);
                    })
                    .map((a: any) => {
                    const isPdf = a.artifactType.includes("pdf");
                    const isChart = a.artifactType === "experiment_chart";
                    const isError = a.artifactType === "pdf_error_log";
                    return (
                    <div key={a.id} className={`rounded-md border ${
                      isPdf ? 'bg-red-500/5 border-red-500/20' :
                      isChart ? 'bg-emerald-500/5 border-emerald-500/20' :
                      isError ? 'bg-orange-500/5 border-orange-500/20' :
                      'bg-background/50 border-border/20'
                    }`}>
                      {/* Chart image thumbnail preview */}
                      {isChart && a.fileUrl && (
                        <div className="p-2 border-b border-border/20">
                          <img
                            src={a.fileUrl}
                            alt={a.fileName}
                            className="w-full max-h-48 object-contain rounded bg-white"
                            loading="lazy"
                          />
                        </div>
                      )}
                      <div className="flex items-center justify-between p-3">
                      <div className="flex items-center gap-2.5 min-w-0">
                        {isPdf ? <FileType className="h-4 w-4 text-red-400 shrink-0" /> :
                         isChart ? <BarChart className="h-4 w-4 text-emerald-400 shrink-0" /> :
                         isError ? <AlertCircle className="h-4 w-4 text-orange-400 shrink-0" /> :
                         a.artifactType.includes("tex") ? <FileCode className="h-4 w-4 text-primary shrink-0" /> :
                         a.artifactType.includes("bib") ? <BookOpen className="h-4 w-4 text-emerald-400 shrink-0" /> :
                         a.artifactType.includes("code") ? <Code className="h-4 w-4 text-amber-400 shrink-0" /> :
                         <FileText className="h-4 w-4 text-violet-400 shrink-0" />}
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{a.fileName}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {a.artifactType.replace(/_/g, " ")}
                            {isPdf ? ' \u2014 formatted research paper' : ''}
                            {isChart ? ' \u2014 data analysis visualization' : ''}
                            {isError ? ' \u2014 PDF generation error details' : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {(isPdf || isChart) && a.fileUrl && (
                          <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
                            <a href={a.fileUrl} target="_blank" rel="noopener noreferrer">
                              <Eye className="h-3 w-3 mr-1" /> Preview
                            </a>
                          </Button>
                        )}
                        <Button
                          variant={isPdf ? "default" : "outline"}
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => {
                            const link = document.createElement('a');
                            link.href = `/api/download/artifact/${a.id}`;
                            link.download = a.fileName;
                            document.body.appendChild(link);
                            link.click();
                            document.body.removeChild(link);
                          }}
                        >
                          <Download className="h-3 w-3 mr-1" /> Download
                        </Button>
                      </div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-16 text-muted-foreground">
                  <Package className="h-8 w-8 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">Artifacts will appear after the final compilation stage.</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Events Tab ─── */}
        <TabsContent value="events">
          <Card className="bg-card/40 border-border/30">
            <CardHeader className="py-3 px-4">
              <CardTitle className="text-sm flex items-center gap-2">
                <Play className="h-4 w-4 text-primary" /> Real-time Events
                {isActive && <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <ScrollArea className="h-[400px]">
                <div className="space-y-0.5 font-mono text-[11px]">
                  {events.length === 0 ? (
                    <p className="text-muted-foreground/50 text-center py-12 text-xs">Waiting for events...</p>
                  ) : (
                    events.map((evt, i) => (
                      <div key={i} className={`flex gap-2 py-1 px-1.5 rounded ${
                        evt.type === "stage_fail" || evt.type === "run_fail" ? "text-red-400/80" :
                        evt.type === "stage_complete" || evt.type === "run_complete" || evt.type === "stage_approved" ? "text-emerald-400/80" :
                        evt.type === "stage_start" ? "text-blue-400/80" :
                        evt.type === "stage_awaiting_approval" ? "text-orange-400/80" :
                        evt.type === "stage_rejected" ? "text-red-400/80" :
                        "text-muted-foreground/60"
                      }`}>
                        <span className="text-muted-foreground/40 shrink-0">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                        <span className="shrink-0 opacity-70">[{evt.type.replace(/_/g, " ")}]</span>
                        <span className="truncate">{evt.message}</span>
                      </div>
                    ))
                  )}
                  <div ref={eventsEndRef} />
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
