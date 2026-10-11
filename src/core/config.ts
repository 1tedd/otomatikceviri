function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export type AIProviderConfig = {
  name: string;
  baseUrl: string;
  model: string;
};

export const AI_CONFIG = {
  temperature: 0.2,
  providers: [
    {
      name: "Gemini 3.1 Flash-Lite",
      baseUrl: cleanBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai"),
      model: "gemini-3.1-flash-lite",
    },
    {
      name: "Gemini 3.5 Flash-Lite",
      baseUrl: cleanBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai"),
      model: "gemini-3.5-flash-lite",
    }
  ] satisfies AIProviderConfig[],
} as const;
