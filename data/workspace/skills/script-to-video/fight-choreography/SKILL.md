---
name: fight-choreography
description: 小说转短剧剧本遇到打斗场面时，按原著中的武器、招式和胜负编排攻防、受击反应及对白。也可按系别查阅《高燃打斗视频提示词 Skill》中的大招和视频提示词模板。
---

# 高燃打斗

## 小说转剧本

读到打斗场面时，先从原著确定谁先出手、双方如何应对，以及这场打斗怎样影响后续剧情。按当前场景读取下列原文章节，把选用的动作写进剧本自然段，台词沿用项目的对白格式。人物能力、关键台词和胜负以原著及本次改编要求为准。

- 写交手时，查[攻防与拆招](references/07-01-combat-exchanges.md)；细化某种兵器的起手或连招，查[武器招式与拔刀斩](references/07-08-weapons-and-draw.md)。
- 写重击之后的反应，查[节奏与胜负](references/09-10-rhythm-and-outcome.md)中的 9.2.1；需要边打边说时，查[对话插入规则](references/14-dialogue.md)。
- 写战斗中的地形、衣甲、武器或周身特效，查[场景、角色与特效](references/03-06-scene-character-effects.md)。原著人物使用特定系别的大招时，从下表选读对应招式。

项目内可用 `skill_read` 读取链接中的相对路径，例如 `skill_read({skillName: "fight-choreography", path: "references/07-01-combat-exchanges.md"})`。

## 第十二章大招索引

| 原文章节 | 按系别查招 |
| --- | --- |
| 12.1–12.4 | [终极技能三板斧](references/12-01-finisher-structure.md) · [水墨](references/12-02-ink.md) · [金](references/12-03-metal.md) · [风](references/12-04-wind.md) |
| 12.5–12.8 | [雷](references/12-05-lightning.md) · [火](references/12-06-fire.md) · [冰](references/12-07-ice.md) · [毒](references/12-08-poison.md) |
| 12.9–12.12 | [星辰／宇宙](references/12-09-cosmos.md) · [晶体](references/12-10-crystal.md) · [重力／空间](references/12-11-gravity-space.md) · [混沌／融合](references/12-12-chaos-fusion.md) |
| 12.13–12.14 | [弓术／箭阵](references/12-13-archery.md) · [其他系](references/12-14-other.md) |

## 打斗视频提示词

原文中的镜头语言、技术参数、30 秒时长、默认分出胜负和生成前提问适用于打斗视频提示词。常规小说改编沿用项目的格式化剧本规范。

- 确定画面风格与运镜时，查[全局参数与特效密度](references/01-02-visual-style.md)、[镜头语言](references/11-camera.md)和[特写镜头库](references/13-close-ups.md)。
- 编排多段打斗或查负面提示词时，读[多段设计与设计逻辑总纲](references/15-16-sequences.md)。
- 生成完整提示词时，读[输出模板、生成前提问、快速调用与图片融合](references/17-20-output.md)。

以上参考文件按原文章节保留完整正文、原文措辞和章节编号。
