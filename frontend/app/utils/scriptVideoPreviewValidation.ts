import type { validateStoryboard } from "../../../backend/workspace/skills/script-to-video/scripts/validation";
import {
  type PreviewAsset,
  type PreviewCard,
} from "./scriptVideoPreview";
import {
  annotateScriptVideoAssets,
  describeScriptVideoReferenceProblem,
} from "../../../backend/src/services/script-video-mentions";
import { scriptVideoPromptStylePrefix } from "../../../backend/src/services/script-video-style";
import { scriptVideoStoryboardBody } from "../../../backend/src/services/script-video-format";
import { getScriptVideoMaterialUse, type ScriptVideoDeliveryOptions } from "../../../backend/src/services/script-video-delivery";
import { assertScriptVideoCards, getScriptVideoContentWarnings, hasInvalidScriptVideoTimeline, ScriptVideoAIError, type ScriptVideoProduction } from "../../../backend/src/services/script-video-types";

export type PreviewValidation = ReturnType<typeof validateStoryboard> & {
  cardCount: number;
  warnings: { code: string; message: string }[];
};

export type PreviewAssetContext = Pick<ScriptVideoDeliveryOptions, "stylePreset" | "cast"> & {
  script?: string;
  production?: ScriptVideoProduction;
  scope?: "episode" | "card" | "prefix";
};

export function getPreviewMaterialUse(
  card: PreviewCard,
  assets: PreviewAsset[],
  context: PreviewAssetContext,
) {
  const current = card.promptNeedsSync ? { ...card, prompt: scriptVideoStoryboardBody(card) } : card;
  return getScriptVideoMaterialUse(current, assets, context);
}

export function inspectPreviewCardAssets(
  card: PreviewCard,
  assets: PreviewAsset[],
  context: PreviewAssetContext = {},
) {
  const prompt = typeof card.prompt === "string" ? card.prompt : "";
  const shots = Array.isArray(card.shots) ? card.shots : [];
  const references = annotateScriptVideoAssets(prompt, assets, card.assetIds, {
    card,
    characters: card.characters,
    cast: context.cast,
    excludedIds: card.excludedAssetIds,
    autoBind: true,
    protectedPrefix: context.stylePreset && scriptVideoPromptStylePrefix(context.stylePreset),
  });
  const bound = new Set(card.assetIds);
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const materialUse = getPreviewMaterialUse(card, assets, context);
  const visual = new Set([
    ...(card.openingAssetIds || []),
    ...shots.flatMap(shot => shot.visualAssetIds || []),
    ...references.mentions.filter(hit => hit.explicit && hit.usage === "visual").map(hit => hit.id),
  ]);
  const missing = [...visual]
    .filter(id => byId.has(id))
    .filter(id => !byId.get(id)?.image)
    .map(id => byId.get(id)?.name || id);
  const unbound = [...new Set(references.mentions
    .filter(hit => hit.explicit && !bound.has(hit.id) &&
      (hit.usage === "visual" && materialUse.imageIds.includes(hit.id) ||
       hit.usage === "speaker" && materialUse.speakerIds.includes(hit.id)))
    .map(hit => `@${hit.name}`))];
  const warnings: { code: string; message: string }[] = [];
  if (bound.size !== card.assetIds.length)
    warnings.push({ code: "DUPLICATE_ASSET", message: "存在重复配图。" });
  for (const id of bound)
    if (!byId.has(id)) warnings.push({ code: "UNKNOWN_ASSET_ID", message: `素材 ID 不在本项目中：${id}` });
  const declared = [
    { ids: card.openingAssetIds || [], speaker: false },
    ...shots.flatMap(shot => [
      { ids: shot.visualAssetIds || [], speaker: false },
      { ids: shot.speakerAssetIds || [], speaker: true },
    ]),
  ];
  for (const { ids, speaker } of declared) {
    for (const id of ids) {
      const asset = byId.get(id);
      if (!asset) warnings.push({ code: "UNKNOWN_ASSET_ID", message: `镜头素材 ID 不在本项目中：${id}` });
      else if (!bound.has(id)) warnings.push({ code: "UNBOUND_ASSET", message: `请为本段绑定 @${asset.name}。` });
      if (asset && speaker && asset.kind !== "character")
        warnings.push({ code: "SPEAKER_ASSET_KIND", message: `发声者须使用角色素材：@${asset.name}` });
    }
  }
  if (missing.length)
    warnings.push({ code: "ASSET_GAP", message: `缺少「${missing.join("、")}」的配图，请重新选择素材。` });
  for (const problem of references.problems)
    warnings.push({
      code: problem.type === "ambiguous" ? "AMBIGUOUS_ASSET" : "UNKNOWN_ASSET",
      message: `${describeScriptVideoReferenceProblem(prompt, problem)}。`,
    });
  if (unbound.length)
    warnings.push({ code: "UNBOUND_ASSET", message: `请在「视频提示词」的 @ 菜单重新选取 ${unbound.join("、")}。` });
  const inferredMissing = materialUse.imageIds
    .filter(id => !visual.has(id) && byId.has(id) && !byId.get(id)?.image)
    .map(id => byId.get(id)!.name);
  if (inferredMissing.length)
    warnings.push({ code: "ASSET_GAP", message: `文案可能使用了「${inferredMissing.join("、")}」，请核对是否需要补充配图。` });
  const inferredUnbound = [...new Set(references.mentions
    .filter(hit => !hit.explicit && !bound.has(hit.id) &&
      (hit.usage === "visual" && materialUse.imageIds.includes(hit.id) ||
       hit.usage === "speaker" && materialUse.speakerIds.includes(hit.id)))
    .map(hit => hit.name))];
  if (inferredUnbound.length)
    warnings.push({ code: "UNBOUND_ASSET", message: `文案可能使用了尚未绑定的「${inferredUnbound.join("、")}」，可在分镜中补充素材。` });
  return { ...references, materialUse, issues: [] as { code: string; message: string }[], warnings };
}

/** Only execution requirements block automatic actions. Natural-language
 * directions and inferred material usage remain available to the editor. */
export function validatePreviewCards(
  cards: PreviewCard[],
  assets: PreviewAsset[],
  context?: PreviewAssetContext,
): PreviewValidation {
  const result: PreviewValidation = {
    ok: true, issues: [], segments: [], beatCount: 0, packageCount: 0, promptCount: 0,
    cardCount: cards.length, warnings: [],
  };
  const error = (code: string, message: string) =>
    result.issues.push({ level: "ERROR", code, message });
  if (!cards.length) error("NO_CARDS", "本集尚无分镜片段。");
  const cardIds = new Set<string>();
  for (const [index, card] of cards.entries()) {
    const prefix = `「${card.title}」`;
    if (typeof card.id !== "string" || !card.id.trim() || cardIds.has(card.id)) error("CARD_ID_DUPLICATE", `${prefix}片段标识无效或重复。`);
    cardIds.add(card.id);
    if (card.promptNeedsSync)
      error("PROMPT_STALE", `${prefix}分镜已修改，请先让 AI 同步提示词，或完成提示词修改。`);
    if (typeof card.prompt !== "string" || !card.prompt.trim()) {
      error("EMPTY_PROMPT", `${prefix}视频提示词为空。`);
      continue;
    }
    if ([card.opening, card.scene, card.characters, card.independentGeneration, card.ending].some(value => typeof value !== "string" || !value.trim()))
      result.warnings.push({ code: "FORMAL_METADATA_MISSING", message: `${prefix}部分场景、人物或衔接说明未填写，请按需要核对。` });
    const declared = card.prompt.match(/(?:全段|本段总时长|总时长)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)\s*秒/u);
    if (declared && Number(declared[1]) !== card.duration)
      result.warnings.push({ code: "PROMPT_DURATION", message: `${prefix}提示词写了 ${declared[1]} 秒，实际片段为 ${card.duration} 秒，请核对文案。` });
    if (hasInvalidScriptVideoTimeline(card.prompt, card.duration))
      result.warnings.push({ code: "PROMPT_TIMELINE", message: `${prefix}提示词时码与片段时长可能不一致，请核对镜头安排。` });
    if (!Number.isFinite(card.duration) || card.duration <= 0 || card.duration > 30)
      error("DUR008", `${prefix}片段时长须大于 0 秒且不超过 30 秒。`);
    if (!Array.isArray(card.shots) || !card.shots.length) {
      error("DUR007", `${prefix}缺少分镜镜头。`);
      continue;
    }
    if (card.shots.some(shot => !shot || !Number.isFinite(shot.duration) || shot.duration <= 0 || shot.duration > 30)) {
      error("DUR006", `${prefix}逐镜时长须为大于 0 且不超过 30 的秒数。`);
      continue;
    } else if (Number.isFinite(card.duration) && Math.abs(card.shots.reduce((sum, shot) => sum + shot.duration, 0) - card.duration) > 1e-8)
      error("DUR009", `${prefix}逐镜时长之和与片段时长不符。`);
    result.segments.push({ number: String(index + 1), duration: card.duration, shotCount: card.shots.length });
    const shotIds = new Set<string>();
    for (const shot of card.shots) {
      if (typeof shot.id !== "string" || !shot.id.trim() || shotIds.has(shot.id))
        error("SHOT_ID_DUPLICATE", `${prefix}镜头标识无效或重复。`);
      shotIds.add(shot.id);
    }
    if (card.shots.some(shot => typeof shot.dialogue !== "string" ||
      [shot.camera, shot.action].some(value => typeof value !== "string" || !value.trim()))) {
      error("SHOT_FORMAT", `${prefix}镜头字段格式无效。`);
      continue;
    }
    const references = [card.assetIds, card.openingAssetIds, card.excludedAssetIds,
      ...card.shots.flatMap(shot => [shot.visualAssetIds, shot.speakerAssetIds])];
    if (!Array.isArray(card.assetIds) || references.some(ids => ids !== undefined &&
      (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id.trim())))) {
      error("ASSET_BINDINGS_INVALID", `${prefix}素材绑定格式无效。`);
      continue;
    }
    const materials = inspectPreviewCardAssets(card, assets, context);
    result.warnings.push(...materials.warnings.map(issue => ({ ...issue, message: prefix + issue.message })));
  }
  if (!result.issues.length) {
    try {
      assertScriptVideoCards({ script: context?.script ?? "", assets, cards, production: context?.production });
    } catch (failure) {
      if (!(failure instanceof ScriptVideoAIError)) throw failure;
      for (const issue of failure.issues) error(issue.code, issue.message);
    }
  }
  result.ok = !result.issues.some((issue) => issue.level === "ERROR");
  if (result.ok && context?.script !== undefined)
    result.warnings.push(...getScriptVideoContentWarnings({
      script: context.script, assets, cards, production: context.production, scope: context.scope ?? "card",
    }));
  result.warnings = result.warnings.filter((issue, index, all) => all.findIndex(prior => prior.code === issue.code && prior.message === issue.message) === index);
  return result;
}
