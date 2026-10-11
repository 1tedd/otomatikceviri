import type {
  SubtitleCue,
  SubtitleSettings,
  TranslatedSubtitleCue,
} from "../core/types";

const STYLE_ID = "smart-subtitles-overlay-style";
const ROOT_ID = "smart-subtitles-overlay";

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      --smart-subtitle-size: 24px;
      position: absolute;
      z-index: 70;
      right: 5%;
      bottom: 10%;
      left: 5%;
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      pointer-events: none;
      text-align: center;
      font-family: Roboto, Arial, sans-serif;
      line-height: 1.28;
      transform: translateZ(0);
    }
    #${ROOT_ID}[data-visible="true"] { display: flex; }
    #${ROOT_ID} .smart-subtitles-line {
      max-width: min(92%, 1100px);
      padding: 0.12em 0.32em;
      color: #fff;
      font-size: var(--smart-subtitle-size);
      font-weight: 600;
      letter-spacing: 0.005em;
      text-shadow:
        -1px -1px 0 #000,
        1px -1px 0 #000,
        -1px 1px 0 #000,
        1px 1px 0 #000,
        0 2px 5px rgb(0 0 0 / 88%);
      white-space: pre-wrap;
    }
    #${ROOT_ID}[data-background="true"] .smart-subtitles-line {
      border-radius: 4px;
      background: rgb(0 0 0 / 68%);
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    #${ROOT_ID} .smart-subtitles-source {
      color: #e1e4e2;
      font-size: calc(var(--smart-subtitle-size) * 0.72);
      font-weight: 500;
      opacity: 0.92;
    }
    .ytp-player-minimized #${ROOT_ID} { display: none !important; }
  `;
  document.documentElement.append(style);
}

const cueEndIndexes = new WeakMap<object, number[]>();

function findActiveCue<T extends { id: number; start: number; end: number }>(
  cues: T[],
  currentTime: number,
): T | null {
  let low = 0;
  let high = cues.length - 1;
  let candidate: T | null = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle];
    if (cue.start <= currentTime) {
      candidate = cue;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (candidate && currentTime < candidate.end) return candidate;
  let ends = cueEndIndexes.get(cues);
  if (!ends) {
    let maximum = -Infinity;
    ends = cues.map((cue) => (maximum = Math.max(maximum, cue.end)));
    cueEndIndexes.set(cues, ends);
  }
  for (let index = high; index >= 0 && ends[index] > currentTime; index -= 1) {
    if (currentTime < cues[index].end) return cues[index];
  }
  return null;
}

export class SubtitleOverlay {
  private root: HTMLDivElement | null = null;
  private sourceLine: HTMLDivElement | null = null;
  private translatedLine: HTMLDivElement | null = null;
  private sourceCues: SubtitleCue[] = [];
  private cues: TranslatedSubtitleCue[] = [];
  private settings: SubtitleSettings;
  private animationFrame = 0;
  private lastCueId: number | null = null;
  private reportedMissingPlayer = false;
  private reportedVisibleCue = false;
  private readonly report?: (
    level: "info" | "warn" | "error" | "success",
    message: string,
  ) => void;

  constructor(
    settings: SubtitleSettings,
    report?: (
      level: "info" | "warn" | "error" | "success",
      message: string,
    ) => void,
  ) {
    this.settings = settings;
    this.report = report;
    installStyles();
    this.tick = this.tick.bind(this);
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  updateSettings(settings: SubtitleSettings) {
    this.settings = settings;
    this.applySettings();
    this.lastCueId = null;
  }

  setCues(cues: TranslatedSubtitleCue[]) {
    this.cues = [...cues].sort((left, right) => left.start - right.start);
    this.lastCueId = null;
    this.report?.("info", `Overlay cue listesi güncellendi: ${cues.length} satır`);
  }

  setSourceCues(cues: SubtitleCue[]) {
    this.sourceCues = [...cues].sort((left, right) => left.start - right.start);
    this.lastCueId = null;
  }

  clear() {
    this.sourceCues = [];
    this.cues = [];
    this.lastCueId = null;
    this.reportedVisibleCue = false;
    if (this.root) this.root.dataset.visible = "false";
  }

  private ensureRoot(): HTMLDivElement | null {
    const player = document.querySelector<HTMLElement>(".html5-video-player");
    if (!player) {
      if (!this.reportedMissingPlayer) {
        this.reportedMissingPlayer = true;
        this.report?.("warn", "Overlay için YouTube player elementi henüz bulunamadı");
      }
      return null;
    }
    this.reportedMissingPlayer = false;

    if (!this.root) {
      this.root = document.createElement("div");
      this.root.id = ROOT_ID;
      this.root.setAttribute("aria-live", "off");

      this.sourceLine = document.createElement("div");
      this.sourceLine.className = "smart-subtitles-line smart-subtitles-source";
      this.translatedLine = document.createElement("div");
      this.translatedLine.className = "smart-subtitles-line smart-subtitles-translation";
      this.root.append(this.sourceLine, this.translatedLine);
      this.applySettings();
    }

    if (this.root.parentElement !== player) {
      player.append(this.root);
      this.report?.("success", "Overlay YouTube player'a bağlandı");
    }
    return this.root;
  }

  private applySettings() {
    if (!this.root) return;
    this.root.style.setProperty(
      "--smart-subtitle-size",
      `${this.settings.fontSize}px`,
    );
    this.root.style.bottom = `${this.settings.position}%`;
    this.root.dataset.background = String(this.settings.background);
  }

  private tick() {
    const root = this.ensureRoot();
    const video = document.querySelector<HTMLVideoElement>(".html5-video-player video");
    const player = root?.parentElement;
    const minimized = player?.classList.contains("ytp-player-minimized");

    if (!root || !video || video.seeking || video.ended || video.readyState < 2 || !this.settings.enabled || minimized || player?.classList.contains("ad-showing")) {
      if (root) root.dataset.visible = "false";
      this.animationFrame = requestAnimationFrame(this.tick);
      return;
    }

    const sourceCue = findActiveCue(this.sourceCues, video.currentTime);
    const translatedCue = findActiveCue(this.cues, video.currentTime);

    const cue =
      translatedCue && (!sourceCue || translatedCue.id === sourceCue.id)
        ? translatedCue
        : null;
    if (!cue) {
      root.dataset.visible = "false";
      this.lastCueId = null;
    } else if (cue.id !== this.lastCueId) {
      this.lastCueId = cue.id;
      root.dataset.cueId = String(cue.id);
      root.dataset.cueStart = String(cue.start);
      root.dataset.cueEnd = String(cue.end);
      if (this.sourceLine) {
        this.sourceLine.textContent = cue.text;
        this.sourceLine.style.display =
          this.settings.mode === "dual" ? "block" : "none";
      }
      if (this.translatedLine) {
        this.translatedLine.textContent = cue.translatedText;
      }
      root.dataset.visible = "true";
      if (!this.reportedVisibleCue) {
        this.reportedVisibleCue = true;
        this.report?.(
          "success",
          `Overlay ilk cue'yu gösterdi: #${cue.id} · ${video.currentTime.toFixed(1)} sn`,
        );
      }
    } else {
      root.dataset.visible = "true";
    }

    this.animationFrame = requestAnimationFrame(this.tick);
  }

  destroy() {
    cancelAnimationFrame(this.animationFrame);
    this.root?.remove();
  }
}
