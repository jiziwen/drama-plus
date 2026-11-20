// Fixed historical sample data used only by validation regression tests.
import { buildCardPrompt, type PreviewAsset, type PreviewCard, type PreviewShot } from '../../app/utils/scriptVideoPreview';

export const seedAssets: PreviewAsset[] = [
  {
    id: "emperor",
    name: "顾凌天",
    kind: "character",
    image: "/script-video-preview/emperor.jpg",
  },
  {
    id: "guard-older",
    name: "年长赐酒侍卫",
    kind: "character",
    image: "/script-video-preview/guard-older.jpg",
  },
  {
    id: "guard-rope",
    name: "持绳赐酒侍卫",
    kind: "character",
    image: "/script-video-preview/guard-rope.jpg",
  },
  {
    id: "bowl",
    name: "毒酒碗",
    kind: "prop",
    image: "/script-video-preview/bowl.jpg",
  },
  {
    id: "rope",
    name: "麻绳",
    kind: "prop",
    image: "/script-video-preview/rope.jpg",
  },
  {
    id: "courtyard",
    name: "京城别院-院落",
    kind: "scene",
    image: "/script-video-preview/courtyard.jpg",
  },
];

type ShotContent = Omit<PreviewShot, "id">;
type SceneContent = {
  title: string;
  summary: string;
  combat: boolean;
  shots: ShotContent[];
};

const sampleScenes: SceneContent[] = [
  {
    title: "雨后赐酒",
    summary: "京城别院-院落里，两名侍卫将酒送到顾凌天面前。",
    combat: false,
    shots: [
      {
        duration: 6,
        camera: "远景 · 缓推",
        action:
          "京城别院-院落的青砖积着雨水。顾凌天在檐下听到脚步，转头看向门洞。",
        dialogue: "",
      },
      {
        duration: 7,
        camera: "中景 · 侧跟",
        action:
          "年长赐酒侍卫两手端着毒酒碗，踏进檐下。持绳赐酒侍卫在门边停步，把麻绳压在身后。",
        dialogue: "",
      },
      {
        duration: 9,
        camera: "近景 · 过肩",
        action: "年长赐酒侍卫将毒酒碗向前递了半寸，碗底的水沿指缝滴下。",
        dialogue: "年长赐酒侍卫：“奉命送行。公子，请。”",
      },
      {
        duration: 8,
        camera: "特写 · 移焦",
        action: "焦点从酒面移到顾凌天的眼睛。他没有接碗，眼神越过对方肩头。",
        dialogue: "",
      },
    ],
  },
  {
    title: "碗边惊疑",
    summary: "顾凌天试探酒的来历，门边的麻绳暴露了两名侍卫的意图。",
    combat: false,
    shots: [
      {
        duration: 7,
        camera: "中近景 · 固定",
        action:
          "顾凌天垂眼看向毒酒碗，侧过半步，将端碗的人和院门同时收入视野。",
        dialogue: "顾凌天：“既是好酒，你先尝一口。”",
      },
      {
        duration: 7,
        camera: "特写 · 俯拍",
        action: "年长赐酒侍卫的拇指一下按紧碗沿。酒珠翻出碗口，滴在石阶边。",
        dialogue: "",
      },
      {
        duration: 8,
        camera: "中景 · 焦点后移",
        action:
          "京城别院-院落的门扇慢慢合拢。持绳赐酒侍卫从身后抽出麻绳，两手撑开绳圈。",
        dialogue: "",
      },
      {
        duration: 8,
        camera: "近景 · 缓推",
        action:
          "顾凌天看着石阶上的水迹，听见背后的绳股绷紧。他将右脚撤下一级。",
        dialogue: "年长赐酒侍卫：“这杯，你非喝不可。”",
      },
    ],
  },
  {
    title: "夺腕破绳",
    summary: "麻绳从身后套来，顾凌天借台阶错位，挡开毒酒碗。",
    combat: true,
    shots: [
      {
        duration: 6,
        camera: "全景 · 低机位",
        action:
          "京城别院-院落的门扇背后，持绳赐酒侍卫扑上石阶，双手将麻绳从顾凌天背后套下。",
        dialogue: "",
      },
      {
        duration: 7,
        camera: "中近景 · 侧跟",
        action:
          "顾凌天收下颌，将左臂插入绳圈，右脚蹬住下一级石阶。麻绳勒紧衣袖，擦过肩头。",
        dialogue: "",
      },
      {
        duration: 9,
        camera: "中景 · 横移",
        action:
          "年长赐酒侍卫抢上前，左手推碗。顾凌天随绳势转腰，右手托开执碗手腕，毒酒碗脱手向外翻落。",
        dialogue: "",
      },
      {
        duration: 8,
        camera: "近景 · 跟落",
        action:
          "毒酒碗砸在砖上。持绳赐酒侍卫踩中溅开的酒水，脚底一滑。顾凌天顺势抽出左臂，退到廊柱旁。",
        dialogue: "",
      },
    ],
  },
  {
    title: "碎瓷为证",
    summary: "两名侍卫停在台阶下，顾凌天捡起沾酒的碎瓷。",
    combat: false,
    shots: [
      {
        duration: 5,
        camera: "中景 · 固定",
        action:
          "京城别院-院落里，年长赐酒侍卫低头看着空手。持绳赐酒侍卫松开麻绳，留在阶下。",
        dialogue: "",
      },
      {
        duration: 7,
        camera: "特写 · 跟手",
        action: "顾凌天从毒酒碗的碎片里拣起一片带釉的碗底，用袖角包住。",
        dialogue: "",
      },
      {
        duration: 6,
        camera: "近景 · 抬镜",
        action: "顾凌天直起身，看向门口的两个人，指间仍压着包好的瓷片。",
        dialogue: "顾凌天：“回去告诉他，这份礼，我收下了。”",
      },
    ],
  },
];

export const seedScript = sampleScenes
  .map((scene) =>
    [
      scene.title,
      ...scene.shots.map((shot) =>
        [shot.action, shot.dialogue].filter(Boolean).join(" "),
      ),
    ].join("\n"),
  )
  .join("\n\n");


// 在本地按原文长短估算表演时长。长句继续拆分，以免一条镜头超过整卡时长。
function scriptFragments(script: string): string[] {
  const result: string[] = [];
  const sentences =
    script.match(/[^\n。！？!?；;]+[。！？!?；;]*[”’」』]*|[。！？!?；;]+/gu) ||
    [];
  for (const sentence of sentences) {
    const chars = Array.from(sentence.trim());
    let offset = 0;
    while (chars.length - offset > 72) {
      const candidate = chars.slice(offset, offset + 72);
      let end = candidate.length;
      for (let i = candidate.length - 1; i >= 32; i--) {
        if (/[，,、\s]/u.test(candidate[i]!)) {
          end = i + 1;
          break;
        }
      }
      result.push(candidate.slice(0, end).join("").trim());
      offset += end;
    }
    if (offset < chars.length) result.push(chars.slice(offset).join("").trim());
  }
  return result.filter(Boolean);
}

function previewScenes(script: string): SceneContent[] {
  const scenes: SceneContent[] = [];
  const combatWords =
    /交手|打斗|厮杀|搏斗|出拳|挥拳|挥刀|拔剑|斩向|刺向|格挡|踢向|挥剑|劈向|砍向|踹|击中|缠斗/u;
  let scene: SceneContent | undefined;
  let elapsed = 0;
  for (const text of scriptFragments(script)) {
    const duration = Math.min(
      30,
      Math.max(3, Math.ceil(Array.from(text).length / 4)),
    );
    if (!scene || elapsed + duration > 30) {
      const title = text
        .replace(/^[@“「\s]+/u, "")
        .replace(/[：:“「，。！？].*$/u, "");
      scene = {
        title: Array.from(title || text)
          .slice(0, 12)
          .join(""),
        summary: "",
        combat: false,
        shots: [],
      };
      scenes.push(scene);
      elapsed = 0;
    }
    const line = text.match(/^([^：“「\n]{1,16})[：:]\s*([“「].*)$/u);
    const fight = combatWords.test(text);
    const camera = fight
      ? "中景 · 跟拍"
      : line
        ? "近景 · 固定"
        : !scene.shots.length
          ? "全景 · 固定"
          : "中景 · 固定";
    scene.shots.push({
      duration,
      camera,
      action: line ? `${line[1]}开口。` : text,
      dialogue: line ? text : "",
    });
    scene.combat ||= fight;
    if (!scene.summary) scene.summary = text;
    elapsed += duration;
  }
  return scenes;
}

export function createPreviewCards(
  script: string,
  assets: PreviewAsset[],
  combatEnabled: boolean,
): PreviewCard[] {
  const cleaned = script.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) return [];
  const scenes = cleaned === seedScript ? sampleScenes : previewScenes(cleaned);
  return scenes.map((scene, index) => {
    const source = [
      scene.summary,
      ...scene.shots.flatMap((shot) => [shot.action, shot.dialogue]),
    ].join("\n");
    const id = `seq-${index + 1}`;
    const card: PreviewCard = {
      opening: index ? '承接上一段的院落站位与人物视线。' : '本场开场，未提供上一场末帧。',
      scene: '京城别院-院落，雨后。',
      characters: '顾凌天、年长赐酒侍卫、持绳赐酒侍卫。',
      independentGeneration: scene.summary,
      ending: index === scenes.length - 1 ? '本场收束，人物留在院落。' : '承接本段末帧，下一段继续院落内的动作。',
      id,
      title: scene.title,
      summary: scene.summary,
      duration: scene.shots.reduce((sum, shot) => sum + shot.duration, 0),
      assetIds: assets
        .filter((asset) => asset.name && source.includes(asset.name))
        .map((asset) => asset.id),
      shots: scene.shots.map((shot, i) => ({
        ...shot,
        id: `${id}-shot-${i + 1}`,
      })),
      prompt: "",
      combat: scene.combat && combatEnabled,
      status: "draft",
      version: 1,
    };
    card.prompt = buildCardPrompt(card, assets);
    return card;
  });
}

