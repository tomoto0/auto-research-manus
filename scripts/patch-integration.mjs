import fs from 'fs';

function replaceAll(file, replacements) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [find, replace] of replacements) {
    if (!text.includes(find)) {
      console.warn(`[skip] ${file}: pattern not found: ${find.slice(0, 80)}`);
      continue;
    }
    text = text.replaceAll(find, replace);
  }
  fs.writeFileSync(file, text);
}

// 1) Protect application tRPC procedures while keeping auth/system health and static metadata public.
replaceAll('server/routers.ts', [
  ['import { publicProcedure, router } from "./_core/trpc";', 'import { publicProcedure, protectedProcedure, router } from "./_core/trpc";'],
  ['start: publicProcedure', 'start: protectedProcedure'],
  ['stop: publicProcedure', 'stop: protectedProcedure'],
  ['approve: publicProcedure', 'approve: protectedProcedure'],
  ['reject: publicProcedure', 'reject: protectedProcedure'],
  ['approvalStatus: publicProcedure', 'approvalStatus: protectedProcedure'],
  ['get: publicProcedure', 'get: protectedProcedure'],
  ['list: publicProcedure', 'list: protectedProcedure'],
  ['events: publicProcedure', 'events: protectedProcedure'],
  ['search: publicProcedure', 'search: protectedProcedure'],
  ['forRun: publicProcedure', 'forRun: protectedProcedure'],
  ['set: publicProcedure', 'set: protectedProcedure'],
  ['getAll: publicProcedure', 'getAll: protectedProcedure'],
  ['myFiles: publicProcedure', 'myFiles: protectedProcedure'],
  ['allMyFiles: publicProcedure', 'allMyFiles: protectedProcedure'],
  ['experimentResults: publicProcedure', 'experimentResults: protectedProcedure'],
  // Restore auth and public reference-data endpoints.
  ['me: protectedProcedure.query(opts => opts.ctx.user)', 'me: publicProcedure.query(opts => opts.ctx.user)'],
  ['logout: protectedProcedure.mutation(({ ctx }) => {', 'logout: publicProcedure.mutation(({ ctx }) => {'],
  ['stages: protectedProcedure.query(() => PIPELINE_STAGES)', 'stages: publicProcedure.query(() => PIPELINE_STAGES)'],
  ['templates: protectedProcedure.query(() => CONFERENCE_TEMPLATES)', 'templates: publicProcedure.query(() => CONFERENCE_TEMPLATES)'],
]);

// 2) Protect dataset upload procedures so storage mutations are tied to Manus Auth users.
replaceAll('server/upload-procedures.ts', [
  ['import { publicProcedure, longRunningProcedure } from "./_core/trpc";', 'import { protectedProcedure } from "./_core/trpc";'],
  ['export const uploadChunkProcedure = publicProcedure', 'export const uploadChunkProcedure = protectedProcedure'],
  ['export const assembleChunksProcedure = longRunningProcedure', 'export const assembleChunksProcedure = protectedProcedure'],
  ['export const registerFileProcedure = longRunningProcedure', 'export const registerFileProcedure = protectedProcedure'],
]);

// 3) Add automated owner notifications for key pipeline lifecycle events.
let pipeline = fs.readFileSync('server/pipeline-engine.ts', 'utf8');
if (!pipeline.includes('import { notifyOwner } from "./_core/notification";')) {
  pipeline = pipeline.replace('import { storagePut, storageGet } from "./storage";\n', 'import { storagePut, storageGet } from "./storage";\nimport { notifyOwner } from "./_core/notification";\n');
}
if (!pipeline.includes('async function notifyPipelineOwner')) {
  const helper = `\nasync function notifyPipelineOwner(title: string, content: string): Promise<void> {\n  try {\n    await notifyOwner({ title, content });\n  } catch (error) {\n    console.warn(\"[Pipeline] Owner notification failed:\", error);\n  }\n}\n`;
  pipeline = pipeline.replace('\nexport type EventEmitter = (event: PipelineEvent) => void;\n', `${helper}\nexport type EventEmitter = (event: PipelineEvent) => void;\n`);
}
if (!pipeline.includes('Auto Research PDF generated')) {
  pipeline = pipeline.replace('      console.log(`[Pipeline] PDF generated successfully (${(pdfBuffer.length / 1024).toFixed(1)} KiB)`);\n', '      console.log(`[Pipeline] PDF generated successfully (${(pdfBuffer.length / 1024).toFixed(1)} KiB)`);\n      await notifyPipelineOwner("Auto Research PDF generated", `PDF report generated for run ${ctx.runId}: ${ctx.topic}`);\n');
}
if (!pipeline.includes('Auto Research pipeline completed')) {
  pipeline = pipeline.replace('    await db.updatePipelineRun(runId, {\n      status: "completed", currentStage: PIPELINE_STAGES.length, stagesDone: PIPELINE_STAGES.length, completedAt: new Date(),\n    });\n', '    await db.updatePipelineRun(runId, {\n      status: "completed", currentStage: PIPELINE_STAGES.length, stagesDone: PIPELINE_STAGES.length, completedAt: new Date(),\n    });\n    await notifyPipelineOwner("Auto Research pipeline completed", `Run ${runId} completed successfully for topic: ${topic}`);\n');
}
if (!pipeline.includes('Auto Research pipeline error')) {
  pipeline = pipeline.replace('          await db.updatePipelineRun(runId, {\n            status: "failed", currentStage: i, errorMessage: `Stage ${i} (${stageDef.name}) failed: ${errMsg}`,\n          });\n', '          await db.updatePipelineRun(runId, {\n            status: "failed", currentStage: i, errorMessage: `Stage ${i} (${stageDef.name}) failed: ${errMsg}`,\n          });\n          await notifyPipelineOwner("Auto Research pipeline error", `Run ${runId} failed at stage ${i} (${stageDef.name}): ${errMsg}`);\n');
}
fs.writeFileSync('server/pipeline-engine.ts', pipeline);

console.log('integration patch complete');
