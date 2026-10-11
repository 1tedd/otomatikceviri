import { useEffect, useRef, useState } from "react";
import { readSavedApiKey, saveApiKey } from "../core/apiSettings";
import type {
  DebugLogEntry,
  ExtensionState,
  RuntimeMessage,
  SubtitleSettings,
  WorkerResponse,
} from "../core/types";

const FALLBACK_SETTINGS: SubtitleSettings = {
  enabled: true,
  mode: "translated",
  fontSize: 24,
  position: 10,
  background: true,
};

const EMPTY_STATE: ExtensionState = {
  videoId: null,
  url: "",
  detectedAt: Date.now(),
  status: "idle",
  sourceLanguage: null,
  sourceLabel: null,
  sourceTrackId: null,
  hasManualTurkish: false,
  progress: 0,
  total: 0,
  error: null,
  settings: FALLBACK_SETTINGS,
};

const BUILD_VERSION = "1.20.5";

function isYouTubeUrl(urlString?: string): boolean {
  if (!urlString) return false;
  try {
    const hostname = new URL(urlString).hostname;
    return hostname === "youtube.com" || hostname.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function statusContent(state: ExtensionState, isYouTube: boolean) {
  if (!isYouTube) {
    return ["YouTube açık değil", "Bir YouTube videosu açıp tekrar dene."];
  }

  switch (state.status) {
    case "detecting":
      return ["Altyazılar aranıyor", "YouTube caption track bilgisi okunuyor."];
    case "loading-captions":
      return ["Altyazılar alınıyor", "Zaman kodları hazırlanıyor."];
    case "translating":
      return [
        `Çevriliyor: ${state.progress} / ${state.total}`,
        "Hazır satırlar videoda gösterilmeye başladı.",
      ];
    case "ready":
      return ["Türkçe altyazı hazır", `${state.total} satır kullanıma hazır.`];
    case "already-turkish":
      return ["Zaten Türkçe", "Türkçe videolarda çeviri yapılmıyor."];
    case "no-tracks":
      return ["Altyazı bulunamadı", "Bu videoda çevrilecek caption track yok."];
    case "no-video":
      return ["Video bulunamadı", "Bir YouTube videosu açıp tekrar dene."];
    case "error":
      return ["İşlem durdu", state.error || "Beklenmeyen bir hata oluştu."];
    default:
      return ["Hazırlanıyor", "Video durumu okunuyor."];
  }
}

function formatLogTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

async function injectContentScripts(tabId: number): Promise<void> {
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
}

export function Popup() {
  const [state, setState] = useState<ExtensionState>(EMPTY_STATE);
  const [tabId, setTabId] = useState<number | null>(null);
  const [isYouTube, setIsYouTube] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(true);
  const [connectionLog, setConnectionLog] = useState<DebugLogEntry>({
    timestamp: Date.now(),
    level: "info",
    source: "popup",
    message: "Content script bağlantısı bekleniyor",
  });
  const logBodyRef = useRef<HTMLDivElement>(null);
  const injectionAttemptsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    void readSavedApiKey()
      .then((key) => setApiKeySaved(Boolean(key)))
      .catch(() => setApiKeyError("Kayıtlı anahtar okunamadı."));
  }, []);

  useEffect(() => {
    if (logBodyRef.current) {
      logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }
  }, [logs, logsOpen]);

  useEffect(() => {
    let active = true;
    let intervalId: number | null = null;

    if (
      globalThis.chrome?.runtime?.getManifest().version !== BUILD_VERSION
    ) {
      chrome.runtime.reload();
      return () => {
        active = false;
      };
    }

    async function ensureCurrentWorker(): Promise<boolean> {
      try {
        const response = (await chrome.runtime.sendMessage({
          type: "GET_WORKER_INFO_V2",
        } satisfies RuntimeMessage)) as WorkerResponse<{ version: string }>;
        if (response?.ok && response.data?.version === BUILD_VERSION) {
          return true;
        }
      } catch {

      }
      chrome.runtime.reload();
      return false;
    }

    async function refreshState() {
      if (!globalThis.chrome?.tabs) {
        if (active) {
          setIsYouTube(false);
          setConnectionLog({
            timestamp: Date.now(),
            level: "warn",
            source: "popup",
            message: "Chrome extension API bulunamadı",
          });
        }
        return;
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active) return;
      const youtube = isYouTubeUrl(tab?.url);
      setIsYouTube(youtube);
      setTabId(tab?.id ?? null);
      if (!youtube || tab?.id == null) {
        setConnectionLog({
          timestamp: Date.now(),
          level: "warn",
          source: "popup",
          message: youtube ? "Aktif sekme ID'si alınamadı" : "Aktif sekme YouTube değil",
        });
        return;
      }

      try {
        const response = (await chrome.tabs.sendMessage(tab.id, {
          type: "GET_EXTENSION_STATE_V2",
        } satisfies RuntimeMessage)) as ExtensionState;
        if (active && response?.settings) {
          setState(response);
          setConnectionLog((current) =>
            current.level === "success"
              ? current
              : {
                  timestamp: Date.now(),
                  level: "success",
                  source: "popup",
                  message: "Content script bağlantısı aktif",
                },
          );
        }
      } catch (contentError) {
        let contentErrorMessage =
          contentError instanceof Error
            ? contentError.message
            : "Content script yanıt vermedi";

        if (!injectionAttemptsRef.current.has(tab.id)) {
          injectionAttemptsRef.current.add(tab.id);
          if (active) {
            setConnectionLog({
              timestamp: Date.now(),
              level: "warn",
              source: "popup",
              message: "Content script eksik; otomatik yükleniyor",
            });
          }
          try {
            await injectContentScripts(tab.id);
            const injectedState = (await chrome.tabs.sendMessage(tab.id, {
              type: "GET_EXTENSION_STATE_V2",
            } satisfies RuntimeMessage)) as ExtensionState;
            if (active && injectedState?.settings) {
              setState(injectedState);
              setConnectionLog({
                timestamp: Date.now(),
                level: "success",
                source: "popup",
                message: "Content script otomatik yüklendi; bağlantı aktif",
              });
            }
            return;
          } catch (injectionError) {
            contentErrorMessage =
              injectionError instanceof Error
                ? `Otomatik yükleme başarısız: ${injectionError.message}`
                : "Content script otomatik yüklenemedi";
          }
        }

        if (active) {
          setConnectionLog((current) =>
            current.message === contentErrorMessage
              ? current
              : {
                  timestamp: Date.now(),
                  level: "error",
                  source: "popup",
                  message: contentErrorMessage,
                },
          );
        }
        try {
          const stored = (await chrome.runtime.sendMessage({
            type: "GET_STORED_STATE",
            tabId: tab.id,
          } satisfies RuntimeMessage)) as WorkerResponse<ExtensionState | null>;
          if (active && stored?.ok && stored.data) setState(stored.data);
        } catch {

        }
      }

      try {
        const logResponse = (await chrome.runtime.sendMessage({
          type: "GET_DEBUG_LOGS",
          tabId: tab.id,
        } satisfies RuntimeMessage)) as WorkerResponse<DebugLogEntry[]>;
        if (active && logResponse?.ok) setLogs(logResponse.data);
      } catch {

      }
    }

    void ensureCurrentWorker().then((ready) => {
      if (!active || !ready) return;
      void refreshState();
      intervalId = window.setInterval(refreshState, 750);
    });
    return () => {
      active = false;
      if (intervalId != null) window.clearInterval(intervalId);
    };
  }, []);

  async function sendToContent(message: RuntimeMessage): Promise<unknown> {
    if (tabId == null) return null;
    setActionError(null);
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      setActionError("YouTube sekmesini yenileyip tekrar dene.");
      return null;
    }
  }

  function updateSettings(patch: Partial<SubtitleSettings>) {
    const nextSettings = { ...state.settings, ...patch };
    setState((current) => ({ ...current, settings: nextSettings }));
    void sendToContent({ type: "UPDATE_SETTINGS", payload: patch });
  }

  async function runAction(message: RuntimeMessage) {
    await sendToContent(message);
  }

  async function clearLogs() {
    if (tabId == null) return;
    try {
      await chrome.runtime.sendMessage({
        type: "CLEAR_DEBUG_LOGS",
        tabId,
      } satisfies RuntimeMessage);
      setLogs([]);
      setConnectionLog({
        timestamp: Date.now(),
        level: "info",
        source: "popup",
        message: "Log kayıtları temizlendi",
      });
    } catch {
      setActionError("Log kayıtları temizlenemedi.");
    }
  }

  async function connectGemini() {
    setApiKeySaving(true);
    setApiKeyError(null);
    try {
      await saveApiKey(apiKeyInput);
      const response = (await chrome.runtime.sendMessage({
        type: "TEST_AI_CONNECTION",
      } satisfies RuntimeMessage)) as WorkerResponse<{ connected: boolean }>;
      if (!response?.ok || !response.data.connected) {
        throw new Error(response?.ok ? "Gemini yanıt vermedi." : response?.error);
      }
      setApiKeySaved(true);
      setApiKeyInput("");
    } catch (error) {
      setApiKeyError(error instanceof Error ? error.message : "Gemini bağlantısı kurulamadı.");
    } finally {
      setApiKeySaving(false);
    }
  }

  const copy = statusContent(state, isYouTube);
  const busy = ["detecting", "loading-captions", "translating"].includes(
    state.status,
  );
  const controlsDisabled = !isYouTube || !state.videoId || state.hasManualTurkish;
  const progressPercent = state.total
    ? Math.min(100, (state.progress / state.total) * 100)
    : 0;

  return (
    <main className="popup-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">SS</div>
        <div>
          <p className="eyebrow">Smart Subtitles</p>
          <h1>Türkçe altyazı</h1>
        </div>
          <span className="version-pill">
            v{globalThis.chrome?.runtime?.getManifest().version ?? BUILD_VERSION}
          </span>
      </header>

      <section className="status-panel" aria-live="polite">
        <span className={`status-dot status-dot--${state.status}`} />
        <div className="status-copy">
          <h2>{copy[0]}</h2>
          <p>{copy[1]}</p>
          {(busy || state.status === "ready") && state.total > 0 && (
            <div className="progress-track" aria-label={`İlerleme yüzde ${Math.round(progressPercent)}`}>
              <span style={{ width: `${progressPercent}%` }} />
            </div>
          )}
        </div>
      </section>

      <section className="api-settings">
        <strong>Google AI Studio · Gemini Flash-Lite</strong>
        <p>{apiKeySaved ? "Öncelik 3.1 Flash-Lite; kota dolarsa 3.5 Flash-Lite otomatik devralır." : "Çeviriyi başlatmak için Google AI Studio API anahtarını kaydet."}</p>
        <label htmlFor="gemini-api-key">API anahtarı</label>
        <div className="api-key-row">
          <input
            id="gemini-api-key"
            type="password"
            autoComplete="off"
            value={apiKeyInput}
            placeholder={apiKeySaved ? "Anahtarı değiştirmek için yapıştır" : "AI Studio anahtarını yapıştır"}
            onChange={(event) => setApiKeyInput(event.target.value)}
          />
          <button type="button" disabled={!apiKeyInput.trim() || apiKeySaving} onClick={() => void connectGemini()}>
            {apiKeySaving ? "Deneniyor" : "Kaydet"}
          </button>
        </div>
        {apiKeyError && <p className="action-error">{apiKeyError}</p>}
        <p>Altyazı metni çeviri için Google'a gönderilir. Anahtar bu cihazdaki eklentide saklanır.</p>
      </section>

      <section className="debug-panel">
        <div className="debug-header">
          <div className="debug-title">
            <span className="live-indicator" />
            <strong>Canlı log</strong>
            <small>{logs.length}</small>
          </div>
          <div className="debug-actions">
            <button type="button" onClick={() => void clearLogs()}>Temizle</button>
            <button type="button" onClick={() => setLogsOpen((open) => !open)}>
              {logsOpen ? "Daralt" : "Aç"}
            </button>
          </div>
        </div>
        {logsOpen && (
          <div className="debug-body" ref={logBodyRef} aria-live="polite">
            <div className={`log-row log-row--${connectionLog.level}`}>
              <time>{formatLogTime(connectionLog.timestamp)}</time>
              <b>POPUP</b>
              <span>{connectionLog.message}</span>
            </div>
            {logs.length === 0 ? (
              <p className="empty-log">Henüz content/worker logu yok.</p>
            ) : (
              logs.map((log, index) => (
                <div
                  className={`log-row log-row--${log.level}`}
                  key={`${log.timestamp}:${index}`}
                >
                  <time>{formatLogTime(log.timestamp)}</time>
                  <b>{log.source === "content" ? "CONTENT" : "WORKER"}</b>
                  <span>{log.message}</span>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      <dl className="details">
        <div><dt>Video ID</dt><dd>{state.videoId ?? "—"}</dd></div>
        <div><dt>Kaynak</dt><dd>{state.sourceLabel ?? (state.videoId ? "Taranıyor" : "—")}</dd></div>
        <div><dt>Hedef</dt><dd>Türkçe</dd></div>
      </dl>

      <section className="glass-controls" aria-disabled={controlsDisabled}>
        <label className="switch-row">
          <span>
            <strong>Türkçe altyazı</strong>
            <small>Video üzerindeki özel katman</small>
          </span>
          <input
            type="checkbox"
            checked={state.settings.enabled}
            disabled={controlsDisabled}
            onChange={(event) => updateSettings({ enabled: event.target.checked })}
          />
          <span className="switch-visual" aria-hidden="true" />
        </label>

        <div className="control-group">
          <span className="control-label">Görünüm</span>
          <div className="segmented">
            <button
              type="button"
              className={state.settings.mode === "translated" ? "active" : ""}
              disabled={controlsDisabled}
              onClick={() => updateSettings({ mode: "translated" })}
            >
              Sadece Türkçe
            </button>
            <button
              type="button"
              className={state.settings.mode === "dual" ? "active" : ""}
              disabled={controlsDisabled}
              onClick={() => updateSettings({ mode: "dual" })}
            >
              Kaynak + Türkçe
            </button>
          </div>
        </div>

        <label className="range-row">
          <span>Boyut <b>{state.settings.fontSize} px</b></span>
          <input
            type="range"
            min="16"
            max="40"
            value={state.settings.fontSize}
            disabled={controlsDisabled}
            onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })}
          />
        </label>

        <label className="range-row">
          <span>Konum <b>%{state.settings.position}</b></span>
          <input
            type="range"
            min="5"
            max="35"
            value={state.settings.position}
            disabled={controlsDisabled}
            onChange={(event) => updateSettings({ position: Number(event.target.value) })}
          />
        </label>

        <label className="compact-check">
          <input
            type="checkbox"
            checked={state.settings.background}
            disabled={controlsDisabled}
            onChange={(event) => updateSettings({ background: event.target.checked })}
          />
          Koyu altyazı zemini
        </label>
      </section>

      <div className="actions">
        <button
          type="button"
          disabled={!state.videoId || busy}
          onClick={() => void runAction({ type: "RETRANSLATE" })}
        >
          Yeniden çevir
        </button>
        <button
          type="button"
          disabled={!state.videoId || busy}
          onClick={() => void runAction({ type: "CLEAR_VIDEO_CACHE" })}
        >
          Video cache’ini temizle
        </button>
        <button
          type="button"
          className="text-action"
          onClick={() => void runAction({ type: "CLEAR_ALL_CACHE" })}
        >
          Tüm cache’i temizle
        </button>
      </div>

      {actionError && <p className="action-error">{actionError}</p>}
      <footer><span className="footer-line" />Chrome · Brave · Manifest V3</footer>
    </main>
  );
}
