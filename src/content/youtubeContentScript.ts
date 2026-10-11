import type {
  ExtensionState,
  CaptionBridgePayload,
  CaptionTrack,
  DebugLogEntry,
  RuntimeMessage,
  SubtitleCue,
  SubtitleSettings,
  TranslatedSubtitleCue,
  TranslateLine,
  TranslationCache,
  WorkerResponse,
} from "../core/types";
import { createSubtitleBatches } from "../core/subtitleBatcher";
import { SubtitleOverlay } from "./subtitleOverlay";
import { getYouTubeVideoId, observeYouTubeVideo } from "./videoObserver";
import {
  requestCaptionPayload,
  requestCaptionTracks,
  selectCaptionTrack,
} from "./youtubeCaptions";

declare global {
  interface Window {
    __smartSubtitlesContentLoaded?: boolean;
    __smartSubtitlesContentRuntime?: {
      version: string;
      dispose: () => void;
    };
  }
}

window.__smartSubtitlesContentRuntime?.dispose();
window.__smartSubtitlesContentLoaded = true;

const DEFAULT_SETTINGS: SubtitleSettings = {
  enabled: true,
  mode: "translated",
  fontSize: 24,
  position: 10,
  background: true,
};

function sanitizeSettings(value: Partial<SubtitleSettings> | undefined): SubtitleSettings {
  return {
    enabled: value?.enabled ?? DEFAULT_SETTINGS.enabled,
    mode: value?.mode === "dual" ? "dual" : "translated",
    fontSize: Math.min(40, Math.max(16, Number(value?.fontSize) || 24)),
    position: Math.min(35, Math.max(5, Number(value?.position) || 10)),
    background: value?.background ?? DEFAULT_SETTINGS.background,
  };
}

let settings = DEFAULT_SETTINGS;
let currentState: ExtensionState = {
  videoId: getYouTubeVideoId(),
  url: window.location.href,
  detectedAt: Date.now(),
  status: "idle",
  sourceLanguage: null,
  sourceLabel: null,
  sourceTrackId: null,
  hasManualTurkish: false,
  progress: 0,
  total: 0,
  error: null,
  settings,
};
let activeRun = 0;

function debug(
  level: DebugLogEntry["level"],
  message: string,
): void {
  const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "info";
  console[consoleMethod](`[Smart Subtitles] ${message}`);
  const runtimeMessage: RuntimeMessage = {
    type: "DEBUG_LOG",
    protocolVersion: 2,
    entry: { timestamp: Date.now(), level, source: "content", message },
  };
  void chrome.runtime.sendMessage(runtimeMessage).catch(() => undefined);
}

debug("info", `Content script başladı · ${window.location.pathname}`);

const settingsReady = chrome.storage.sync
  .get("subtitleSettings")
  .then((stored) => {
    settings = sanitizeSettings(stored.subtitleSettings as Partial<SubtitleSettings>);
    currentState = { ...currentState, settings };
    debug("success", "Kullanıcı ayarları yüklendi");
  })
  .catch((error: unknown) => {
    debug(
      "warn",
      `Ayarlar okunamadı; varsayılanlar kullanılacak (${error instanceof Error ? error.message : "storage hatası"})`,
    );
  });

const overlay = new SubtitleOverlay(settings, debug);
void settingsReady.then(() => overlay.updateSettings(settings));

function updateState(patch: Partial<ExtensionState>) {
  currentState = {
    ...currentState,
    ...patch,
    settings,
  };
  const message: RuntimeMessage = {
    type: "STATE_UPDATED",
    protocolVersion: 2,
    payload: currentState,
  };
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

async function sendToWorker<T>(message: RuntimeMessage): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as WorkerResponse<T>;
  if (!response?.ok) {
    throw new Error(response?.error || "Arka plan servisine ulaşılamadı.");
  }
  return response.data;
}

function translatedFromBatch(
  sourceById: Map<number, SubtitleCue>,
  lines: TranslateLine[],
): TranslatedSubtitleCue[] {
  return lines.flatMap((line) => {
    const source = sourceById.get(line.id);
    return source ? [{ ...source, translatedText: line.text }] : [];
  });
}

async function saveCurrentCache(
  videoId: string,
  sourceLanguage: string,
  trackId: string,
  cues: TranslatedSubtitleCue[],
) {
  const cache: TranslationCache = {
    videoId,
    sourceLanguage,
    targetLanguage: "tr",
    trackId,
    createdAt: Date.now(),
    cues,
  };
  await sendToWorker<null>({ type: "CACHE_SET", cache });
}

async function processVideo(
  videoId: string | null,
  url: string,
  detectedAt = Date.now(),
) {
  const run = ++activeRun;
  const runId = crypto.randomUUID();
  overlay.clear();
  debug(
    "info",
    videoId
      ? `Video algılandı: ${videoId}`
      : `Bu sayfada video ID bulunamadı · ${new URL(url).pathname}${new URL(url).search}`,
  );
  await settingsReady;
  if (run !== activeRun) return;

  let sourceCues: SubtitleCue[] = [];
  let runTranslatedCues: TranslatedSubtitleCue[] = [];

  updateState({
    videoId,
    url,
    detectedAt,
    status: videoId ? "detecting" : "no-video",
    sourceLanguage: null,
    sourceLabel: null,
    sourceTrackId: null,
    hasManualTurkish: false,
    progress: 0,
    total: 0,
    error: null,
  });

  if (!videoId) return;

  try {
    debug("info", "Caption bridge yanıtı bekleniyor");
    let bridgePayload: CaptionBridgePayload;
    try {
      bridgePayload = await requestCaptionTracks(videoId);
    } catch (bridgeError) {
      debug(
        "warn",
        `Caption bridge zaman aşımı; worker track fallback kullanılacak (${bridgeError instanceof Error ? bridgeError.message : "bilinmeyen hata"})`,
      );
      bridgePayload = { videoId, tracks: [] as CaptionTrack[] };
    }
    if (run !== activeRun) return;
    debug(
      bridgePayload.tracks.length > 0 ? "success" : "warn",
      `Page bridge ${bridgePayload.tracks.length} track döndürdü`,
    );

    const availableTracks = bridgePayload.tracks.length > 0
      ? bridgePayload.tracks
      : await sendToWorker<CaptionTrack[]>({ type: "GET_CAPTION_TRACKS", videoId });
    if (run !== activeRun) return;
    debug("info", `Seçim için ${availableTracks.length} track hazır`);
    const selection = selectCaptionTrack(availableTracks);
    if (selection.kind === "none") {
      debug("warn", "Çevrilecek caption track bulunamadı");
      updateState({ status: "no-tracks" });
      return;
    }

    const track = selection.track;
    const sourceLabel = `${track.name}${
      track.isAutoGenerated ? " · otomatik" : " · manuel"
    }`;
    debug(
      "success",
      `Track seçildi: ${track.languageCode} · ${track.isAutoGenerated ? "otomatik" : "manuel"}`,
    );
    updateState({
      sourceLanguage: track.languageCode,
      sourceLabel,
      sourceTrackId: track.id,
      hasManualTurkish: selection.kind === "already-turkish",
    });

    if (selection.kind === "already-turkish") {
      debug(
        "info",
        `Türkçe ${track.isAutoGenerated ? "otomatik" : "manuel"} track mevcut; çeviri atlandı`,
      );
      updateState({ status: "already-turkish" });
      return;
    }

    updateState({ status: "loading-captions" });
    debug("info", "Timestamp verisi isteniyor");
    try {
      const pageResult = await requestCaptionPayload(track, videoId);
      if (run !== activeRun) return;
      sourceCues = pageResult.cues;
      debug(
        "success",
        `Sayfa caption yolu başarılı: ${pageResult.transport === "page-android" ? "Android fallback" : "WEB"}`,
      );
    } catch (pageError) {
      debug(
        "warn",
        `Sayfa caption yolu başarısız; worker deneniyor (${pageError instanceof Error ? pageError.message : "bilinmeyen hata"})`,
      );
      const workerCues = await sendToWorker<SubtitleCue[]>({
        type: "FETCH_CAPTIONS",
        trackUrl: track.url,
        videoId,
        languageCode: track.languageCode,
        isAutoGenerated: track.isAutoGenerated,
      });
      if (run !== activeRun) return;
      sourceCues = workerCues;
    }
    if (sourceCues.length === 0) {
      throw new Error("Altyazı satırları boş geldi.");
    }
    overlay.setSourceCues(sourceCues);
    debug("success", `${sourceCues.length} subtitle cue parse edildi`);

    const cached = await sendToWorker<TranslationCache | null>({
      type: "CACHE_GET",
      videoId,
      sourceLanguage: track.languageCode,
      trackId: track.id,
    });
    if (run !== activeRun) return;

    const sourceById = new Map(sourceCues.map((cue) => [cue.id, cue]));
    const translatedById = new Map<number, TranslatedSubtitleCue>();
    for (const cue of cached?.cues ?? []) {
      if (sourceById.has(cue.id) && cue.text === sourceById.get(cue.id)!.text && cue.translatedText) {
        translatedById.set(cue.id, { ...sourceById.get(cue.id)!, translatedText: cue.translatedText });
      }
    }

    runTranslatedCues = [...translatedById.values()].sort((a, b) => a.id - b.id);
    debug(
      "info",
      runTranslatedCues.length > 0
        ? `Cache'den ${runTranslatedCues.length} çevrilmiş satır yüklendi`
        : "Çeviri cache'i boş; API akışı başlayacak",
    );
    overlay.setCues(runTranslatedCues);
    updateState({
      status:
        runTranslatedCues.length >= sourceCues.length ? "ready" : "translating",
      progress: runTranslatedCues.length,
      total: sourceCues.length,
    });

    if (runTranslatedCues.length >= sourceCues.length) {
      debug("success", "Tüm çeviri cache'den hazırlandı");
      return;
    }

    const playhead = document.querySelector<HTMLVideoElement>(".html5-video-player video")?.currentTime ?? 0;
    const missingCues = sourceCues.filter((cue) => !translatedById.has(cue.id));
    const missingLines = [
      ...missingCues.filter((cue) => cue.end > playhead),
      ...missingCues.filter((cue) => cue.end <= playhead),
    ]
      .map((cue) => ({ id: cue.id, text: cue.text }));
    const firstBatchSize = Math.min(20, missingLines.length);
    const batches = [
      missingLines.slice(0, firstBatchSize),
      ...createSubtitleBatches(missingLines.slice(firstBatchSize), 80),
    ].filter((batch) => batch.length > 0);
    debug(
      "info",
      `Çeviri ${batches.length} parçada başlıyor: ${missingLines.length} satır`,
    );

    for (const [batchIndex, batch] of batches.entries()) {
      if (run !== activeRun) return;
      debug(
        "info",
        `Parça ${batchIndex + 1}/${batches.length} gönderiliyor: ${batch.length} satır`,
      );

      const strategy =
        batchIndex === 0 && batch.length <= 20 ? "fast-start" : "quality";
      const translatedLines = await sendToWorker<TranslateLine[]>({
        type: "TRANSLATE_BATCH_V2",
        runId,
        lines: batch,
        videoId,
        strategy,
      });
      if (run !== activeRun) return;

      for (const cue of translatedFromBatch(sourceById, translatedLines)) {
        translatedById.set(cue.id, cue);
      }
      runTranslatedCues = [...translatedById.values()].sort(
        (a, b) => a.id - b.id,
      );
      overlay.setCues(runTranslatedCues);

      const allReady = runTranslatedCues.length >= sourceCues.length;
      updateState({
        status: allReady ? "ready" : "translating",
        progress: runTranslatedCues.length,
        total: sourceCues.length,
      });
      await saveCurrentCache(
        videoId,
        track.languageCode,
        track.id,
        runTranslatedCues,
      );
      if (run !== activeRun) return;
      debug(
        "success",
        `Parça ${batchIndex + 1}/${batches.length} hazır · toplam ${runTranslatedCues.length}/${sourceCues.length}`,
      );
    }

    if (runTranslatedCues.length < sourceCues.length) {
      const stillMissing = sourceCues.length - runTranslatedCues.length;
      debug(
        "warn",
        `Çeviri kısmi kaldı: ${runTranslatedCues.length}/${sourceCues.length} (${stillMissing} satır eksik)`,
      );
      updateState({
        status: runTranslatedCues.length > 0 ? "ready" : "error",
        progress: runTranslatedCues.length,
        total: sourceCues.length,
        error:
          runTranslatedCues.length > 0
            ? null
            : `${stillMissing} satır çevrilemedi.`,
      });
      return;
    }

    debug("success", `Çeviri tamamlandı: ${runTranslatedCues.length} satır`);
  } catch (error) {
    if (run !== activeRun) return;
    const message =
      error instanceof Error ? error.message : "Beklenmeyen bir hata oluştu.";

    if (runTranslatedCues.length > 0) {
      debug("warn", `Çeviri yarıda kaldı ama ${runTranslatedCues.length} satır korundu: ${message}`);
      overlay.setCues(runTranslatedCues);
      updateState({
        status: "ready",
        progress: runTranslatedCues.length,
        total: Math.max(currentState.total, runTranslatedCues.length),
        error: null,
      });
      return;
    }
    debug("error", message);
    updateState({
      status: "error",
      error: message,
    });
  }
}

const stopVideoObserver = observeYouTubeVideo(
  (videoState) => {
    debug("info", `Navigasyon olayı: ${videoState.videoId ?? "video yok"}`);
    void processVideo(videoState.videoId, videoState.url, videoState.detectedAt);
  },
  () => {
    activeRun += 1;
    overlay.clear();
    debug("info", "Video geçişi başladı; önceki altyazı işi iptal edildi");
    updateState({
      status: "detecting",
      progress: 0,
      total: 0,
      error: null,
    });
  },
);

const handleRuntimeMessage = (
  (
    message: RuntimeMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ) => {
    if (message.type === "GET_EXTENSION_STATE_V2") {
      sendResponse(currentState);
      return false;
    }

    if (message.type === "UPDATE_SETTINGS") {
      void (async () => {
        settings = sanitizeSettings({ ...settings, ...message.payload });
        await chrome.storage.sync.set({ subtitleSettings: settings });
        overlay.updateSettings(settings);
        updateState({ settings });
        sendResponse(currentState);
      })();
      return true;
    }

    if (message.type === "CLEAR_VIDEO_CACHE") {
      void (async () => {
        if (currentState.videoId) {
          await sendToWorker<null>({
            type: "CACHE_DELETE_VIDEO",
            videoId: currentState.videoId,
          });
        }
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (message.type === "CLEAR_ALL_CACHE") {
      void sendToWorker<null>({ type: "CACHE_CLEAR_ALL" }).then(() =>
        sendResponse({ ok: true }),
      );
      return true;
    }

    if (message.type === "RETRANSLATE") {
      void (async () => {
        if (currentState.videoId) {
          await sendToWorker<null>({
            type: "CACHE_DELETE_VIDEO",
            videoId: currentState.videoId,
          });
          void processVideo(
            currentState.videoId,
            currentState.url,
            Date.now(),
          );
        }
        sendResponse({ ok: true });
      })();
      return true;
    }

    return false;
  }
);

chrome.runtime.onMessage.addListener(handleRuntimeMessage);

window.__smartSubtitlesContentRuntime = {
  version: "1.20.5",
  dispose: () => {
    activeRun += 1;
    stopVideoObserver();
    overlay.destroy();
    chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
  },
};
