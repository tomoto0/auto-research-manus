import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter, subscribeToRun, getRunEvents } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { cleanupStaleRuns } from "../startup-cleanup";
import { getArtifactsForRun } from "../db";
import archiver from "archiver";
import { getPipelineExecutionMode } from "./pipeline-execution";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // OAuth callback
  registerOAuthRoutes(app);

  // ─── Download proxy: forces Content-Disposition attachment ───
  app.get("/api/download/artifact/:artifactId", async (req, res) => {
    try {
      const { artifactId } = req.params;
      const { getDb } = await import("../db");
      const db = await getDb();
      if (!db) { res.status(500).json({ error: "Database unavailable" }); return; }
      const { artifacts: artifactsTable } = await import("../../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(artifactsTable).where(eq(artifactsTable.id, parseInt(artifactId))).limit(1);
      if (!rows.length) { res.status(404).json({ error: "Artifact not found" }); return; }
      const artifact = rows[0];
      if (!artifact.fileUrl) { res.status(404).json({ error: "No file URL" }); return; }

      // Fetch the file from S3
      const fileResp = await fetch(artifact.fileUrl);
      if (!fileResp.ok) { res.status(502).json({ error: "Failed to fetch file" }); return; }

      const buffer = Buffer.from(await fileResp.arrayBuffer());
      const fileName = artifact.fileName || "download";
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Content-Type", artifact.mimeType || "application/octet-stream");
      res.setHeader("Content-Length", buffer.length.toString());
      res.send(buffer);
    } catch (err: any) {
      console.error("[Download] Error:", err);
      res.status(500).json({ error: err?.message || "Download failed" });
    }
  });

  // ─── ZIP download: bundle all artifacts for a run ───
  app.get("/api/download/zip/:runId", async (req, res) => {
    try {
      const { runId } = req.params;
      const artifactsList = await getArtifactsForRun(runId);
      if (!artifactsList.length) { res.status(404).json({ error: "No artifacts found" }); return; }

      res.setHeader("Content-Disposition", `attachment; filename="${runId}-artifacts.zip"`);
      res.setHeader("Content-Type", "application/zip");

      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", (err: any) => { throw err; });
      archive.pipe(res);

      // Fetch each artifact and add to ZIP
      for (const artifact of artifactsList) {
        if (!artifact.fileUrl) continue;
        try {
          const fileResp = await fetch(artifact.fileUrl);
          if (!fileResp.ok) continue;
          const buffer = Buffer.from(await fileResp.arrayBuffer());
          archive.append(buffer, { name: artifact.fileName || `artifact-${artifact.id}` });
        } catch (e) {
          console.warn(`[ZIP] Failed to fetch artifact ${artifact.id}:`, e);
        }
      }

      await archive.finalize();
    } catch (err: any) {
      console.error("[ZIP] Error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || "ZIP generation failed" });
      }
    }
  });

  // Lightweight probe so the client can verify SSE support before opening EventSource.
  app.head("/api/pipeline/events/:runId", (_req, res) => {
    res.status(204).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    }).end();
  });

  // SSE endpoint for real-time pipeline events
  app.get("/api/pipeline/events/:runId", (req, res) => {
    const { runId } = req.params;
    const since = parseInt(req.query.since as string) || 0;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // Send buffered events
    const buffered = getRunEvents(runId, since);
    for (const event of buffered) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    // Subscribe to new events
    const unsubscribe = subscribeToRun(runId, (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        unsubscribe();
      }
    });

    // Heartbeat
    const heartbeat = setInterval(() => {
      try { res.write(":heartbeat\n\n"); } catch { clearInterval(heartbeat); }
    }, 15000);

    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, async () => {
    console.log(`Server running on http://localhost:${port}/`);
    const executionMode = getPipelineExecutionMode();
    console.log(`[Startup] Pipeline execution mode: ${executionMode}`);
    // Cleanup stale pipeline runs from previous server instance
    try {
      const cleaned = await cleanupStaleRuns({
        includePending: executionMode !== "worker",
        reason: "Pipeline process lost due to server restart",
      });
      if (cleaned > 0) console.log(`[Startup] Cleaned up ${cleaned} stale pipeline run(s)`);
    } catch (e) {
      console.warn("[Startup] Cleanup failed:", e);
    }
  });
}

startServer().catch(console.error);
