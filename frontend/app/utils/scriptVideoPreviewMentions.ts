import type { PreviewAsset } from "./scriptVideoPreview";

/** Match the complete imported name first: names may contain spaces, slashes or punctuation. */
export function findPreviewAssetMentions(text: string, assets: PreviewAsset[]) {
  const known = [...assets]
    .filter((asset) => asset.name)
    .sort((a, b) => b.name.length - a.name.length);
  const mentions: { asset: PreviewAsset; start: number; end: number }[] = [];
  const unknown = new Set<string>();
  for (let cursor = 0; cursor < text.length; cursor++) {
    if (text[cursor] !== "@") continue;
    const candidate = known.find((item) =>
      text.startsWith(item.name, cursor + 1),
    );
    // Reject an unknown suffix before considering shorter prefixes.
    const after = candidate
      ? text[cursor + candidate.name.length + 1] || ""
      : "";
    const asset =
      candidate && !/[A-Za-z0-9_\-]/u.test(after) ? candidate : undefined;
    if (asset) {
      const end = cursor + asset.name.length + 1;
      mentions.push({ asset, start: cursor, end });
      cursor = end - 1;
    } else {
      const name = text
        .slice(cursor + 1)
        .match(/^[^\s@，。、；：！？“”‘’「」()（）\[\]【】=,.!?;:]+/u)?.[0];
      if (name) unknown.add(name);
    }
  }
  return {
    mentions,
    assetIds: [...new Set(mentions.map(({ asset }) => asset.id))],
    unknown: [...unknown],
  };
}

export { annotateScriptVideoAssets } from '../../../backend/src/services/script-video-mentions'
export { scriptVideoPromptStylePrefix } from '../../../backend/src/services/script-video-style'
