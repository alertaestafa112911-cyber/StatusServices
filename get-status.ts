import { createServerFn } from "@tanstack/react-start";
import { buildBoard, type RawFeeds } from "./board";
import type { StatusBoard } from "./types";

const USER_AGENT = "Faro/1.0 (public status reader)";
const TTL_MS = 25_000;

let cache: { at: number; board: StatusBoard } | null = null;

async function readResponse(url: string, timeoutMs: number): Promise<Response> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: "application/json, application/rss+xml, application/xml, text/xml, */*",
      "user-agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function readJson(url: string): Promise<unknown> {
  const response = await readResponse(url, 12_000);
  return response.json();
}

async function readText(url: string): Promise<string> {
  const response = await readResponse(url, 12_000);
  return response.text();
}

async function readAwsEvents(): Promise<unknown> {
  const response = await readResponse("https://status.aws.amazon.com/data.json", 15_000);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let text: string;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = new TextDecoder("utf-16be").decode(bytes);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = new TextDecoder("utf-16le").decode(bytes);
  } else {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

async function attempt<T>(task: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error de red";
    const clean = message.replace(/\s+/g, " ").slice(0, 160);
    return { error: clean || "No se pudo consultar la fuente" };
  }
}

async function loadBoard(): Promise<StatusBoard> {
  const [cloudflare, gcp, workspace, aws, azureXml, m365Xml] = await Promise.all([
    attempt(() => readJson("https://www.cloudflarestatus.com/api/v2/summary.json")),
    attempt(() => readJson("https://status.cloud.google.com/incidents.json")),
    attempt(() => readJson("https://www.google.com/appsstatus/dashboard/incidents.json")),
    attempt(() => readAwsEvents()),
    attempt(() => readText("https://rssfeed.azure.status.microsoft/en-us/status/feed/")),
    attempt(() => readText("https://status.cloud.microsoft/api/feed/mac")),
  ]);
  const raw: RawFeeds = {
    now: new Date().toISOString(),
    cloudflare,
    gcp,
    workspace,
    aws,
    azureXml,
    m365Xml,
  };
  return buildBoard(raw);
}

export const getCloudStatus = createServerFn({ method: "GET" }).handler(async () => {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.board;
  const board = await loadBoard();
  cache = { at: now, board };
  return board;
});
