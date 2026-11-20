export type ImportedEpisode = {
  title: string;
  number?: number;
  script: string;
  sourcePath?: string;
  sourceChapters?: {
    title: string;
    script: string;
    sourcePath?: string;
    sourceStart?: number;
    sourceEnd?: number;
  }[];
  sceneEstimates?: { sceneId: string; seconds: number }[];
  expectedDuration?: number;
};

const chineseDigits: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const chineseUnits: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const episodeMarker =
  /^(?:第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*集|(?:episode|ep)\.?\s*([0-9]+))/iu;

function episodeNumber(label: string): number | undefined {
  if (/^\d+$/u.test(label)) {
    const value = Number(label);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (/^[零〇一二两三四五六七八九]+$/u.test(label)) {
    const value = Number(Array.from(label, (char) => chineseDigits[char]).join(""));
    return Number.isSafeInteger(value) ? value : undefined;
  }
  let total = 0,
    group = 0,
    digit = 0;
  for (const char of label) {
    if (char in chineseDigits) digit = chineseDigits[char]!;
    else if (char in chineseUnits) {
      group += (digit || 1) * chineseUnits[char]!;
      digit = 0;
    } else if (char === "万") {
      total += (group + digit || 1) * 10000;
      group = 0;
      digit = 0;
    } else return undefined;
  }
  return total + group + digit;
}

function episodeHeading(line: string): { title: string; number: number } | undefined {
  // Markdown 标题与方括号只用于识别，原始标题行完整留在剧本里。
  const title = line
    .trim()
    .replace(/^#{1,6}\s*/u, "")
    .replace(/\s+#+$/u, "")
    .trim();
  const normalized = title.normalize("NFKC");
  const wrapped = /^[【\[]/u.test(normalized);
  const content = wrapped ? normalized.slice(1).trimStart() : normalized;
  const match = episodeMarker.exec(content);
  if (!match) return;
  const rest = content.slice(match[0].length);
  if (rest && !/^[\s:|\-—–]/u.test(rest) && !(wrapped && /^[】\]]/u.test(rest))) return;
  const number = episodeNumber((match[1] || match[2])!);
  if (number !== undefined) return { title, number };
}

function filenameEpisodeNumber(title: string): number | undefined {
  const normalized = title.normalize("NFKC");
  const match =
    normalized.match(/第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*集/u) ??
    normalized.match(/(?:^|[^a-z0-9])(?:episode|ep)[\s._-]*(\d+)(?=$|[^a-z0-9])/iu) ??
    normalized.match(/^(\d+)$/u);
  return match?.[1] ? episodeNumber(match[1]) : undefined;
}

/** 一个文件对应一集。正文里出现集标题只用于补全文件名缺失的集号。 */
export function importEpisodeFile(text: string, filename: string): ImportedEpisode | undefined {
  if (!text.trim()) return;
  const basename = filename.split(/[/\\]/u).pop() ?? "";
  const title = basename.replace(/\.(?:txt|md|markdown)$/iu, "").trim();
  const number = filenameEpisodeNumber(title);
  if (number !== undefined) return { title, number, script: text };
  for (const line of text.matchAll(/^[^\r\n]+/gmu)) {
    const heading = episodeHeading(line[0]);
    if (heading)
      return {
        title: title || heading.title,
        number: heading.number,
        script: text,
      };
  }
  return { title: title || "未命名剧本", script: text };
}

function decodeEpisodeBytes(bytes: Uint8Array): string {
  const decode = (encoding: string) => new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decode("utf-16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decode("utf-16be");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decode("utf-8");
  try {
    return decode("utf-8");
  } catch {
    return decode("gb18030");
  }
}

export async function readEpisodeFile(
  file: Blob & { name?: string },
): Promise<ImportedEpisode | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return importEpisodeFile(decodeEpisodeBytes(bytes), file.name ?? "");
}

/** 连续剧本按独立集标题分割；首集包含标题前的说明，保留正文及原换行。 */
export function splitEpisodeScript(text: string, fallbackTitle: string): ImportedEpisode[] {
  if (!text.trim()) return [];
  const episodes: ImportedEpisode[] = [];
  let current: { title: string; number: number } | undefined;
  let start = 0;
  for (const line of text.matchAll(/^[^\r\n]+/gmu)) {
    const heading = episodeHeading(line[0]);
    if (!heading) continue;
    if (current) {
      episodes.push({ ...current, script: text.slice(start, line.index) });
      start = line.index!;
    }
    current = heading;
  }
  if (current) episodes.push({ ...current, script: text.slice(start) });
  else {
    const title = fallbackTitle.trim() || "未命名剧本";
    const fromFile = episodeHeading(title.replace(/\.(?:txt|md|markdown)$/iu, ""));
    episodes.push(
      fromFile ? { title, number: fromFile.number, script: text } : { title, script: text },
    );
  }
  return episodes;
}

const titleOrder = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

/** 有集号的先按集号排列，无集号的按文件标题自然排序；相同项维持导入顺序。 */
export function sortImportedEpisodes(items: ImportedEpisode[]): ImportedEpisode[] {
  return [...items].sort((a, b) => {
    if (a.number !== undefined && b.number !== undefined) return a.number - b.number;
    if (a.number !== undefined) return -1;
    if (b.number !== undefined) return 1;
    return titleOrder.compare(a.title, b.title);
  });
}

type SceneMarker = { start: number; number: number; sceneId: string };
type SourceChapter = NonNullable<ImportedEpisode["sourceChapters"]>[number];
type EpisodeGroup = {
  number: number;
  chapters: SourceChapter[];
  estimates: Map<string, Set<number>>;
  lastSource?: ImportedEpisode;
};

function sceneMarkers(script: string): SceneMarker[] {
  const markers: SceneMarker[] = [];
  for (const line of script.matchAll(/^[^\r\n]+/gmu)) {
    if (!line[0].includes("场次")) continue;
    const plain = line[0].normalize("NFKC").replaceAll("**", "").trim();
    const match = /^(?:#{1,6}\s*)?(?:场次|【场次】|\[场次\])\s*:\s*(\d+)\s*[-–—]\s*(\d+)\s*$/u.exec(
      plain,
    );
    if (!match) continue;
    const number = Number(match[1]);
    const scene = Number(match[2]);
    if (!Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(scene)) continue;
    markers.push({
      start: line.index!,
      number,
      sceneId: number + "-" + String(scene).padStart(2, "0"),
    });
  }
  return markers;
}

function compareChapters(a: ImportedEpisode, b: ImportedEpisode) {
  const chapterHeading = /第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*章/u;
  const first = chapterHeading.exec(a.title.normalize("NFKC"));
  const second = chapterHeading.exec(b.title.normalize("NFKC"));
  if (first && second) {
    const left = episodeNumber(first[1]!);
    const right = episodeNumber(second[1]!);
    if (left !== undefined && right !== undefined && left !== right) return left - right;
  }
  return (
    titleOrder.compare(a.title, b.title) ||
    titleOrder.compare(a.sourcePath || "", b.sourcePath || "")
  );
}

function chapterSlice(source: ImportedEpisode, start: number, end: number): SourceChapter {
  return {
    title: source.title,
    script: source.script.slice(start, end),
    ...(source.sourcePath ? { sourcePath: source.sourcePath } : {}),
    sourceStart: start,
    sourceEnd: end,
  };
}

function appendSceneText(
  group: EpisodeGroup,
  sceneId: string,
  source: ImportedEpisode,
  start: number,
  end: number,
) {
  if (start === end) return;
  const part = chapterSlice(source, start, end);
  const values = group.estimates.get(sceneId)!;
  for (const line of part.script.matchAll(/^[^\r\n]+/gmu)) {
    if (!line[0].includes("本场预计时长")) continue;
    const plain = line[0].normalize("NFKC").replaceAll("**", "").trim();
    const estimate =
      /^(?:【本场预计时长】|\[本场预计时长\]|本场预计时长)\s*:\s*(\d+(?:\.\d+)?)\s*秒\s*$/u.exec(
        plain,
      );
    const seconds = Number(estimate?.[1]);
    if (Number.isFinite(seconds) && seconds > 0) values.add(seconds);
  }
  const last = group.chapters.at(-1);
  if (group.lastSource === source && last?.sourceEnd === start) {
    last.script += part.script;
    last.sourceEnd = end;
  } else group.chapters.push(part);
  group.lastSource = source;
}

/** Scene IDs identify episodes across chapter files. An unmarked continuation
 * inherits its predecessor in the import batch, never an existing project row. */
export function groupImportedEpisodes(items: ImportedEpisode[]): {
  episodes: ImportedEpisode[];
  errors: string[];
  sourceCount: number;
  sceneGrouped: boolean;
} {
  const sources = [...items]
    .sort(compareChapters)
    .map((source) => ({ source, markers: sceneMarkers(source.script) }));
  if (!sources.some(({ markers }) => markers.length)) {
    return {
      episodes: sortImportedEpisodes(items),
      errors: [],
      sourceCount: items.length,
      sceneGrouped: false,
    };
  }
  const groups = new Map<number, EpisodeGroup>();
  const unresolved: ImportedEpisode[] = [];
  const errors: string[] = [];
  let active: { group: EpisodeGroup; sceneId: string } | undefined;
  for (const { source, markers } of sources) {
    if (!active && !markers.length) {
      unresolved.push({
        ...source,
        sourceChapters: [chapterSlice(source, 0, source.script.length)],
      });
      errors.push(
        `${source.sourcePath || source.title} 没有场次，前面也没有可承接的场次，请确认归属。`,
      );
      continue;
    }
    let start = 0;
    for (const [index, marker] of markers.entries()) {
      // Leading blank lines belong with the new heading. Actual words before
      // it continue the preceding scene, even at the start of a new TXT.
      if (active && (index > 0 || source.script.slice(0, marker.start).trim())) {
        appendSceneText(active.group, active.sceneId, source, start, marker.start);
        start = marker.start;
      }
      let group = groups.get(marker.number);
      if (!group) {
        group = { number: marker.number, chapters: [], estimates: new Map() };
        groups.set(marker.number, group);
      }
      if (!group.estimates.has(marker.sceneId)) group.estimates.set(marker.sceneId, new Set());
      active = { group, sceneId: marker.sceneId };
    }
    if (active) appendSceneText(active.group, active.sceneId, source, start, source.script.length);
  }
  const episodes: ImportedEpisode[] = [];
  for (const { number, chapters, estimates } of groups.values()) {
    const sceneEstimates: NonNullable<ImportedEpisode["sceneEstimates"]> = [];
    for (const [sceneId, values] of estimates) {
      if (values.size === 1) sceneEstimates.push({ sceneId, seconds: [...values][0]! });
      else if (values.size === 0) errors.push(`第${number}集场次 ${sceneId} 缺少有效的预计时长。`);
      else
        errors.push(
          `第${number}集场次 ${sceneId} 的预计时长冲突（${[...values].join("、")}秒），请核对原文。`,
        );
    }
    const total = sceneEstimates.reduce((sum, row) => sum + row.seconds, 0);
    const script = chapters.reduce((text, chapter) => {
      const joiner = text && !/[\r\n]$/u.test(text) && !/^[\r\n]/u.test(chapter.script) ? "\n" : "";
      return text + joiner + chapter.script;
    }, "");
    episodes.push({
      number,
      title: [...new Set(chapters.map((chapter) => chapter.title))].join("、"),
      script,
      sourceChapters: chapters,
      sceneEstimates,
      ...(sceneEstimates.length === estimates.size
        ? { expectedDuration: Number(total.toFixed(9)) }
        : {}),
    });
  }
  return {
    episodes: [...episodes.sort((a, b) => a.number! - b.number!), ...unresolved],
    errors,
    sourceCount: items.length,
    sceneGrouped: true,
  };
}
