import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc";
import { useState, useEffect } from "react";
import { Beaker, Clock, BarChart3, Database, Globe, BookOpen, FlaskConical, Microscope } from "lucide-react";
import { CONFERENCE_TEMPLATES } from "../../../shared/pipeline";
import { toast } from "sonner";

export default function Settings() {
  const settingsQuery = trpc.settings.getAll.useQuery();
  const setMutation = trpc.settings.set.useMutation({
    onSuccess: () => toast.success("Setting saved"),
    onError: (err: any) => toast.error(err.message),
  });

  const [targetConference, setTargetConference] = useState("General");
  const [experimentMode, setExperimentMode] = useState("simulated");
  const [maxRetries, setMaxRetries] = useState(2);
  const [timeoutMinutes, setTimeoutMinutes] = useState(120);
  const [qualityThreshold, setQualityThreshold] = useState(0.7);

  const [dataSources, setDataSources] = useState({
    arxiv: true,
    semanticScholar: true,
    springer: true,
    pubmed: true,
    crossref: true,
  });

  useEffect(() => {
    if (settingsQuery.data) {
      const d = settingsQuery.data;
      if (d.targetConference) setTargetConference(d.targetConference);
      if (d.experimentMode) setExperimentMode(d.experimentMode);
      if (d.maxRetries) setMaxRetries(parseInt(d.maxRetries));
      if (d.timeoutMinutes) setTimeoutMinutes(parseInt(d.timeoutMinutes));
      if (d.qualityThreshold) setQualityThreshold(parseFloat(d.qualityThreshold));
    }
  }, [settingsQuery.data]);

  const saveSetting = (key: string, value: string) => {
    setMutation.mutate({ key, value });
  };

  const DATA_SOURCES = [
    { key: "arxiv" as const, name: "arXiv", desc: "Preprint server", icon: Globe, color: "text-orange-400" },
    { key: "semanticScholar" as const, name: "Semantic Scholar", desc: "AI research search", icon: Microscope, color: "text-blue-400" },
    { key: "springer" as const, name: "Springer Nature", desc: "Academic publisher", icon: BookOpen, color: "text-emerald-400" },
    { key: "pubmed" as const, name: "PubMed", desc: "Biomedical literature", icon: FlaskConical, color: "text-violet-400" },
    { key: "crossref" as const, name: "CrossRef", desc: "Metadata aggregator", icon: Database, color: "text-amber-400" },
  ];

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Pipeline Configuration */}
      <Card className="bg-card/40 border-border/30">
        <CardHeader className="py-4 px-5">
          <CardTitle className="text-sm flex items-center gap-2">
            <Beaker className="h-4 w-4 text-primary" />
            Pipeline Configuration
          </CardTitle>
          <CardDescription className="text-xs">Default settings for new pipeline runs</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Target Conference</Label>
              <Select value={targetConference} onValueChange={(v) => { setTargetConference(v); saveSetting("targetConference", v); }}>
                <SelectTrigger className="h-9 text-sm bg-background/50 border-border/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONFERENCE_TEMPLATES.map(t => (
                    <SelectItem key={t.id} value={t.name}>
                      <span className="font-medium">{t.name}</span>
                      <span className="text-muted-foreground ml-1.5 text-[10px]">({t.description.split(" ").slice(0, 3).join(" ")})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Experiment Mode</Label>
              <Select value={experimentMode} onValueChange={(v) => { setExperimentMode(v); saveSetting("experimentMode", v); }}>
                <SelectTrigger className="h-9 text-sm bg-background/50 border-border/40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="simulated">Simulated</SelectItem>
                  <SelectItem value="sandbox">Sandbox</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator className="opacity-30" />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Max Retries per Stage</Label>
              <span className="text-xs font-mono text-muted-foreground bg-background/50 px-2 py-0.5 rounded">{maxRetries}</span>
            </div>
            <Slider
              value={[maxRetries]}
              onValueChange={([v]) => setMaxRetries(v)}
              onValueCommit={([v]) => saveSetting("maxRetries", String(v))}
              min={0} max={5} step={1}
              className="py-1"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs flex items-center gap-1.5"><Clock className="h-3 w-3" /> Timeout (min)</Label>
              <span className="text-xs font-mono text-muted-foreground bg-background/50 px-2 py-0.5 rounded">{timeoutMinutes}</span>
            </div>
            <Slider
              value={[timeoutMinutes]}
              onValueChange={([v]) => setTimeoutMinutes(v)}
              onValueCommit={([v]) => saveSetting("timeoutMinutes", String(v))}
              min={10} max={300} step={10}
              className="py-1"
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs flex items-center gap-1.5"><BarChart3 className="h-3 w-3" /> Quality Threshold</Label>
              <span className="text-xs font-mono text-muted-foreground bg-background/50 px-2 py-0.5 rounded">{qualityThreshold.toFixed(1)}</span>
            </div>
            <Slider
              value={[qualityThreshold * 100]}
              onValueChange={([v]) => setQualityThreshold(v / 100)}
              onValueCommit={([v]) => saveSetting("qualityThreshold", String(v / 100))}
              min={0} max={100} step={5}
              className="py-1"
            />
          </div>
        </CardContent>
      </Card>

      {/* Data Sources */}
      <Card className="bg-card/40 border-border/30">
        <CardHeader className="py-4 px-5">
          <CardTitle className="text-sm flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            Literature Data Sources
          </CardTitle>
          <CardDescription className="text-xs">Toggle search databases for literature review</CardDescription>
        </CardHeader>
        <CardContent className="px-5 pb-5 space-y-2">
          {DATA_SOURCES.map(src => (
            <div key={src.key} className="flex items-center justify-between py-2.5 px-3 rounded-md bg-background/30 border border-border/20">
              <div className="flex items-center gap-2.5">
                <src.icon className={`h-4 w-4 ${src.color} shrink-0`} />
                <div>
                  <p className="text-sm font-medium">{src.name}</p>
                  <p className="text-[10px] text-muted-foreground">{src.desc}</p>
                </div>
              </div>
              <Switch
                checked={dataSources[src.key]}
                onCheckedChange={(v) => setDataSources(prev => ({ ...prev, [src.key]: v }))}
                className="scale-90"
              />
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground/60 mt-3 px-1">
            API keys for Semantic Scholar and Springer are managed in Application Secrets.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
