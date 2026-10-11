import { API_KEY_REVISION_KEY } from "../core/apiSettings";
import { AI_CONFIG } from "../core/config";
import { requestTranslation } from "../core/aiClient";
import {
  clearTranslationCache,
  deleteVideoCache,
  getTranslationCache,
  setTranslationCache,
} from "../core/cache";
import { parseSubtitlePayload } from "../core/subtitleParser";
import type {
  CaptionTrack,
  DebugLogEntry,
  RuntimeMessage,
  SubtitleCue,
  TranslateLine,
  WorkerResponse,
} from "../core/types";

const WORKER_VERSION = "1.20.5";
const storageAccessReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.tab) return sender.url === chrome.runtime.getURL("popup/index.html");
  try {
    return new URL(sender.url ?? "").origin === "https://www.youtube.com";
  } catch {
    return false;
  }
}

type VideoProviderSession = {
  activeProvider: string | null;
  failedProviders: Set<string>;
};

const videoProviderSessions = new Map<string, VideoProviderSession>();
const PROVIDER_SESSION_PREFIX = "aiProviderSession:v1.20.5:";

function providerSessionKey(tabId: number | undefined, videoId: string): string {
  return `${tabId ?? "unknown"}:${videoId}`;
}

async function getVideoProviderSession(
  sessionKey: string,
): Promise<VideoProviderSession> {
  const memorySession = videoProviderSessions.get(sessionKey);
  if (memorySession) return memorySession;

  const storageKey = `${PROVIDER_SESSION_PREFIX}${sessionKey}`;
  const stored = await chrome.storage.session.get(storageKey);
  const value = stored[storageKey] as
    | { activeProvider?: unknown; failedProviders?: unknown }
    | undefined;
  const session: VideoProviderSession = {
    activeProvider:
      typeof value?.activeProvider === "string" ? value.activeProvider : null,
    failedProviders: new Set(
      Array.isArray(value?.failedProviders)
        ? value.failedProviders.filter(
            (provider): provider is string => typeof provider === "string",
          )
        : [],
    ),
  };
  videoProviderSessions.set(sessionKey, session);
  return session;
}

async function saveVideoProviderSession(
  sessionKey: string,
  session: VideoProviderSession,
): Promise<void> {
  videoProviderSessions.set(sessionKey, session);
  await chrome.storage.session.set({
    [`${PROVIDER_SESSION_PREFIX}${sessionKey}`]: {
      activeProvider: session.activeProvider,
      failedProviders: [...session.failedProviders],
    },
  });
}

chrome.runtime.onInstalled.addListener(() => {
  console.info("Smart Subtitles kuruldu.");
  void chrome.storage.session.clear().then(injectIntoExistingYouTubeTabs);
});

const tabInjectionJobs = new Map<number, Promise<void>>();

function isYouTubePage(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === "youtube.com" ||
        parsed.hostname.endsWith(".youtube.com")) &&
      ["http:", "https:"].includes(parsed.protocol)
    );
  } catch {
    return false;
  }
}

async function ensureContentScripts(tabId: number, url?: string): Promise<void> {
  if (!isYouTubePage(url)) return;
  if (tabInjectionJobs.has(tabId)) return tabInjectionJobs.get(tabId);

  const job = (async () => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "GET_EXTENSION_STATE_V2" });
      return;
    } catch {
      await appendDebugLog(
        tabId,
        "warn",
        "worker",
        "Content script alıcısı yok; otomatik enjeksiyon başlıyor",
      );
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["assets/pageBridge.js"],
      world: "MAIN",
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["assets/youtubeContentScript.js"],
      world: "ISOLATED",
    });
    await appendDebugLog(
      tabId,
      "success",
      "worker",
      "Content script otomatik enjekte edildi",
    );
  })().finally(() => tabInjectionJobs.delete(tabId));

  tabInjectionJobs.set(tabId, job);
  return job;
}

async function injectIntoExistingYouTubeTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  await Promise.allSettled(
    tabs.flatMap((tab) =>
      tab.id == null ? [] : [ensureContentScripts(tab.id, tab.url)],
    ),
  );
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void ensureContentScripts(tabId, changeInfo.url ?? tab.url);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then((tab) => ensureContentScripts(tabId, tab.url))
    .catch(() => undefined);
});

const logQueues = new Map<number, Promise<void>>();

function logStorageKey(tabId: number): string {
  return `debugLogs:${tabId}`;
}

async function appendDebugLog(
  tabId: number | undefined,
  level: DebugLogEntry["level"],
  source: DebugLogEntry["source"],
  message: string,
): Promise<void> {
  if (tabId == null) return;
  if (typeof message !== "string" || !message.trim()) return;
  const previous = logQueues.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const key = logStorageKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const logs = Array.isArray(stored[key])
      ? (stored[key] as DebugLogEntry[])
      : [];
    logs.push({ timestamp: Date.now(), level, source, message });
    await chrome.storage.session.set({ [key]: logs.slice(-100) });
  });
  logQueues.set(tabId, next);
  await next;
  if (logQueues.get(tabId) === next) logQueues.delete(tabId);
}

type AndroidCaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  vssId?: string;
  kind?: string;
  isTranslatable?: boolean;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
};

type AndroidPlayerResponse = {
  playabilityStatus?: { status?: string; reason?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: AndroidCaptionTrack[];
    };
  };
};

const playerResponseCache = new Map<
  string,
  { createdAt: number; response: AndroidPlayerResponse }
>();

async function getAndroidPlayerResponse(
  videoId: string,
): Promise<AndroidPlayerResponse> {
  const cached = playerResponseCache.get(videoId);
  if (cached && Date.now() - cached.createdAt < 5 * 60_000) {
    return cached.response;
  }

  const watchResponse = await fetch(
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    { credentials: "omit" },
  );
  if (!watchResponse.ok) {
    throw new Error(`YouTube video bilgisi alınamadı (${watchResponse.status}).`);
  }
  const watchHtml = await watchResponse.text();
  const apiKey = watchHtml.match(
    /"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/,
  )?.[1];
  if (!apiKey) throw new Error("YouTube player API anahtarı bulunamadı.");

  const playerResponse = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({
        context: {
          client: { clientName: "ANDROID", clientVersion: "20.10.38" },
        },
        videoId,
      }),
    },
  );
  if (!playerResponse.ok) {
    throw new Error(`YouTube player yanıtı alınamadı (${playerResponse.status}).`);
  }

  const response = (await playerResponse.json()) as AndroidPlayerResponse;
  if (
    response.playabilityStatus?.status &&
    response.playabilityStatus.status !== "OK"
  ) {
    throw new Error(
      response.playabilityStatus.reason || "YouTube videosu oynatılamıyor.",
    );
  }
  playerResponseCache.set(videoId, { createdAt: Date.now(), response });
  return response;
}

function rawAndroidTracks(response: AndroidPlayerResponse): AndroidCaptionTrack[] {
  return (
    response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  );
}

function captionTrackName(track: AndroidCaptionTrack): string {
  return (
    track.name?.simpleText ??
    track.name?.runs?.map((run) => run.text ?? "").join("") ??
    track.languageCode ??
    "Bilinmeyen dil"
  );
}

async function getCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  const response = await getAndroidPlayerResponse(videoId);
  return rawAndroidTracks(response)
    .filter((track) => track.baseUrl && track.languageCode)
    .map((track, index) => ({
      id:
        track.vssId ??
        `${track.languageCode}:${track.kind === "asr" ? "asr" : "manual"}:${index}`,
      name: captionTrackName(track),
      languageCode: track.languageCode!,
      isAutoGenerated:
        track.kind === "asr" || Boolean(track.vssId?.startsWith("a.")),
      isTranslatable: track.isTranslatable !== false,
      url: track.baseUrl!,
    }));
}

function isAllowedTimedTextUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === "https:" && !url.username && !url.password &&
      (!url.port || url.port === "443") &&
      (url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) &&
      url.pathname === "/api/timedtext";
  } catch {
    return false;
  }
}

async function fetchAndParseCaptionUrl(trackUrl: string): Promise<SubtitleCue[]> {
  if (!isAllowedTimedTextUrl(trackUrl)) throw new Error("Geçersiz altyazı URL’si.");
  const jsonUrl = new URL(trackUrl);
  jsonUrl.searchParams.set("fmt", "json3");
  const response = await fetch(jsonUrl.toString(), { credentials: "omit", redirect: "error" });
  if (!response.ok) {
    throw new Error(`Altyazı indirilemedi (${response.status}).`);
  }
  return parseSubtitlePayload(await response.text());
}

async function fetchCaptions(
  trackUrl: string,
  videoId: string,
  languageCode: string,
  isAutoGenerated: boolean,
  tabId?: number,
): Promise<SubtitleCue[]> {
  try {
    const cues = await fetchAndParseCaptionUrl(trackUrl);
    await appendDebugLog(
      tabId,
      "success",
      "worker",
      `WEB timed-text başarılı: ${cues.length} cue`,
    );
    return cues;
  } catch (error) {
    await appendDebugLog(
      tabId,
      "warn",
      "worker",
      `WEB timed-text kullanılamadı; Android fallback deneniyor (${error instanceof Error ? error.message : "boş yanıt"})`,
    );
    const response = await getAndroidPlayerResponse(videoId);
    const tracks = rawAndroidTracks(response);
    const fallback =
      tracks.find(
        (track) =>
          track.languageCode === languageCode &&
          (track.kind === "asr") === isAutoGenerated,
      ) ?? tracks.find((track) => track.languageCode === languageCode);
    if (!fallback?.baseUrl) {
      throw new Error("Seçilen altyazı track’i yeniden alınamadı.");
    }
    const cues = await fetchAndParseCaptionUrl(fallback.baseUrl);
    await appendDebugLog(
      tabId,
      "success",
      "worker",
      `Android fallback başarılı: ${cues.length} cue`,
    );
    return cues;
  }
}

async function handleMessage(
  message: RuntimeMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  await storageAccessReady;
  if (!isTrustedSender(sender)) throw new Error("İstek kaynağına izin verilmiyor.");
  if (sender.tab && ["TEST_AI_CONNECTION", "GET_DEBUG_LOGS", "CLEAR_DEBUG_LOGS", "GET_STORED_STATE"].includes(message.type)) {
    throw new Error("Bu işlem eklenti penceresinden yapılmalı.");
  }
  const senderTabId = sender.tab?.id;
  switch (message.type) {
    case "TEST_AI_CONNECTION": {
      const result = await requestTranslation(
        [{ id: 1, text: "Good morning." }],
        undefined,
        "fast-start",
      );
      if (result.length !== 1 || !result[0].text.trim()) {
        throw new Error("Gemini test çevirisi eksik döndü.");
      }
      return { model: "gemini-3.1-flash-lite", connected: true };
    }
    case "GET_WORKER_INFO_V2":
      return { version: WORKER_VERSION };
    case "DEBUG_LOG":
      if (message.protocolVersion !== 2) return null;
      await appendDebugLog(
        senderTabId ?? message.tabId,
        message.entry.level,
        message.entry.source,
        message.entry.message,
      );
      return null;
    case "GET_DEBUG_LOGS": {
      const key = logStorageKey(message.tabId);
      const stored = await chrome.storage.session.get(key);
      return Array.isArray(stored[key])
        ? (stored[key] as DebugLogEntry[]).filter(
            (entry) =>
              typeof entry?.message === "string" && Boolean(entry.message.trim()),
          )
        : [];
    }
    case "CLEAR_DEBUG_LOGS":
      await chrome.storage.session.remove(logStorageKey(message.tabId));
      return null;
    case "STATE_UPDATED": {
      if (message.protocolVersion !== 2) return null;
      if (sender.tab?.id == null) return null;
      const state = { ...message.payload, tabId: sender.tab.id };
      await chrome.storage.session.set({ [`tab:${sender.tab.id}`]: state });
      return null;
    }
    case "GET_STORED_STATE": {
      const key = `tab:${message.tabId}`;
      const stored = await chrome.storage.session.get(key);
      return stored[key] ?? null;
    }
    case "GET_CAPTION_TRACKS": {
      await appendDebugLog(senderTabId, "info", "worker", "Android player track listesi isteniyor");
      const tracks = await getCaptionTracks(message.videoId);
      await appendDebugLog(senderTabId, "success", "worker", `${tracks.length} caption track bulundu`);
      return tracks;
    }
    case "FETCH_CAPTIONS": {
      await appendDebugLog(senderTabId, "info", "worker", `${message.languageCode} track verisi indiriliyor`);
      return fetchCaptions(
        message.trackUrl,
        message.videoId,
        message.languageCode,
        message.isAutoGenerated,
        senderTabId,
      );
    }
    case "TRANSLATE_BATCH_V2": {
      if (!Array.isArray(message.lines) || message.lines.length > 160 ||
        !message.lines.every((line) => line && Number.isSafeInteger(line.id) && line.id >= 0 &&
          typeof line.text === "string" && line.text.length <= 20_000) ||
        message.lines.reduce((sum, line) => sum + line.text.length, 0) > 128_000 ||
        typeof message.videoId !== "string" || !/^[a-zA-Z0-9_-]{11}$/.test(message.videoId) ||
        typeof message.runId !== "string" || message.runId.length > 100) {
        throw new Error("Geçersiz çeviri isteği.");
      }
      const credentials = await chrome.storage.local.get(API_KEY_REVISION_KEY);
      const revision = credentials[API_KEY_REVISION_KEY] ?? "default";
      const sessionKey = `${providerSessionKey(senderTabId, message.videoId)}:${revision}:${message.runId}`;
      const providerSession = await getVideoProviderSession(sessionKey);

      const providerCandidates = providerSession.activeProvider
        ? [
            providerSession.activeProvider,
            ...AI_CONFIG.providers
              .map((provider) => provider.name)
              .filter(
                (providerName) =>
                  providerName !== providerSession.activeProvider &&
                  !providerSession.failedProviders.has(providerName),
              ),
          ]
        : undefined;
      await appendDebugLog(senderTabId, "info", "worker",
        providerSession.activeProvider
          ? `Sabit sağlayıcı: ${providerSession.activeProvider} · ${message.lines.length} satır`
          : "Öncelikli sağlayıcı deneniyor");
      let translated: TranslateLine[];
      try {
        translated = await requestTranslation(
          message.lines,
          (event) => {
            const level = event.type === "failure"
              ? "warn"
              : event.type === "success"
                ? "success"
                : "info";
            if (event.type === "failure") {
              providerSession.failedProviders.add(event.provider);
            } else if (event.type === "success") {

              if (
                event.provider === "partial" ||
                event.provider === "batcher"
              ) {

              } else {
                if (providerSession.activeProvider !== event.provider) {
                  void appendDebugLog(
                    senderTabId,
                    "success",
                    "worker",
                    `Bu video için AI sabitlendi: ${event.provider}`,
                  );
                }
                providerSession.activeProvider = event.provider;
              }
            }
            void appendDebugLog(senderTabId, level, "worker", event.message);
          },
          message.strategy ?? "quality",
          providerCandidates,
        );
      } finally {
        await saveVideoProviderSession(sessionKey, providerSession);
      }
      await appendDebugLog(senderTabId, "success", "worker", `AI çevirisi tamamlandı: ${translated.length} satır`);
      return translated;
    }
    case "CACHE_GET": {
      const cache = await getTranslationCache(
        message.videoId,
        message.sourceLanguage,
        message.trackId,
      );
      await appendDebugLog(senderTabId, "info", "worker", cache ? `Cache bulundu: ${cache.cues.length} satır` : "Cache bulunamadı");
      return cache;
    }
    case "CACHE_SET":
      await setTranslationCache(message.cache);
      await appendDebugLog(senderTabId, "info", "worker", `Cache güncellendi: ${message.cache.cues.length} satır`);
      return null;
    case "CACHE_DELETE_VIDEO":
      await deleteVideoCache(message.videoId);
      return null;
    case "CACHE_CLEAR_ALL":
      await clearTranslationCache();
      return null;
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  const workerMessageTypes = new Set([
    "GET_WORKER_INFO_V2",
    "TEST_AI_CONNECTION",
    "STATE_UPDATED",
    "GET_STORED_STATE",
    "DEBUG_LOG",
    "GET_DEBUG_LOGS",
    "CLEAR_DEBUG_LOGS",
    "GET_CAPTION_TRACKS",
    "FETCH_CAPTIONS",
    "TRANSLATE_BATCH_V2",
    "CACHE_GET",
    "CACHE_SET",
    "CACHE_DELETE_VIDEO",
    "CACHE_CLEAR_ALL",
  ]);
  if (!message || typeof message !== "object" || !workerMessageTypes.has(message.type)) return false;

  void handleMessage(message, sender)
    .then((data) => {
      const response: WorkerResponse<unknown> = { ok: true, data };
      sendResponse(response);
    })
    .catch((error: unknown) => {
      void appendDebugLog(
        sender.tab?.id,
        "error",
        "worker",
        error instanceof Error ? error.message : "Beklenmeyen worker hatası",
      );
      const response: WorkerResponse<never> = {
        ok: false,
        error: error instanceof Error ? error.message : "Beklenmeyen bir hata oluştu.",
      };
      sendResponse(response);
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove([`tab:${tabId}`, logStorageKey(tabId)]);
  for (const key of videoProviderSessions.keys()) {
    if (key.startsWith(`${tabId}:`)) videoProviderSessions.delete(key);
  }
  void chrome.storage.session.get(null).then((stored) => {
    const providerKeys = Object.keys(stored).filter((key) =>
      key.startsWith(`${PROVIDER_SESSION_PREFIX}${tabId}:`),
    );
    if (providerKeys.length > 0) {
      return chrome.storage.session.remove(providerKeys);
    }
    return undefined;
  });
});
