import type { TranslationCache } from "./types";

const CACHE_PREFIX = "translationCache:";
const CACHE_NAMESPACE = "gemini-cue-alignment-v2";

function cacheKey(
  videoId: string,
  sourceLanguage: string,
  trackId: string,
): string {
  return `${CACHE_PREFIX}${CACHE_NAMESPACE}:${videoId}:${sourceLanguage}:tr:${encodeURIComponent(trackId)}`;
}

function isValidCache(value: unknown): value is TranslationCache {
  if (!value || typeof value !== "object") return false;
  const cache = value as Partial<TranslationCache>;
  return (
    typeof cache.videoId === "string" &&
    typeof cache.sourceLanguage === "string" &&
    cache.targetLanguage === "tr" &&
    typeof cache.trackId === "string" &&
    Array.isArray(cache.cues)
  );
}

export async function getTranslationCache(
  videoId: string,
  sourceLanguage: string,
  trackId: string,
): Promise<TranslationCache | null> {
  const key = cacheKey(videoId, sourceLanguage, trackId);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key];
  if (value == null) return null;
  if (!isValidCache(value)) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return value;
}

export async function setTranslationCache(
  cache: TranslationCache,
): Promise<void> {
  await chrome.storage.local.set({
    [cacheKey(cache.videoId, cache.sourceLanguage, cache.trackId)]: cache,
  });
}

export async function deleteVideoCache(videoId: string): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.entries(all)
    .filter(
      ([key, value]) =>
        key.startsWith(CACHE_PREFIX) &&
        value &&
        typeof value === "object" &&
        (value as Partial<TranslationCache>).videoId === videoId,
    )
    .map(([key]) => key);
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

export async function clearTranslationCache(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}
