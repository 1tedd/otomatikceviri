export const API_KEY_STORAGE_KEY = "geminiApiKey";
export const API_KEY_REVISION_KEY = "geminiApiKeyRevision";

export async function readSavedApiKey(): Promise<string | null> {
  const stored = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  return typeof stored[API_KEY_STORAGE_KEY] === "string" && stored[API_KEY_STORAGE_KEY].trim()
    ? stored[API_KEY_STORAGE_KEY].trim()
    : null;
}

export async function saveApiKey(value: string): Promise<void> {
  const key = value.trim();
  if (!key || /\s/.test(key)) {
    throw new Error("Boşluk içermeyen bir API anahtarı gir.");
  }
  await chrome.storage.local.set({
    [API_KEY_STORAGE_KEY]: key,
    [API_KEY_REVISION_KEY]: crypto.randomUUID(),
  });
}
