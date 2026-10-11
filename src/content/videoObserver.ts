import type { VideoState } from "../core/types";

const VIDEO_ID_PATTERN = /^[a-zA-Z0-9_-]{11}$/;

export function getYouTubeVideoId(urlString = window.location.href): string | null {
  try {
    const url = new URL(urlString);

    if (url.hostname === "youtu.be") {
      return validateVideoId(url.pathname.split("/").filter(Boolean)[0]);
    }

    if (
      url.hostname !== "youtube.com" &&
      !url.hostname.endsWith(".youtube.com")
    ) {
      return null;
    }

    if (url.pathname === "/watch") {
      return validateVideoId(url.searchParams.get("v"));
    }

    const routeMatch = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/);
    return validateVideoId(routeMatch?.[1] ?? null);
  } catch {
    return null;
  }
}

function validateVideoId(candidate: string | null | undefined): string | null {
  return candidate && VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

function visibleWatchVideoId(): string | null {
  const watchSurface = document.querySelector<HTMLElement>(
    "ytd-watch-flexy:not([hidden])[video-id]",
  );
  return validateVideoId(watchSurface?.getAttribute("video-id"));
}

function hasVisibleMainPlayer(): boolean {
  const player = document.querySelector<HTMLElement>(".html5-video-player");
  if (!player || player.classList.contains("ytp-player-minimized")) return false;
  const bounds = player.getBoundingClientRect();
  return bounds.width >= 160 && bounds.height >= 90;
}

export function observeYouTubeVideo(
  onChange: (state: VideoState) => void,
  onNavigationStart?: () => void,
): () => void {
  let previousUrl = "";
  let previousVideoId: string | null | undefined;
  let bridgeVideoId: string | null = null;

  const inspectLocation = () => {
    const url = window.location.href;
    const videoId =
      getYouTubeVideoId(url) ??
      visibleWatchVideoId() ??
      (hasVisibleMainPlayer() ? bridgeVideoId : null);

    if (url === previousUrl && videoId === previousVideoId) {
      return;
    }

    previousUrl = url;
    previousVideoId = videoId;
    onChange({ videoId, url, detectedAt: Date.now() });
  };

  const handleNavigation = () => inspectLocation();
  const handleNavigationStart = () => {
    bridgeVideoId = null;
    onNavigationStart?.();
  };
  const handlePageMessage = (event: MessageEvent) => {
    if (
      event.source !== window ||
      event.data?.source !== "smart-subtitles-page" ||
      event.data?.type !== "VIDEO_CONTEXT"
    ) {
      return;
    }
    bridgeVideoId = validateVideoId(event.data.payload?.videoId);
    inspectLocation();
  };
  const intervalId = window.setInterval(inspectLocation, 1_000);

  window.addEventListener("message", handlePageMessage);
  window.addEventListener("hashchange", handleNavigation);
  window.addEventListener("popstate", handleNavigation);
  window.addEventListener("yt-navigate-start", handleNavigationStart);
  window.addEventListener("yt-navigate-finish", handleNavigation);
  window.addEventListener("yt-page-data-updated", handleNavigation);
  inspectLocation();

  return () => {
    window.clearInterval(intervalId);
    window.removeEventListener("message", handlePageMessage);
    window.removeEventListener("hashchange", handleNavigation);
    window.removeEventListener("popstate", handleNavigation);
    window.removeEventListener("yt-navigate-start", handleNavigationStart);
    window.removeEventListener("yt-navigate-finish", handleNavigation);
    window.removeEventListener("yt-page-data-updated", handleNavigation);
  };
}
