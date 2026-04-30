// Preconfigured storage helpers for Manus WebDev templates
// Uses the Biz-provided storage proxy (Authorization: Bearer <token>)

import * as fs from "fs";
import * as path from "path";
import { ENV } from './_core/env';

type StorageConfig = { baseUrl: string; apiKey: string };

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000; // 1s, 2s, 4s exponential backoff
export const DATASET_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB

function getStorageConfig(): StorageConfig {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "Storage proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function buildUploadUrl(baseUrl: string, relKey: string): URL {
  const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

async function buildDownloadUrl(
  baseUrl: string,
  relKey: string,
  apiKey: string
): Promise<string> {
  const downloadApiUrl = new URL(
    "v1/storage/downloadUrl",
    ensureTrailingSlash(baseUrl)
  );
  downloadApiUrl.searchParams.set("path", normalizeKey(relKey));

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      const response = await fetch(downloadApiUrl, {
        method: "GET",
        headers: buildAuthHeaders(apiKey),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text().catch(() => response.statusText);
        lastError = new Error(
          `Storage downloadUrl failed (${response.status} ${response.statusText}): ${body}`
        );
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          console.warn(`[Storage] downloadUrl attempt ${attempt + 1} failed (${response.status}), retrying...`);
          await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      const json = await response.json();
      if (!json.url) {
        throw new Error("Storage downloadUrl returned empty URL");
      }
      return json.url;
    } catch (err: any) {
      lastError = err;
      if (err.name === "AbortError") {
        lastError = new Error("Storage downloadUrl timed out after 30s");
      }
      if (attempt < MAX_RETRIES) {
        console.warn(`[Storage] downloadUrl attempt ${attempt + 1} failed: ${lastError!.message}, retrying...`);
        await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastError || new Error("Storage downloadUrl failed after retries");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

export function buildDatasetMultipartPrefix(uploadId: string): string {
  return `datasets/${uploadId}/parts`;
}

export function buildDatasetMultipartPartKey(uploadId: string, partIndex: number): string {
  return `${buildDatasetMultipartPrefix(uploadId)}/${String(partIndex).padStart(4, "0")}`;
}

export function parseDatasetMultipartUploadId(fileKey: string): string | null {
  const normalized = normalizeKey(fileKey).replace(/\/+$/, "");
  const directMatch = normalized.match(/^datasets\/([^/]+)\/parts$/);
  if (directMatch) return directMatch[1];
  const partMatch = normalized.match(/^datasets\/([^/]+)\/parts\/\d{4}$/);
  return partMatch ? partMatch[1] : null;
}

export function estimateDatasetMultipartChunks(sizeBytes: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 0;
  return Math.ceil(sizeBytes / DATASET_UPLOAD_CHUNK_SIZE);
}

function toFormData(
  data: Buffer | Uint8Array | string,
  contentType: string,
  fileName: string
): FormData {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: contentType })
      : new Blob([data as any], { type: contentType });
  const form = new FormData();
  form.append("file", blob, fileName || "file");
  return form;
}

function buildAuthHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function appendResponseBodyToWriteStream(
  response: Response,
  writeStream: fs.WriteStream,
  partLabel: string,
): Promise<void> {
  if (!response.body) {
    throw new Error(`Storage download returned empty body for ${partLabel}`);
  }
  const { Readable } = await import("stream");
  const readable = Readable.fromWeb(response.body as any);
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => readable.resume();
    const onData = (chunk: Buffer) => {
      const canContinue = writeStream.write(chunk);
      if (!canContinue) readable.pause();
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const cleanup = () => {
      readable.off("data", onData);
      readable.off("end", onEnd);
      readable.off("error", onError);
      writeStream.off("drain", onDrain);
      writeStream.off("error", onError);
    };
    readable.on("data", onData);
    readable.on("end", onEnd);
    readable.on("error", onError);
    writeStream.on("drain", onDrain);
    writeStream.on("error", onError);
  });
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  const uploadUrl = buildUploadUrl(baseUrl, key);
  const fileName = key.split("/").pop() ?? key;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const formData = toFormData(data, contentType, fileName);
      const controller = new AbortController();
      // 5 min timeout for uploads (large files)
      const timeout = setTimeout(() => controller.abort(), 300000);
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: buildAuthHeaders(apiKey),
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const message = await response.text().catch(() => response.statusText);
        lastError = new Error(
          `Storage upload failed (${response.status} ${response.statusText}): ${message}`
        );
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          console.warn(`[Storage] upload attempt ${attempt + 1} failed (${response.status}), retrying...`);
          await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }

      const json = await response.json();
      if (!json.url) {
        throw new Error("Storage upload returned empty URL");
      }
      return { key, url: json.url };
    } catch (err: any) {
      lastError = err;
      if (err.name === "AbortError") {
        lastError = new Error(`Storage upload timed out for ${key}`);
      }
      if (attempt < MAX_RETRIES) {
        console.warn(`[Storage] upload attempt ${attempt + 1} failed: ${lastError!.message}, retrying...`);
        await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastError || new Error("Storage upload failed after retries");
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string; }> {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  return {
    key,
    url: await buildDownloadUrl(baseUrl, key, apiKey),
  };
}

/**
 * Download a file from S3 storage with retry logic and timeout.
 * Returns a Response object for streaming.
 */
export async function storageDownload(
  relKey: string,
  options?: { timeoutMs?: number; rangeHeader?: string }
): Promise<Response> {
  const { url } = await storageGet(relKey);
  const timeoutMs = options?.timeoutMs ?? 120000; // 2 min default

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const headers: Record<string, string> = {};
      if (options?.rangeHeader) headers["Range"] = options.rangeHeader;

      const resp = await fetch(url, { signal: controller.signal, headers });
      clearTimeout(timeout);

      if (!resp.ok) {
        lastError = new Error(`Storage download failed (${resp.status}) for ${relKey}`);
        if (resp.status >= 500 && attempt < MAX_RETRIES) {
          console.warn(`[Storage] download attempt ${attempt + 1} failed (${resp.status}), retrying...`);
          await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
          continue;
        }
        throw lastError;
      }
      return resp;
    } catch (err: any) {
      lastError = err;
      if (err.name === "AbortError") {
        lastError = new Error(`Storage download timed out after ${timeoutMs}ms for ${relKey}`);
      }
      if (attempt < MAX_RETRIES) {
        console.warn(`[Storage] download attempt ${attempt + 1} failed: ${lastError!.message}, retrying...`);
        await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastError || new Error(`Storage download failed after retries for ${relKey}`);
}

export async function storageDownloadDatasetMultipartToFile(params: {
  uploadId: string;
  totalChunks: number;
  destinationPath: string;
  timeoutMsPerPart?: number;
}): Promise<void> {
  const { uploadId, totalChunks, destinationPath, timeoutMsPerPart = 120000 } = params;
  if (totalChunks < 1) {
    throw new Error(`Invalid totalChunks for multipart download: ${totalChunks}`);
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const writeStream = fs.createWriteStream(destinationPath);
  try {
    for (let i = 0; i < totalChunks; i++) {
      const partKey = buildDatasetMultipartPartKey(uploadId, i);
      const resp = await storageDownload(partKey, { timeoutMs: timeoutMsPerPart });
      await appendResponseBodyToWriteStream(resp, writeStream, `part ${i}`);
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
      writeStream.once("error", onError);
      writeStream.end(() => {
        writeStream.off("error", onError);
        resolve();
      });
    });
  } catch (err) {
    writeStream.destroy();
    throw err;
  }
}
