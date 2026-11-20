import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const backend = fileURLToPath(new URL('..', import.meta.url))
const skill = join(backend, 'workspace/skills/script-to-video')
const sourceRoot = join(skill, 'references/sd25-v2.1')
const fightRoot = join(skill, 'fight-choreography')
// Source fingerprints captured before copying from the user-supplied package.
// Finder metadata and Python bytecode are system caches, not package resources.
const sourceHashes: Record<string, string> = {
  "00-开始使用.md": "9db150c6f5abc61238c1db5ec42429703d7cd43e7a34242c820b6aeac51cf28d",
  "01-一键启动提示词.txt": "9bd433d4bd5a26296f197ac5d9a1c9fba82816ab303879878c357921b3bb1227",
  "02-当前有效总规则.txt": "c38a39060d47f73ec7fdabe8a340844d1a753b80ea1754f4b086f52b0338b074",
  "03-项目设定卡.md": "8be2f383e92e16cbf27625020ff2a3e95fdfa8ee8b2d3c7cb6aa39c62f171f98",
  "04-正式输出模板.md": "c7e2e9f530fd263f81443281cf3f1720f679a71f1724a840a6a19186e68ef983",
  "05-高武题材模块.txt": "7e05627e828084975694668ba601f26a419595be67626069deb5567d61113c79",
  "06-校园喜剧恋爱模块.txt": "a77f3d841406df9a85048870c857f60cca4205f9bf9357400946fda808bc8d5e",
  "07-心声与界面模块.txt": "2151942c55bd2705c33a9469505ee40c8f244f1695d5338c297f03274b9cd64c",
  "08-交付前自检表.md": "cc1624ecda3e0c1036da929836f7e994f757485a070ed0b6435d6c2a9a0eba9b",
  "09-五维镜头优化Skill调用说明.md": "85f50f3983813f61cc52ad8b175e39f2ed307ab851de6ad1d8921f33888df5be",
  "SKILL.md": "5b4365fd7bb6fa25f886c1cead8793f0fafc8bc5f46ee93ec2adfddc02fff483",
  "scripts/check_storyboard_duration.py": "e8c056b2beb238020a3f147b24681ddde54c11c979d810c08df750851e6e6ca4",
  "五维镜头优化Skill-原始参考/SKILL.md": "f105f8dde19acc77c83ac09d6daa9aaaa4a5e2d9b1eee5b30d6911d433550a75",
  "五维镜头优化Skill-原始参考/agents/openai.yaml": "ca36407fccb044ac9d2da99793d18ef57b8f883fda9a5bbe03c6125987055c54",
  "五维镜头优化Skill-原始参考/references/director-modules/DIR-PR-001_v2.1.md": "cdb0d2e08e6c5ab946a6ce2f47b4fb5db5956351b28d3057a317b7e2cf6f44b4",
  "五维镜头优化Skill-原始参考/references/platform-profiles/SD20-001_v1.0.md": "5d07aae7150e1350b18a4d49d46f5e6c340c24fecd9995bdaf3278467f7935a4",
  "五维镜头优化Skill-原始参考/references/platform-profiles/SD25-001_v1.0.md": "6a5a911ef935ab45474579ca8173d3d86c56e7eaa020bf87df177189a7411b71",
  "五维镜头优化Skill-原始参考/references/platform-profiles/SD25-AUTO-HYBRID_v1.0.md": "feccf37cfbca5f61e5d40f14f8bc2eefe30b5c1077ff7a1109d11f0b79f5871e",
  "五维镜头优化Skill-原始参考/references/v8-core-template.md": "2f950031b1fdf464b9e8009155c7d72d792c176173b7c75c6162fbe2bcf97b41",
  "五维镜头优化Skill-原始参考/scripts/audit_storyboard.py": "db3a330f47d7394e4f6dc43a1e8df9bc668072ab390706dafe03dabbb38b90d0",
  "五维镜头优化Skill-原始参考/scripts/test_audit_storyboard.py": "d2cc8ca9b3e916f3342906cc5cd5697d85f057576b072dee35bd24509098cea8",
  "交付清单.md": "67c0a753520e87949b562838ce7bb03856e80e0a992ad0eb11f02fc434bb78ae",
  "原始条例-不得修改/原始优化条例.txt": "7a1f0a8af9a01bd3bca6dfdc293022a7a5e89975a9eded0c62cbfde2bbca9fab",
  "原始条例-不得修改/原始分镜条例.txt": "ddbfba26e322114f0c1d38aba653f5d06fdc38e64c788050d436c902cc3a2a6b",
  "原始条例-不得修改/原始场景条例.txt": "8fa92cc1fab679340b36f3c43e37a455e42a3f5b4cf03762934a46cef0501f21",
  "版本说明.md": "25881c334ad13c937daa460427aa49e9f50b5e58a1f0e824e619232c6eb50a6e",
  "示例/分镜格式示例.md": "bbff61b6e50b8d09d5f4314a60728b219309ba21e332a74b8b035fe87f9383e5"
}
// Combat entry only changes the final Word-source note; its Markdown references remain intact.
const fightHashes: Record<string, string> = {
  "SKILL.md": "0da4df15ae57e7b4269b4fb130eb3d6c59f46fbde2857d42ab215ca5de84b39b",
  "references/01-02-visual-style.md": "fe78b3f8a15b6fd02d18b70da63fe63446bbc3dccbf95e808c6edd0bd0e9cc60",
  "references/03-06-scene-character-effects.md": "56a2e591721f18d186567c4c000d301ba84e4d16cc49378a9b048486c0ac3363",
  "references/07-01-combat-exchanges.md": "cce131711aa93c0dfcd21386eb09c09523f8b42c6aaebd9c5208ba7d883cc478",
  "references/07-08-weapons-and-draw.md": "d34be0dd9c903961a010d3c830769b8257df02e97504ad3aab028163bccb74bb",
  "references/09-10-rhythm-and-outcome.md": "2e72aebfcf5ba3d1a000bbc51d6688eba7c53841010699981ba120338bbf3c47",
  "references/11-camera.md": "ee8ffa582e2b3adee50995bcd98dc701cc7b4a2e5965594bb736c27031a98d92",
  "references/12-01-finisher-structure.md": "45eecbcf1ad597a7bbf4b2ae01f51efc627984bf1ba721c3561cbdcfc741ff11",
  "references/12-02-ink.md": "5c5e3137b0b4162b500994eae4b633c866642b70188b6c086eb717fb327e56db",
  "references/12-03-metal.md": "81469e24c62de4affb7f7f43fce082b556b01a1f6d520eb29403b55c1bd1bd7b",
  "references/12-04-wind.md": "b7cc21af30198392624ca17e39e7368acdcb042afc2c5c3798749072de89551f",
  "references/12-05-lightning.md": "58d5838f22b770a3bef6cd97305583a5dc3ba611c8eb0b48a782424b602ceee9",
  "references/12-06-fire.md": "518596eb49657e8d493032cc17451db4833e948f9b4375c8ae511b15a5df712b",
  "references/12-07-ice.md": "bd83d0a36c18f1132fa938229b86ec0eca0deb9ba63fa958caed54d6eb9ea7d5",
  "references/12-08-poison.md": "2e163c3e2a1178ab47c2cb709fe6ea38052fd885cc73be393d86f6b3a01e71a8",
  "references/12-09-cosmos.md": "cb4ce16dc1a5bb1dce934918f8937bc09367330b67568efdfe18ae7e3d2c3bf8",
  "references/12-10-crystal.md": "e455f3c29757685660fc331a2e0a4a79d75f369abe5ab73e612701c3d057c51d",
  "references/12-11-gravity-space.md": "833d01c024c5730e28afcc216f6646b09173aea09eb08e639cd6af13d49b6c70",
  "references/12-12-chaos-fusion.md": "c3bdb2980bb6a871ce2970771d4c231e8b5d92867c6132ad7cfd1323707bf8e2",
  "references/12-13-archery.md": "6b219a2b64baa0944ea011c68f3dba357a767268de89e94d58709a5c4295d241",
  "references/12-14-other.md": "b039ce8bc598b5d7cd7e3698a7d9a37439a2645fcede8f1d322302d8ba68f5ef",
  "references/13-close-ups.md": "4621bb46a9e4d449207e6d2293e1da781f4d9749a25026434df933c5737bebd7",
  "references/14-dialogue.md": "1bfd851ff67128c9a6d3ac9debe79782e1328938dfc6c15dfa84ecb4fd7faa3d",
  "references/15-16-sequences.md": "24d3b49e3ed4e70d1b03239df8ea5ae3b63b9a9de666d69dd85c0c2dc9a0b68f",
  "references/17-20-output.md": "42942d7a9ca91855133bc64c000750da19a90962b5b6e2310e968b1546efd0a2"
}

function relativeFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.name === '.DS_Store' || entry.name === '__pycache__' || entry.name.endsWith('.pyc')) return []
    return entry.isDirectory() ? relativeFiles(root, rel) : entry.isFile() ? [rel] : []
  }).sort()
}
function checkManifest(root: string, expected: Record<string, string>) {
  assert.ok(existsSync(root), `missing package: ${root}`)
  assert.deepEqual(relativeFiles(root), Object.keys(expected).sort(), 'package contents differ from source manifest')
  for (const [name, hash] of Object.entries(expected)) {
    const actual = createHash('sha256').update(readFileSync(join(root, name))).digest('hex')
    assert.equal(actual, hash, `${name} has changed`)
  }
}
function checkMarkdownLinks(root: string) {
  for (const rel of relativeFiles(root).filter(file => file.endsWith('.md'))) {
    const content = readFileSync(join(root, rel), 'utf8')
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1]!.trim().split(/\s+"/)[0]!
      if (!href || /^(?:https?:|mailto:|#)/i.test(href)) continue
      const path = decodeURIComponent(href.split('#')[0]!)
      assert.ok(existsSync(resolve(dirname(join(root, rel)), path)), `${rel}: missing linked file ${href}`)
    }
  }
}

test('complete original SD2.5 package is preserved byte-for-byte with working relative links', () => {
  checkManifest(sourceRoot, sourceHashes)
  checkMarkdownLinks(sourceRoot)
})

test('combat skill and all references are preserved after moving out of rewriting', () => {
  assert.equal(existsSync(join(backend, 'workspace/skills/script-rewriter/fight-choreography')), false)
  assert.equal(existsSync(join(fightRoot, 'assets/original.docx')), false)
  checkManifest(fightRoot, fightHashes)
  checkMarkdownLinks(fightRoot)
})

test('active skill package has no broken local Markdown links', () => {
  checkMarkdownLinks(skill)
})

test('persistent workspaces ignore legacy combat and archived nested skills during discovery and injection', () => {
  const temp = mkdtempSync(join(tmpdir(), 'skill-discovery-'))
  try {
    function fixture(path: string, name: string, content: string) {
      const dir = join(temp, 'skills', path)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n${content}\n`)
    }
    fixture('script-rewriter/ordinary', 'ordinary', 'ORDINARY_REWRITE_MARKER')
    fixture('script-rewriter/fight-choreography', 'fight-choreography', 'LEGACY_FIGHT_MARKER')
    fixture('script-rewriter/fight-choreography/child', 'child', 'LEGACY_CHILD_MARKER')
    fixture('script-to-video', 'script-to-video', 'VIDEO_MARKER')
    fixture('script-to-video/references/sd25-v2.1/nested', 'archived-skill', 'ARCHIVE_MARKER')
    const moduleUrl = pathToFileURL(join(backend, 'src/agents/skills.ts')).href
    const script = `import { loadAgentSkills, skillsManagerWorkspace } from ${JSON.stringify(moduleUrl)}; (async () => { const instructions = await loadAgentSkills('script_rewriter'); const skills = await skillsManagerWorkspace.skills.list(); console.log(JSON.stringify({ instructions, paths: skills.map(s => s.path) })); })().catch(e => { console.error(e); process.exitCode = 1; })`
    const runner = join(backend, 'node_modules/tsx/dist/cli.mjs')
    const result = spawnSync(process.execPath, [runner, '--eval', script], { env: { ...process.env, WORKSPACE_PATH: temp }, encoding: 'utf8', cwd: backend })
    assert.equal(result.status, 0, result.stderr)
    const data = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { instructions: string; paths: string[] }
    assert.match(data.instructions, /ORDINARY_REWRITE_MARKER/)
    assert.doesNotMatch(data.instructions, /LEGACY_FIGHT_MARKER|LEGACY_CHILD_MARKER|ARCHIVE_MARKER/)
    assert.ok(data.paths.includes('skills/script-to-video'))
    assert.ok(data.paths.includes('skills/script-rewriter/ordinary'))
    assert.ok(!data.paths.some(path => path.includes('fight-choreography') || path.includes('sd25-v2.1')))
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
