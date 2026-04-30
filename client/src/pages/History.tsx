import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import {
  Loader2, CheckCircle2, XCircle, Clock, AlertCircle, ArrowRight, StopCircle, PauseCircle
} from "lucide-react";

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; badgeClass: string }> = {
  running: { label: "Running", icon: Loader2, color: "text-blue-400", badgeClass: "bg-blue-500/15 text-blue-400 border-blue-500/25" },
  completed: { label: "Completed", icon: CheckCircle2, color: "text-emerald-400", badgeClass: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25" },
  failed: { label: "Failed", icon: XCircle, color: "text-red-400", badgeClass: "bg-red-500/15 text-red-400 border-red-500/25" },
  pending: { label: "Pending", icon: Clock, color: "text-amber-400", badgeClass: "bg-amber-500/15 text-amber-400 border-amber-500/25" },
  stopped: { label: "Stopped", icon: StopCircle, color: "text-gray-400", badgeClass: "bg-gray-500/15 text-gray-400 border-gray-500/25" },
  awaiting_approval: { label: "Awaiting Approval", icon: PauseCircle, color: "text-orange-400", badgeClass: "bg-orange-500/15 text-orange-400 border-orange-500/25" },
};

export default function History() {
  const [, setLocation] = useLocation();
  const runsQuery = trpc.pipeline.list.useQuery({ limit: 50 });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold">All Pipeline Runs</h2>
        <p className="text-xs text-muted-foreground mt-0.5">Click a run to view details</p>
      </div>

      {runsQuery.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(i => (
            <Card key={i} className="animate-pulse bg-card/50">
              <CardContent className="p-4 h-16" />
            </Card>
          ))}
        </div>
      ) : runsQuery.data && runsQuery.data.length > 0 ? (
        <div className="space-y-2">
          {runsQuery.data.map((run: any) => {
            const cfg = STATUS_CONFIG[run.status] || STATUS_CONFIG.pending;
            const StatusIcon = cfg.icon;
            const progress = run.totalStages > 0 ? Math.round((run.stagesDone / run.totalStages) * 100) : 0;
            const duration = run.completedAt
              ? Math.round((new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) / 60000)
              : null;
            return (
              <Card
                key={run.runId}
                className="bg-card/50 hover:bg-card/80 transition-colors cursor-pointer group"
                onClick={() => setLocation(`/run/${run.runId}`)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <StatusIcon className={`h-3.5 w-3.5 shrink-0 ${cfg.color} ${run.status === "running" ? "animate-spin" : ""}`} />
                        <p className="text-sm font-medium truncate">{run.topic}</p>
                      </div>
                      <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground flex-wrap">
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-5 font-normal ${cfg.badgeClass}`}>
                          {cfg.label}
                        </Badge>
                        <span>Stage {run.currentStage || 0}/{run.totalStages}</span>
                        <span>{run.stagesDone} done</span>
                        {run.stagesFailed > 0 && <span className="text-red-400">{run.stagesFailed} failed</span>}
                        <span>{new Date(run.createdAt).toLocaleString()}</span>
                        {duration !== null && <span>{duration}min</span>}
                      </div>
                      {(run.status === "running" || run.status === "pending") && (
                        <Progress value={progress} className="h-1 mt-2" />
                      )}
                      {run.status === "awaiting_approval" && (
                        <div className="flex items-center gap-1.5 mt-2 text-[11px] text-orange-400">
                          <PauseCircle className="h-3 w-3" />
                          <span>Waiting for approval at Stage {run.currentStage}</span>
                        </div>
                      )}
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors shrink-0 mt-1" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="bg-card/30 border-dashed">
          <CardContent className="p-12 text-center">
            <Clock className="h-8 w-8 mx-auto text-muted-foreground/20 mb-3" />
            <p className="text-sm text-muted-foreground">No runs yet</p>
            <Button variant="outline" size="sm" className="mt-4 text-xs" onClick={() => setLocation("/dashboard")}>
              Go to Dashboard
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
