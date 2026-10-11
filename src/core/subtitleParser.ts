import type { SubtitleCue } from "./types";

type Json3Event = {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
};

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    "#39": "'",
  };

  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#")) {
        const hex = entity.slice(0, 2).toLowerCase() === "#x";
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code) : match;
      }
      return entities[entity.toLowerCase()] ?? match;
    });
}

function finalizeCues(
  cues: Array<Omit<SubtitleCue, "id" | "end"> & { end?: number }>,
): SubtitleCue[] {
  const normalized = cues
    .map((cue) => ({ ...cue, text: normalizeText(decodeEntities(cue.text)) }))
    .filter((cue) => cue.text && Number.isFinite(cue.start) && cue.start >= 0 && Number.isFinite(cue.duration))
    .sort((left, right) => left.start - right.start);
  return normalized
    .map((cue, index, all) => {
      const inferredDuration = Math.max(
        0.35,
        Math.min(4, (all[index + 1]?.start ?? cue.start + 4) - cue.start),
      );
      const duration = cue.duration > 0 ? cue.duration : inferredDuration;
      return {
        id: index,
        start: cue.start,
        duration,
        end: cue.end ?? cue.start + duration,
        text: cue.text,
      };
    })
    .filter((cue) => cue.text.length > 0);
}

function parseJson3(payload: string): SubtitleCue[] {
  const parsed = JSON.parse(payload) as { events?: Json3Event[] };
  const cues = (parsed.events ?? []).flatMap((event) => {
    const start = (event.tStartMs ?? 0) / 1_000;
    const duration = (event.dDurationMs ?? 0) / 1_000;
    const segments = event.segs ?? [];
    if (!segments.some((segment) => (segment.tOffsetMs ?? 0) > 0)) {
      return [{ start, duration, text: segments.map((segment) => segment.utf8 ?? "").join("") }];
    }

    const groups: Array<{ offset: number; text: string }> = [];
    let lastOffset = 0;
    for (const segment of segments) {
      lastOffset = Math.max(lastOffset, Math.max(0, segment.tOffsetMs ?? lastOffset));
      const text = segment.utf8 ?? "";
      if (!text.trim()) {
        if (groups.length) groups[groups.length - 1].text += text;
        continue;
      }
      const group = groups[groups.length - 1];
      if (!group || lastOffset - group.offset >= 2_500) {
        groups.push({ offset: lastOffset, text });
      } else {
        group.text += text;
      }
    }
    return groups.map((group, index) => ({
      start: start + group.offset / 1_000,
      duration: groups[index + 1]?.offset !== undefined
        ? Math.min(4, (groups[index + 1].offset - group.offset) / 1_000)
        : duration > 0 ? Math.min(4, Math.max(0.35, duration - group.offset / 1_000)) : 0,
      text: group.text,
    }));
  });
  return finalizeCues(cues);
}

function parseXml(payload: string): SubtitleCue[] {
  const cues: Array<{ start: number; duration: number; text: string }> = [];
  const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;

  while ((match = textPattern.exec(payload))) {
    const attributes = match[1];
    const start = Number.parseFloat(
      attributes.match(/\bstart=["']([^"']+)["']/i)?.[1] ?? "0",
    );
    const duration = Number.parseFloat(
      attributes.match(/\bdur=["']([^"']+)["']/i)?.[1] ?? "0",
    );
    cues.push({ start, duration, text: match[2] });
  }

  return finalizeCues(cues);
}

export function parseSubtitlePayload(payload: string): SubtitleCue[] {
  const trimmed = payload.trim();
  if (!trimmed) throw new Error("Altyazı yanıtı boş geldi.");

  let cues: SubtitleCue[] = [];
  if (trimmed.startsWith("{")) {
    try {
      cues = parseJson3(trimmed);
    } catch {
      cues = [];
    }
  }

  if (cues.length === 0 && trimmed.includes("<text")) {
    cues = parseXml(trimmed);
  }

  if (cues.length === 0) {
    throw new Error("Altyazı formatı çözümlenemedi.");
  }

  return cues;
}
