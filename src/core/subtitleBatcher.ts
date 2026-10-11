import type { SubtitleCue, TranslateLine } from "./types";

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_CHARACTERS = 7_500;

export function createSubtitleBatches(
  cues: Array<SubtitleCue | TranslateLine>,
  batchSize = DEFAULT_BATCH_SIZE,
): TranslateLine[][] {
  const batches: TranslateLine[][] = [];
  let current: TranslateLine[] = [];
  let characterCount = 0;

  for (const cue of cues) {
    const line = { id: cue.id, text: cue.text };
    const wouldOverflow =
      current.length >= batchSize ||
      (current.length > 0 &&
        characterCount + line.text.length > MAX_BATCH_CHARACTERS);

    if (wouldOverflow) {
      batches.push(current);
      current = [];
      characterCount = 0;
    }

    current.push(line);
    characterCount += line.text.length;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
