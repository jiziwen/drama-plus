import assert from "node:assert/strict";
import test from "node:test";
import { groupImportedEpisodes, importEpisodeFile } from "../app/utils/scriptVideoPreviewEpisodes";

test("三个 TXT 按场次归集；跨文件续文和同文件跨集均可定位、重复场不重复计时", () => {
  const scripts = [
    "\r\n**场次**：6-01\r\n**【本场预计时长】**：72秒\r\n甲推门。",
    "🙂乙接话。\r\n**场次**：6-01\r\n**【本场预计时长】**：72秒\r\n丙回身。\r\n**场次**：6-02\r\n丁出门。\r\n**【本场预计时长】**：48秒\r\n",
    "门外脚步远去。\n**场次**：7-01\n**【本场预计时长】**：83秒\n次日。",
  ];
  const files = scripts.map((script, i) => ({
    ...importEpisodeFile(script, "第" + [2, 3, 11][i] + "章.txt")!,
    sourcePath: "七天/第" + [2, 3, 11][i] + "章.txt",
  }));
  const result = groupImportedEpisodes([files[2]!, files[0]!, files[1]!]);
  assert.equal(result.sceneGrouped, true);
  assert.equal(result.sourceCount, 3);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    result.episodes.map((e) => [e.number, e.expectedDuration]),
    [
      [6, 120],
      [7, 83],
    ],
  );
  const [six, seven] = result.episodes;
  assert.deepEqual(six!.sceneEstimates, [
    { sceneId: "6-01", seconds: 72 },
    { sceneId: "6-02", seconds: 48 },
  ]);
  const cut = scripts[2]!.indexOf("**场次");
  assert.deepEqual(
    six!.sourceChapters!.map((c) => c.script),
    [scripts[0], scripts[1], scripts[2]!.slice(0, cut)],
  );
  assert.deepEqual(
    seven!.sourceChapters!.map((c) => c.script),
    [scripts[2]!.slice(cut)],
  );
  for (const f of files) {
    const chunks = result.episodes
      .flatMap((e) => e.sourceChapters!)
      .filter((c) => c.sourcePath === f.sourcePath);
    assert.equal(chunks.map((c) => c.script).join(""), f.script);
    for (const c of chunks) assert.equal(f.script.slice(c.sourceStart, c.sourceEnd), c.script);
  }
});

test("同批次没有场次沿用旧排序；混合批次无来源的首文件保留为未编号", () => {
  const first = importEpisodeFile("前言\n回顾既有剧情。\n正文", "第1章.txt")!;
  const second = importEpisodeFile("第7集 正文", "第2章.txt")!;
  assert.deepEqual(groupImportedEpisodes([first, second]), {
    episodes: [second, first],
    errors: [],
    sceneGrouped: false,
    sourceCount: 2,
  });
  const next = importEpisodeFile("\n**场次**：4-01\n**【本场预计时长】**：25秒", "第2章.txt")!;
  const result = groupImportedEpisodes([next, first]);
  assert.deepEqual(
    result.episodes.map((e) => e.number),
    [4, undefined],
  );
  assert.equal(result.episodes[1]!.script, first.script);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /第1章.*归属/);
});

test("时长仅取明确的本场声明，缺失或冲突不给整集编造总秒数", () => {
  const result = groupImportedEpisodes([
    {
      title: "1",
      script:
        "**场次**：2-01\n**【本场预计时长】**：31.5秒\n他说：“场次：9-09，本场预计时长：80秒。”\n场次：2-02\n待定。",
    },
    {
      title: "2",
      script:
        "场次：3-01\n【本场预计时长】：30秒\n新版本仍需保留。\n场次：3-01\n【本场预计时长】：35秒",
    },
    { title: "3", script: "场次：4-01\n预计时长：暂无。" },
  ]);
  assert.deepEqual(
    result.episodes.map((item) => item.expectedDuration),
    [undefined, undefined, undefined],
  );
  assert.deepEqual(
    result.episodes.map((item) => item.sceneEstimates),
    [[{ sceneId: "2-01", seconds: 31.5 }], [], []],
  );
  assert.equal(result.errors.length, 3);
  assert.match(result.errors.join("\n"), /2-02.*缺少/);
  assert.match(result.errors.join("\n"), /3-01.*冲突/);
  assert.match(result.errors.join("\n"), /4-01.*缺少/);
});

test("有场次时正文识别的旧集号不改变章节顺序；新章场次前仅有的换行仍归新场次", () => {
  const a = importEpisodeFile("场次：１－０１\n【本场预计时长】：70秒", "第九章.txt")!;
  const b = importEpisodeFile("第888集 回顾\n续上章剧情。", "第十章.txt")!;
  const c = importEpisodeFile("\r\n\r\n场次：2-01\r\n【本场预计时长】：30秒", "第十一章.txt")!;
  const result = groupImportedEpisodes([b, c, a]);
  assert.deepEqual(
    result.episodes.map((e) => e.title),
    ["第九章、第十章", "第十一章"],
  );
  assert.deepEqual(
    result.episodes.map((e) => e.expectedDuration),
    [70, 30],
  );
  assert.equal(result.episodes[1]!.script, c.script);
  assert.deepEqual(result.episodes[1]!.sourceChapters, [
    { title: c.title, script: c.script, sourceStart: 0, sourceEnd: c.script.length },
  ]);
});

test("混合导入保留无场次首文件已有的明确集号，不并入后续场次", () => {
  for (const name of ["01_EP12_归来.txt", "01_第十二集_归来.txt"]) {
    const explicit = { ...importEpisodeFile("门开了。", name)!, sourcePath: "剧本/" + name };
    const withScene = importEpisodeFile(
      "**场次**：13-01\n**【本场预计时长】**：90秒",
      "02_新场次.txt",
    )!;
    const result = groupImportedEpisodes([withScene, explicit]);
    const episode = result.episodes.find((row) => row.number === 12);
    assert.equal(episode?.script, explicit.script);
    assert.equal(episode?.sourcePath, explicit.sourcePath);
    assert.equal(episode?.sourceChapters?.[0]?.sourceEnd, explicit.script.length);
    assert.deepEqual(
      result.episodes.find((row) => row.number === 13)?.sourceChapters?.map((c) => c.title),
      [withScene.title],
    );
    assert.equal(result.errors.length, 1);
  }
});
