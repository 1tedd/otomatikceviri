import { AI_CONFIG, type AIProviderConfig } from "./config";
import { readSavedApiKey } from "./apiSettings";
import type { TranslateLine } from "./types";

const SYSTEM_PROMPT = `Translate subtitle JSON into natural Turkish.
Return a translations list with the same id and text fields: exactly one result per input, same IDs and order.
Translate ONLY the text belonging to each ID. Never merge, move, omit, or repeat words between IDs, even when a sentence spans multiple subtitle lines. Use neighboring lines only to disambiguate meaning. Preserve tone, slang, humor, names, brands, and natural English technical terms.
No markdown, notes, labels, timestamps, explanations, or extra text.`;

const FULL_VIDEO_SYSTEM_PROMPT = `Translate every subtitle in the compact JSON input [id,text] into natural Turkish.
Return a translations list of objects with the same IDs and order, exactly one per input.
Translate ONLY the text belonging to each ID. Never merge, move, omit, or repeat words between IDs. Use full-video context only to disambiguate meaning. Preserve tone, slang, humor, names, brands, and natural English technical terms.
No markdown, notes, timestamps, explanations, or extra text.`;

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: { message?: string };
};

class ApiRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export type AIProviderEvent = {
  type: "attempt" | "failure" | "fallback" | "success";
  provider: string;
  message: string;
};

type ProviderReporter = (event: AIProviderEvent) => void;
type TranslationStrategy = "fast-start" | "quality" | "full-video";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const nextRequestAtByProvider = new Map<string, number>();

async function waitForRateLimitSlot(provider: AIProviderConfig): Promise<void> {
  if (!provider.name.startsWith("Gemini ")) return;
  const nextRequestAt = nextRequestAtByProvider.get(provider.name) ?? 0;
  const waitMs = Math.max(0, nextRequestAt - Date.now());
  nextRequestAtByProvider.set(provider.name, Date.now() + waitMs + 5_500);
  if (waitMs > 0) await sleep(waitMs);
}

function extractContent(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => part.text ?? "").join("");
  }
  throw new Error(response.error?.message || "AI yanıtında çeviri bulunamadı.");
}

function extractJsonArrayText(content: string): string {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("[");
  if (start < 0) {
    throw new Error("AI yanıtı geçerli JSON içermiyor.");
  }

  const end = cleaned.lastIndexOf("]");
  if (end > start) {
    return cleaned.slice(start, end + 1);
  }

  const partial = cleaned.slice(start);
  const lastCompleteObject = Math.max(
    partial.lastIndexOf("},"),
    partial.lastIndexOf('",'),
    partial.lastIndexOf("}\n"),
  );
  if (lastCompleteObject < 0) {
    throw new Error("AI yanıtı geçerli JSON içermiyor.");
  }

  let repaired = partial.slice(0, lastCompleteObject + 1).trim();
  if (repaired.endsWith(",")) repaired = repaired.slice(0, -1);
  return `${repaired}]`;
}

function parseTranslations(content: string, input: TranslateLine[]): TranslateLine[] {
  let parsed: unknown;
  try {
    const structured = JSON.parse(content.trim()) as unknown;
    parsed = structured && typeof structured === "object" && !Array.isArray(structured)
      ? (structured as { translations?: unknown }).translations
      : structured;
  } catch {

    parsed = JSON.parse(extractJsonArrayText(content)) as unknown;
  }
  if (!Array.isArray(parsed)) throw new Error("AI yanıtı JSON listesi değil.");

  const translations = parsed
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = record.id;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 && text ? { id, text } : null;
    })
    .filter((item): item is TranslateLine => item !== null);

  if (translations.length === 0) {
    throw new Error("AI yanıtında kullanılabilir çeviri satırı yok.");
  }

  const expectedIds = new Set(input.map((line) => line.id));
  const uniqueIds = new Set(translations.map((line) => line.id));
  const idsAreUsable =
    uniqueIds.size === translations.length &&
    translations.every((line) => expectedIds.has(line.id));

  if (!idsAreUsable) {
    throw new Error("Çeviri satır ID'leri kaynak altyazıyla eşleşmiyor; zaman kodları yeniden numaralandırılamaz.");
  }
  const byId = new Map(translations.map((line) => [line.id, line]));
  return input.flatMap((line) => byId.has(line.id) ? [byId.get(line.id)!] : []);
}

function mergeTranslations(
  base: TranslateLine[],
  extra: TranslateLine[],
): TranslateLine[] {
  const byId = new Map(base.map((line) => [line.id, line]));
  for (const line of extra) {
    if (line.text.trim()) byId.set(line.id, line);
  }
  return [...byId.values()];
}

function missingLines(
  input: TranslateLine[],
  translated: TranslateLine[],
): TranslateLine[] {
  const done = new Set(translated.map((line) => line.id));
  return input.filter((line) => !done.has(line.id));
}

async function requestWithProvider(
  lines: TranslateLine[],
  provider: AIProviderConfig,
  strategy: TranslationStrategy,
): Promise<TranslateLine[]> {
  const apiKey = await readSavedApiKey();
  if (!apiKey) {
    throw new ApiRequestError("Google AI Studio API anahtarını eklenti penceresine kaydet.", false);
  }
  let lastError: Error | null = null;
  const quickStart = strategy === "fast-start";
  const fullVideo = strategy === "full-video";
  const maximumAttempts = 2;
  let useSimpleJson = false;
  const timeoutMs = fullVideo
    ? 300_000
    : quickStart
      ? 20_000
      : lines.length > 80
        ? 120_000
        : 45_000;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    await waitForRateLimitSlot(provider);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            {
              role: "system",
              content: fullVideo ? FULL_VIDEO_SYSTEM_PROMPT : SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: JSON.stringify(
                fullVideo
                  ? lines.map((line) => [line.id, line.text])
                  : lines,
              ),
            },
          ],
          temperature: AI_CONFIG.temperature,
          response_format: useSimpleJson ? { type: "json_object" } : {
            type: "json_schema",
            json_schema: {
              name: "subtitle_translations",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  translations: {
                    type: "array",
                    minItems: lines.length,
                    maxItems: lines.length,
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        text: { type: "string" },
                      },
                      required: ["id", "text"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["translations"],
                additionalProperties: false,
              },
            },
          },
          max_tokens: Math.min(
            65_536,
            Math.max(
              fullVideo ? 8_192 : 1_024,
              lines.length * (fullVideo ? 36 : 48),
            ),
          ),
          reasoning_effort: "minimal",
        }),
      });

      const body = (await response.json().catch(() => ({}))) as ChatCompletionResponse;
      if (!response.ok) {
        const message = body.error?.message || `AI API hatası (${response.status}).`;

        if (response.status === 400 && !useSimpleJson) {
          useSimpleJson = true;
          continue;
        }

        const retryable = response.status >= 500;
        if (!retryable) throw new ApiRequestError(message, false);

        lastError = new ApiRequestError(message, true);
        break;
      }

      return parseTranslations(extractContent(body), lines);
    } catch (error) {
      lastError = controller.signal.aborted
        ? new Error(`${provider.name} zaman aşımına uğradı (${timeoutMs / 1_000} sn).`)
        : error instanceof Error
          ? error
          : new Error("AI isteği başarısız.");
      if (error instanceof ApiRequestError && !error.retryable) break;
      break;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError ?? new Error("AI çeviri isteği başarısız.");
}

async function recoverSmaller(
  lines: TranslateLine[],
  provider: AIProviderConfig,
  report: ProviderReporter | undefined,
  originalError: unknown,
): Promise<TranslateLine[]> {
  if (lines.length === 1) throw originalError;
  const middle = Math.ceil(lines.length / 2);
  report?.({
    type: "attempt", provider: provider.name,
    message: `${provider.name} yanıtı okunamadı; ${lines.length} satır daha küçük parçalarda deneniyor`,
  });
  let recovered: TranslateLine[] = [];
  let lastError: unknown = originalError;
  for (const part of [lines.slice(0, middle), lines.slice(middle)]) {
    try {
      recovered = mergeTranslations(
        recovered,
        await requestWithRecovery(part, provider, "quality", report),
      );
    } catch (partError) {
      lastError = partError;
    }
  }
  if (recovered.length > 0) return recovered;
  throw lastError;
}

async function requestWithRecovery(
  lines: TranslateLine[],
  provider: AIProviderConfig,
  strategy: TranslationStrategy,
  report?: ProviderReporter,
): Promise<TranslateLine[]> {
  let result: TranslateLine[];
  try {
    result = await requestWithProvider(lines, provider, strategy);
  } catch (error) {

    if (error instanceof ApiRequestError) throw error;
    return recoverSmaller(lines, provider, report, error);
  }

  const missing = missingLines(lines, result);
  if (missing.length === 0) return result;
  report?.({
    type: "attempt", provider: provider.name,
    message: `${provider.name} kısmi yanıt: ${result.length}/${lines.length}; ${missing.length} satır onarılacak`,
  });
  if (missing.length === lines.length) {
    if (lines.length === 1) return result;
    return recoverSmaller(lines, provider, report, new Error("AI yanıtında çeviri bulunamadı."));
  }
  try {
    const repaired = await requestWithRecovery(missing, provider, "quality", report);
    return mergeTranslations(result, repaired);
  } catch {
    return result;
  }
}

async function requestTranslationBatch(
  lines: TranslateLine[],
  report?: ProviderReporter,
  strategy: TranslationStrategy = "quality",
  providerNames?: string[],
): Promise<TranslateLine[]> {
  const failures: string[] = [];
  let bestPartial: TranslateLine[] = [];

  const requestedProviders = providerNames?.flatMap((name) => {
    const provider = AI_CONFIG.providers.find((candidate) => candidate.name === name);
    return provider ? [provider] : [];
  });
  const providers = requestedProviders?.length
    ? requestedProviders
    : [...AI_CONFIG.providers];

  for (const [index, provider] of providers.entries()) {
    const strategyLabel = strategy === "fast-start"
      ? " · hızlı başlangıç"
      : strategy === "full-video"
        ? " · tam video / tek istek"
        : "";
    report?.({
      type: index === 0 ? "attempt" : "fallback",
      provider: provider.name,
      message:
        index === 0
          ? `${provider.name} deneniyor (${provider.model}${strategyLabel})`
          : `Fallback: ${provider.name} deneniyor (${provider.model}${strategyLabel})`,
    });

    try {
      const result = await requestWithRecovery(lines, provider, strategy, report);
      if (result.length > bestPartial.length) {
        bestPartial = result;
      }

      if (result.length === lines.length) {
        report?.({
          type: "success",
          provider: provider.name,
          message: `${provider.name} yanıt verdi`,
        });
        return result;
      }

      throw new Error(
        `AI yanıtında ${lines.length - result.length} satır eksik.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bilinmeyen hata";
      failures.push(`${provider.name}: ${message}`);
      report?.({
        type: "failure",
        provider: provider.name,
        message: `${provider.name} başarısız: ${message}`,
      });
    }
  }

  if (bestPartial.length > 0) {
    report?.({
      type: "success",
      provider: "partial",
      message: `Kısmi çeviri korundu: ${bestPartial.length}/${lines.length} satır`,
    });
    return bestPartial;
  }

  throw new Error(`Tüm AI sağlayıcıları başarısız. ${failures.join(" | ")}`);
}

export async function requestTranslation(
  lines: TranslateLine[],
  report?: ProviderReporter,
  strategy: TranslationStrategy = "quality",
  providerNames?: string[],
): Promise<TranslateLine[]> {
  if (lines.length === 0) return [];

  const maxSingleShot = strategy === "full-video" ? 160 : 100;
  const batchSize = lines.length > maxSingleShot
    ? 80 : lines.length;
  const batchStrategy = lines.length > maxSingleShot && strategy === "full-video"
    ? "quality" : strategy;
  let selectedProviders = providerNames;
  let merged: TranslateLine[] = [];
  const reportAndRememberProvider: ProviderReporter = (event) => {
    if (
      event.type === "success" &&
      AI_CONFIG.providers.some((provider) => provider.name === event.provider)
    ) {
      selectedProviders = [event.provider];
    }
    report?.(event);
  };
  for (let offset = 0; offset < lines.length; offset += batchSize) {
    const batch = lines.slice(offset, offset + batchSize);
    const part = await requestTranslationBatch(
      batch,
      reportAndRememberProvider,
      batchStrategy,
      selectedProviders,
    );
    merged = mergeTranslations(merged, part);
  }
  return merged;
}
