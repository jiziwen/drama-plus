<template>
  <div class="drama-bench">
    <header class="drama-top">
      <div class="drama-heading">
        <div class="drama-mark"><PenLine :size="22" aria-hidden="true" /></div>
        <div>
          <h1>一键下沉</h1>
          <p>从对标文案开始，写完整部下沉剧。</p>
        </div>
      </div>
      <div class="drama-inline" v-if="directory.length">
        <label class="project-picker">
          <span>剧本项目</span>
          <select :value="draft?.id || ''" :disabled="sending || loading" @change="openProject(($event.target as HTMLSelectElement).value)">
            <option v-for="project in directory" :key="project.id" :value="project.id">{{ project.title }}</option>
          </select>
        </label>
        <button class="btn" type="button" :disabled="sending || loading" @click="creating = !creating">
          <Plus :size="15" aria-hidden="true" /> 新建项目
        </button>
        <button v-if="draft && !creating" class="btn drama-delete-trigger" type="button" :disabled="sending || loading" @click="requestDelete">
          <Trash2 :size="15" aria-hidden="true" /> 删除项目
        </button>
      </div>
    </header>

    <p v-if="error" class="drama-banner error" role="alert">
      <CircleAlert :size="17" aria-hidden="true" /> {{ error }}
      <button v-if="!draft" class="btn btn-sm" type="button" @click="loadDirectory">重新加载</button>
      <button v-else-if="conflict" class="btn btn-sm" type="button" @click="openProject(draft.id)">读取最新版本</button>
    </p>
    <div v-if="loading" class="drama-paper drama-empty" role="status"><LoaderCircle class="drama-spin" :size="24" />正在读取项目…</div>

    <form v-else-if="!draft || creating" class="drama-paper drama-start" @submit.prevent="create">
      <div class="drama-mark"><FileText :size="23" aria-hidden="true" /></div>
      <div>
        <h2>新建下沉剧</h2>
        <p>先起一个项目名。选题后可以在大纲里确定正式剧名。</p>
      </div>
      <label class="drama-field">
        项目名称
        <input v-model="newTitle" placeholder="例如：小镇翻身记" maxlength="100" required>
      </label>
      <div class="drama-inline">
        <button class="btn btn-primary" type="submit" :disabled="sending || !newTitle.trim()">创建剧本项目 <ArrowRight :size="15" /></button>
        <button v-if="draft" class="btn" type="button" :disabled="sending" @click="creating = false">取消</button>
      </div>
    </form>

    <template v-if="draft && !loading && !creating">
      <nav class="drama-steps" aria-label="下沉剧创作流程">
        <button v-for="step in steps" :key="step.key" type="button" :disabled="!canOpen(step.key)"
          :aria-current="stage === step.key ? 'step' : undefined" @click="selectStage(step.key)">
          <component :is="step.icon" :size="16" aria-hidden="true" /> {{ step.label }}
          <Check v-if="isComplete(step.key)" :size="14" class="step-check" aria-label="已完成" />
        </button>
      </nav>

      <section class="drama-models" aria-label="项目生成模型">
        <div v-for="menu in modelMenus" :key="menu.kind" class="drama-model">
          <span>{{ menu.label }}</span>
          <BaseSelect
            :model-value="modelValue(menu.kind)"
            :options="modelOptions(menu.kind)"
            :aria-label="menu.label"
            :searchable="modelOptions(menu.kind).length > 8"
            :disabled="busy || modelsLoading"
            variant="inspector"
            @update:model-value="selectModel(menu.kind, $event)"
          />
        </div>
        <small v-if="modelsLoading" role="status">正在读取模型…</small>
        <button v-else-if="modelsError" class="btn btn-sm" type="button" @click="loadModels">重新读取模型</button>
        <small v-else-if="missingModelKinds">请在右上角设置启用{{ missingModelKinds }}模型。</small>
      </section>

      <div v-if="draft.job?.status === 'running'" class="drama-banner" role="status">
        <LoaderCircle class="drama-spin" :size="17" aria-hidden="true" /> {{ draft.job.phase }}…
        <button v-if="!['image', 'deliver'].includes(draft.job.action)" class="btn btn-sm" type="button" :disabled="sending" @click="send({ action: 'stop' })">{{ draft.job.action === 'images' ? '停止后续出图' : '停止' }}</button>
      </div>
      <p v-else-if="draft.job?.status === 'failed'" class="drama-banner error" role="alert"><CircleAlert :size="17" aria-hidden="true" /> {{ draft.job.error }}</p>
      <p v-if="pollError" class="drama-banner error" role="status">{{ pollError }}</p>

      <div v-if="stage === 'reference'" class="drama-columns reference-columns">
        <section class="drama-paper">
          <div class="drama-section-head">
            <div><h2>对标材料</h2><p>拆解开场冲突、情绪节奏和章尾钩子。</p></div>
            <label v-if="!draft.outlineConfirmed" class="btn drama-upload">
              <Upload :size="15" aria-hidden="true" /> {{ uploadingReference ? '正在保存…' : '导入 TXT / MD' }}
              <input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" :disabled="busy" @change="importReference">
            </label>
          </div>
          <div v-if="draft.referenceFile" class="drama-reference-file">
            <div class="drama-section-head">
              <div>
                <h3>{{ draft.referenceFile.name }}</h3>
                <p>{{ formatReferenceSize(draft.referenceFile.bytes) }} · {{ formatCount(draft.referenceFile.characters) }} 字符 · 原文已保存</p>
              </div>
              <button v-if="!draft.outlineConfirmed" class="btn btn-sm" type="button" :disabled="busy" @click="clearReference">移除文件</button>
            </div>
            <label class="drama-field">开头预览<textarea :value="draft.referenceFile.preview" rows="8" readonly /></label>
          </div>
          <label v-else class="drama-field">
            对标文案
            <textarea v-model="brief.reference" rows="13" placeholder="粘贴对标文案，或导入 TXT / MD…" :readonly="draft.outlineConfirmed" :disabled="busy" />
          </label>
          <label class="drama-field">
            创作方向（可选）
            <textarea v-model="brief.direction" rows="3" placeholder="题材、目标受众、原创设定、要加强的冲突…" maxlength="4000" :readonly="draft.outlineConfirmed" :disabled="busy" />
          </label>
          <div v-if="!draft.outlineConfirmed" class="drama-inline">
            <button class="btn btn-primary" type="button" :disabled="busy || !briefValid" @click="analyze"><Sparkles :size="15" /> {{ draft.pitches ? '重新拆解并给选题' : '拆解文案并给出三个选题' }}</button>
            <button class="btn" type="button" :disabled="busy || !briefValid || !briefDirty" @click="saveBrief">保存材料</button>
          </div>
          <p v-if="fileNotice" role="status">{{ fileNotice }}</p>
          <p v-else-if="!draft.outlineConfirmed && !draft.referenceFile" class="drama-source-hint">支持 {{ DRAMA_REFERENCE_UPLOAD_MB }} MB 以内的文本。超出模型容量时自动分批分析。</p>
        </section>
        <aside class="drama-paper">
          <h2>创作规格</h2>
          <fieldset :disabled="busy || draft.outlineConfirmed" class="drama-specs">
            <label class="drama-field">章节数<input v-model.number="brief.chapterCount" type="number" min="1" max="20" step="1"></label>
            <label class="drama-field">每章约字数<input v-model.number="brief.chapterWords" type="number" min="500" max="3500" step="100"></label>
            <label class="drama-field">全剧时长（分钟）<input v-model.number="brief.runtimeMinutes" type="number" min="5" max="100" step="1"></label>
            <label class="drama-field">成片形式<select v-model="brief.style"><option value="live">仿真人</option><option value="3d">3D 漫剧</option></select></label>
            <label class="drama-choice"><input v-model="brief.humor" type="checkbox"> 审核时检查可自然加入的轻梗</label>
          </fieldset>
          <div class="drama-spec-total"><strong>{{ formatCount(brief.chapterCount * brief.chapterWords) }}</strong><span>全剧预计字数 · 含标点</span></div>
        </aside>
      </div>

      <section v-else-if="stage === 'outline'" class="drama-paper">
        <div class="drama-section-head">
          <div><h2>选题与大纲</h2><p>先选一个冲突切口，再逐章检查大纲。</p></div>
          <span v-if="draft.outlineConfirmed" class="drama-tag">大纲已确认</span>
        </div>
        <details v-if="draft.analysis" class="drama-details"><summary>对标结构分析</summary><p class="drama-prose">{{ draft.analysis }}</p></details>
        <fieldset class="drama-pitches" :disabled="busy || draft.outlineConfirmed" aria-label="三个原创故事切口">
          <label v-for="(item, index) in draft.pitches" :key="index" class="drama-pitch" :class="{ selected: pitchIndex === index }">
            <span class="drama-pitch-title"><input v-model="pitchIndex" type="radio" name="downmarket-pitch" :value="index">{{ item.title }}</span>
            <strong>{{ item.conflict }}</strong>
            <span>{{ item.premise }}</span>
            <small>追看钩子 · {{ item.hook }}</small>
          </label>
        </fieldset>
        <div v-if="!draft.outlineConfirmed" class="drama-outline-actions">
          <label class="drama-field">大纲调整要求（可选）<input v-model="outlineNotes" placeholder="例如：提前揭露对手目标，第 5 章回收欠条伏笔" maxlength="6000" :disabled="busy"></label>
          <button class="btn" :class="{ 'btn-primary': !outline }" type="button" :disabled="busy || pitchIndex === undefined" @click="requestOutline">
            <Sparkles :size="15" /> {{ outline ? '按选题和要求重做大纲' : '生成详细大纲' }}
          </button>
        </div>
        <div v-if="outline" class="drama-outline">
          <h3>故事设定</h3>
          <label class="drama-field">剧名<input v-model="outline.title" maxlength="100" :readonly="draft.outlineConfirmed" :disabled="busy"></label>
          <div class="drama-columns">
            <label class="drama-field">世界观与关键物件<textarea v-model="outline.world" rows="5" maxlength="5000" :readonly="draft.outlineConfirmed" :disabled="busy" /></label>
            <label class="drama-field">人物设定<textarea v-model="outline.characters" rows="5" maxlength="5000" :readonly="draft.outlineConfirmed" :disabled="busy" /></label>
          </div>
          <h3>逐章大纲</h3>
          <details v-for="(plan, index) in outline.chapters" :key="index" class="drama-details" :open="index === 0">
            <summary>第 {{ index + 1 }} 章 · {{ plan.title }}</summary>
            <label class="drama-field">章名<input v-model="plan.title" maxlength="100" :readonly="draft.outlineConfirmed" :disabled="busy"></label>
            <label class="drama-field">章纲<textarea v-model="plan.plan" rows="4" maxlength="2000" :readonly="draft.outlineConfirmed" :disabled="busy" /></label>
          </details>
          <div v-if="!draft.outlineConfirmed" class="drama-inline">
            <button class="btn btn-primary" type="button" :disabled="busy || !outlineValid || draft.selectedPitch !== pitchIndex" @click="confirmOutline">确认大纲，进入逐章写作 <ArrowRight :size="15" /></button>
            <span v-if="draft.selectedPitch !== pitchIndex">已切换选题，请先按新选题生成大纲。</span>
          </div>
        </div>
      </section>

      <div v-else-if="stage === 'write'" class="drama-columns writing-columns">
        <aside class="drama-paper drama-chapter-list">
          <h2>章节目录</h2>
          <p>{{ draft.chapters.length }} / {{ draft.brief.chapterCount }} 章 · {{ formatCount(totalWords) }} 字</p>
          <button v-for="(plan, index) in draft.outline?.chapters" :key="index" type="button" class="drama-chapter-link"
            :aria-pressed="chapterNumber === index + 1" @click="selectChapter(index + 1)">
            <span>第 {{ index + 1 }} 章</span><strong>{{ draft.chapters[index]?.title || plan.title }}</strong>
            <Check v-if="draft.chapters[index]" :size="14" aria-label="已写" />
          </button>
        </aside>
        <section class="drama-paper">
          <div class="drama-section-head">
            <div><h2>逐章写作</h2><p>每次写一章。下一章沿用定稿中的剧情和承接信息。</p></div>
            <button v-if="!allWritten" class="btn btn-primary" type="button" :disabled="busy || chapterDirty" @click="send({ action: 'write' })">
              <Sparkles :size="15" /> {{ draft.chapters.length ? '继续写第 ' + (draft.chapters.length + 1) + ' 章' : '开始写第一章' }}
            </button>
            <button v-else class="btn btn-primary" type="button" :disabled="chapterDirty" @click="selectStage('review')">进入剧本优化 <ArrowRight :size="15" /></button>
          </div>
          <p v-if="chapterDirty" class="drama-hint">继续写作前请先保存正文，或恢复本章。</p>
          <template v-if="chapterEdit">
            <p class="drama-chapter-count">第 {{ chapterNumber }} 章 · {{ formatCount(countWords(chapterEdit.text)) }} 字（含标点）· 目标约 {{ formatCount(draft.brief.chapterWords) }} 字</p>
            <label class="drama-field">章名<input v-model="chapterEdit.title" maxlength="100" :disabled="busy || Boolean(draft.candidate)"></label>
            <label class="drama-field">剧本正文<textarea v-model="chapterEdit.text" class="drama-script" rows="18" maxlength="14000" :disabled="busy || Boolean(draft.candidate)" /></label>
            <details class="drama-details">
              <summary>章末小结、承接记录和台词理由</summary>
              <label class="drama-field">章末小结<textarea v-model="chapterEdit.summary" rows="3" maxlength="1600" :disabled="busy || Boolean(draft.candidate)" /></label>
              <label class="drama-field">承接记录<textarea v-model="chapterEdit.continuity" rows="3" maxlength="2000" :disabled="busy || Boolean(draft.candidate)" /></label>
              <label class="drama-field">台词理由<textarea v-model="chapterEdit.dialogueNotes" rows="3" maxlength="1600" :disabled="busy || Boolean(draft.candidate)" /></label>
            </details>
            <div v-if="chapterDirty" class="drama-inline">
              <button class="btn btn-primary" type="button" :disabled="busy || !validChapter(chapterEdit)" @click="saveChapter(chapterNumber, chapterEdit)">保存本章</button>
              <button class="btn" type="button" :disabled="busy" @click="selectChapter(chapterNumber, true)">恢复已保存正文</button>
            </div>
          </template>
          <template v-else>
            <h3>第 {{ chapterNumber }} 章 · {{ draft.outline?.chapters[chapterNumber - 1]?.title }}</h3>
            <p class="drama-prose">{{ draft.outline?.chapters[chapterNumber - 1]?.plan }}</p>
            <p class="drama-hint">正文将按目录顺序生成。</p>
          </template>
        </section>
      </div>

      <div v-else-if="stage === 'review'" class="drama-columns review-columns">
        <section class="drama-paper">
          <div class="drama-section-head">
            <div><h2>剧本优化</h2><p>检查全剧和前三章。先看建议，再确认修改稿。</p></div>
            <span v-if="draft.finalized" class="drama-tag">剧本已定稿</span>
          </div>
          <details class="drama-details" open>
            <summary>全剧逻辑检查</summary>
            <button class="btn" type="button" :disabled="busy" @click="send({ action: 'logic' })"><ScanLine :size="15" /> {{ draft.logic ? '重新检查全剧' : '检查剧本逻辑' }}</button>
            <template v-if="draft.logic">
              <p class="drama-prose">{{ draft.logic.verdict }}</p>
              <div v-for="group in logicGroups" :key="group.chapter" class="drama-plan">
                <h3>第 {{ group.chapter }} 章</h3>
                <ul><li v-for="(issue, index) in group.issues" :key="index"><strong>{{ issue.problem }}</strong><p>{{ issue.fix }}</p></li></ul>
                <button class="btn" type="button" :disabled="busy || Boolean(draft.candidate)" @click="revise(group.chapter, 'logic')">按方案生成修改稿</button>
              </div>
            </template>
          </details>
          <details class="drama-details">
            <summary>第一章开头前置</summary>
            <label class="drama-field">开头方式
              <select v-model="openingMode" :disabled="busy"><option value="conflict">冲突式</option><option value="narrated">解说式</option></select>
            </label>
            <label v-if="openingMode === 'narrated'" class="drama-field">参考开头（留空使用对标文案开头）
              <textarea v-model="openingReference" rows="3" maxlength="6000" :disabled="busy" />
            </label>
            <label class="drama-field">调整要求（可选）<input v-model="openingNotes" maxlength="6000" :disabled="busy"></label>
            <button class="btn" type="button" :disabled="busy" @click="send({ action: 'opening', mode: openingMode, reference: openingReference, notes: openingNotes })"><Sparkles :size="15" /> 生成三个开头</button>
            <div v-if="draft.opening?.mode === openingMode" class="drama-opening-options">
              <div v-for="(option, index) in draft.opening.options" :key="index" class="drama-plan">
                <h3>{{ option.title }}</h3>
                <p class="drama-prose">{{ option.text }}</p>
                <button class="btn btn-sm" type="button" :disabled="busy" @click="openingEdit = option.text">载入编辑</button>
              </div>
              <label class="drama-field">
                人工确认开头
                <textarea v-model="openingEdit" rows="5" maxlength="6000" placeholder="载入后可以逐句调整，确认后再接入第一章。" :disabled="busy" />
              </label>
              <button class="btn" type="button" :disabled="busy || !openingEdit.trim() || Boolean(draft.candidate)" @click="revise(1, 'opening', openingEdit)">采用并生成第一章修改稿</button>
            </div>
          </details>
          <details class="drama-details">
            <summary>前三章节奏</summary>
            <div class="drama-inline">
              <button v-for="number in Math.min(3, draft.chapters.length)" :key="number" class="btn btn-sm" type="button"
                :aria-pressed="paceChapter === number" @click="paceChapter = number">第 {{ number }} 章</button>
            </div>
            <button class="btn" type="button" :disabled="busy" @click="send({ action: 'pace', chapter: paceChapter })"><ScanLine :size="15" /> 检查本章节奏</button>
            <template v-if="pace">
              <p class="drama-prose">{{ pace.plan }}</p>
              <button v-if="pace.needsEdit" class="btn" type="button" :disabled="busy || Boolean(draft.candidate)" @click="revise(paceChapter, 'pace')">按方案生成修改稿</button>
              <p v-else class="drama-hint">本章可保留原稿。</p>
            </template>
          </details>
          <div class="drama-inline">
            <button v-if="!draft.finalized" class="btn btn-primary" type="button" :disabled="busy || Boolean(draft.candidate)" @click="send({ action: 'finalize' })">确认定稿，进入资产与分镜 <ArrowRight :size="15" /></button>
            <button v-else class="btn btn-primary" type="button" :disabled="Boolean(draft.candidate)" @click="selectStage('production')">打开资产与分镜 <ArrowRight :size="15" /></button>
            <button class="btn" type="button" @click="downloadScript"><Download :size="15" /> 下载全剧 TXT</button>
          </div>
        </section>
        <section class="drama-paper">
          <template v-if="candidateEdit && draft.candidate">
            <div class="drama-section-head"><div><h2>第 {{ draft.candidate.chapter }} 章修改稿</h2><p>确认保存后，修改稿会替换当前章正文。</p></div></div>
            <details class="drama-details"><summary>展开当前章正文对照</summary><p class="drama-prose">{{ draft.chapters[draft.candidate.chapter - 1]?.text }}</p></details>
            <label class="drama-field">章名<input v-model="candidateEdit.title" maxlength="100" :disabled="busy"></label>
            <label class="drama-field">修改稿 · {{ formatCount(countWords(candidateEdit.text)) }} 字<textarea v-model="candidateEdit.text" rows="15" maxlength="14000" class="drama-script" :disabled="busy" /></label>
            <details class="drama-details">
              <summary>章末小结、承接记录和台词理由</summary>
              <label class="drama-field">章末小结<textarea v-model="candidateEdit.summary" rows="3" maxlength="1600" :disabled="busy" /></label>
              <label class="drama-field">承接记录<textarea v-model="candidateEdit.continuity" rows="3" maxlength="2000" :disabled="busy" /></label>
              <label class="drama-field">台词理由<textarea v-model="candidateEdit.dialogueNotes" rows="3" maxlength="1600" :disabled="busy" /></label>
            </details>
            <div class="drama-inline">
              <button class="btn btn-primary" type="button" :disabled="busy || !validChapter(candidateEdit)" @click="saveChapter(draft.candidate.chapter, candidateEdit)">确认替换本章</button>
              <button class="btn" type="button" :disabled="busy" @click="send({ action: 'discardCandidate' })">放弃修改稿</button>
            </div>
          </template>
          <template v-else>
            <h2>全剧通读</h2>
            <p>{{ draft.chapters.length }} 章 · {{ formatCount(totalWords) }} 字</p>
            <details v-for="(chapter, index) in draft.chapters" :key="index" class="drama-details">
              <summary>第 {{ index + 1 }} 章 · {{ chapter.title }}</summary>
              <p class="drama-prose">{{ chapter.text }}</p>
            </details>
          </template>
        </section>
      </div>

      <section v-else class="drama-paper">
        <div class="drama-section-head">
          <div><h2>资产与分镜</h2><p>{{ draft.brief.style === 'live' ? '仿真人' : '3D 漫剧' }} · 横屏 16:9</p></div>
          <div class="drama-inline">
            <button class="btn" :class="{ 'btn-primary': !draft.assetsCurrent }" type="button" :disabled="busy || runningImages" @click="send({ action: 'assets' })">
              <Sparkles :size="15" /> {{ draft.assets.length ? '更新资产清单' : '提取人物、场景和物品' }}
            </button>
            <button v-if="draft.assetsCurrent && missingImages" class="btn" type="button" :disabled="busy || runningImages" @click="send({ action: 'images' })">
              逐项生成 {{ missingImages }} 张缺图
            </button>
          </div>
        </div>
        <p v-if="!draft.assetsCurrent" class="drama-hint">{{ draft.assets.length ? '剧本有新定稿，请更新资产清单。' : '从定稿提取每个资产的生图提示词，再为各项分别出图。' }}</p>
        <template v-if="draft.assets.length">
          <div class="drama-asset-grid">
            <DownmarketDramaAsset v-for="asset in draft.assets" :key="asset.id" :asset="asset" :disabled="busy || !draft.assetsCurrent"
              @generate="send" @recover="retryImageDelivery" />
          </div>
          <footer v-if="draft.assetsCurrent" class="drama-delivery">
            <div>
              <h3>交接到剧本转视频</h3>
              <p>{{ draft.chapters.length }} 个分集 · {{ draft.assets.length - missingImages }} / {{ draft.assets.length }} 张资产图就绪</p>
            </div>
            <div class="drama-inline">
              <label v-if="missingImages && !draft.delivery" class="drama-choice">
                <input v-model="allowMissingImages" type="checkbox" :disabled="busy"> 允许带缺图移交
              </label>
              <NuxtLink v-if="draft.delivery" :to="deliveryLink" class="btn btn-primary">打开分镜制作 <ArrowUpRight :size="15" /></NuxtLink>
              <button v-else class="btn btn-primary" type="button" :disabled="busy || runningImages || (missingImages > 0 && !allowMissingImages)" @click="send({ action: 'deliver', allowMissingImages })">移交剧本与资产 <ArrowRight :size="15" /></button>
            </div>
          </footer>
        </template>
      </section>
    </template>
    <dialog ref="deleteDialog" class="drama-delete-dialog" aria-labelledby="drama-delete-title" aria-describedby="drama-delete-message"
      @cancel="sending && $event.preventDefault()" @close="pendingDelete = undefined">
      <h2 id="drama-delete-title">删除项目</h2>
      <p id="drama-delete-message">「{{ pendingDelete?.title }}」的对标文案、剧本和资产记录将永久删除。已移交的制作项目由「剧本转视频」独立管理。</p>
      <p v-if="deleteError" class="drama-delete-error" role="alert">{{ deleteError }}</p>
      <div class="drama-inline">
        <button class="btn" type="button" autofocus :disabled="sending" @click="deleteDialog?.close()">取消</button>
        <button class="btn btn-danger" type="button" :disabled="sending" @click="deleteProject">
          {{ sending ? '正在删除…' : '确认删除' }}
        </button>
      </div>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { ArrowRight, ArrowUpRight, Check, CircleAlert, Clapperboard, Download, FileText, ListTree, LoaderCircle, PenLine, Plus, ScanLine, Sparkles, Trash2, Upload } from 'lucide-vue-next'
import { downmarketDramaAPI, taskAPI } from '~/composables/useApi'
import { DRAMA_INLINE_REFERENCE_CHARACTERS, DRAMA_REFERENCE_UPLOAD_BYTES, DRAMA_REFERENCE_UPLOAD_MB } from '../../../backend/src/services/downmarket-drama-types'
import type { DownmarketDrama, DownmarketDramaListItem, DramaBrief, DramaChapter, DramaCommand, DramaModelKind, DramaModelOption, DramaModelSelection, DramaOpeningMode, DramaOutline, DramaRevisionSource } from '../../../backend/src/services/downmarket-drama-types'

const steps = [
  { key: 'reference', label: '对标材料', icon: FileText },
  { key: 'outline', label: '选题与大纲', icon: ListTree },
  { key: 'write', label: '逐章写作', icon: PenLine },
  { key: 'review', label: '剧本优化', icon: ScanLine },
  { key: 'production', label: '资产与分镜', icon: Clapperboard },
] as const
type Stage = typeof steps[number]['key']

const route = useRoute()
const router = useRouter()
const { revision: settingsRevision } = useSettingsPanel()
const modelLabel = useModelLabel()
const modelMenus = [{ kind: 'text', label: 'LLM（文字模型）' }, { kind: 'image', label: '生图模型' }] as const
const availableModels = ref<DramaModelOption[]>([])
const modelsLoading = ref(true)
const modelsError = ref(false)
const missingModelKinds = computed(() => modelMenus
  .filter(menu => !availableModels.value.some(option => option.kind === menu.kind))
  .map(menu => menu.kind === 'text' ? '文字' : '生图').join('和'))
const directory = ref<DownmarketDramaListItem[]>([])
const draft = shallowRef<DownmarketDrama>()
const stage = ref<Stage>('reference')
const loading = ref(true)
const creating = ref(false)
const sending = ref(false)
const deleteDialog = ref<HTMLDialogElement>()
const pendingDelete = ref<Pick<DownmarketDrama, 'id' | 'title'>>()
const deleteError = ref('')
const newTitle = ref('')
const error = ref('')
const conflict = ref(false)
const pollError = ref('')
const fileNotice = ref('')
const uploadingReference = ref(false)
const brief = ref<DramaBrief>({ reference: '', direction: '', chapterCount: 15, chapterWords: 2800, runtimeMinutes: 65, style: 'live', humor: false })
const pitchIndex = ref<number>()
const outline = ref<DramaOutline>()
const outlineNotes = ref('')
const chapterNumber = ref(1)
const chapterEdit = ref<DramaChapter>()
const openingMode = ref<DramaOpeningMode>('conflict')
const openingReference = ref('')
const openingNotes = ref('')
const openingEdit = ref('')
const paceChapter = ref(1)
const candidateEdit = ref<DramaChapter>()
const allowMissingImages = ref(false)
const formatter = new Intl.NumberFormat('zh-CN')
const formatCount = (value: number) => formatter.format(value)
const formatReferenceSize = (bytes: number) => bytes < 1024 * 1024
  ? Math.ceil(bytes / 1024) + ' KB' : (bytes / (1024 * 1024)).toFixed(1) + ' MB'
const countWords = (value: string) => Array.from(value.replace(/\s/gu, '')).length
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

const busy = computed(() => sending.value || draft.value?.job?.status === 'running')
const allWritten = computed(() => Boolean(draft.value && draft.value.chapters.length === draft.value.brief.chapterCount))
const missingImages = computed(() => draft.value?.assets.filter(item => !item.image).length || 0)
const runningImages = computed(() => draft.value?.assets.some(item => item.imageStatus === 'running') ?? false)
const briefDirty = computed(() => !same(brief.value, draft.value?.brief))
const briefValid = computed(() => Boolean(draft.value?.referenceFile || brief.value.reference.trim()) && [
  [brief.value.chapterCount, 1, 20], [brief.value.chapterWords, 500, 3500], [brief.value.runtimeMinutes, 5, 100],
].every(([value, min, max]) => Number.isInteger(value) && value! >= min! && value! <= max!))
const outlineValid = computed(() => Boolean(outline.value?.title.trim() && outline.value.world.trim() &&
  outline.value.characters.trim() && outline.value.chapters.every(plan => plan.title.trim() && plan.plan.trim())))
const chapterDirty = computed(() => Boolean(chapterEdit.value && !same(chapterEdit.value, draft.value?.chapters[chapterNumber.value - 1])))
const validChapter = (value: DramaChapter) => Object.values(value).every(text => text.trim())
const totalWords = computed(() => draft.value?.chapters.reduce((total, chapter) => total + countWords(chapter.text), 0) || 0)
const pace = computed(() => draft.value?.pacing[paceChapter.value])
const logicGroups = computed(() => {
  const groups = new Map<number, NonNullable<DownmarketDrama['logic']>['issues']>()
  for (const issue of draft.value?.logic?.issues || []) {
    const group = groups.get(issue.chapter) || []
    group.push(issue)
    groups.set(issue.chapter, group)
  }
  return Array.from(groups, ([chapter, issues]) => ({ chapter, issues })).sort((a, b) => a.chapter - b.chapter)
})
const deliveryLink = computed(() => ({
  path: '/script-to-video',
  query: { interface: route.query.interface, project: draft.value?.delivery?.projectId, episode: draft.value?.delivery?.episodeId },
}))

const modelKey = (choice: DramaModelSelection) => choice.configId + '/' + choice.model
function modelValue(kind: DramaModelKind) {
  const selection = draft.value?.models?.[kind]
  return selection ? modelKey(selection) : ''
}

function modelOptions(kind: DramaModelKind) {
  const options = availableModels.value.filter(option => option.kind === kind).map(option => ({
    value: modelKey(option), label: modelLabel(option.model) + ' · ' + option.configName, disabled: false,
  }))
  const current = draft.value?.models?.[kind]
  if (current && !options.some(option => option.value === modelKey(current))) {
    const status = modelsLoading.value || modelsError.value ? '' : '（已不可用）'
    options.unshift({ value: modelKey(current), label: modelLabel(current.model) + status, disabled: true })
  }
  return [{ value: '', label: '跟随全局默认', disabled: false }, ...options]
}

async function selectModel(kind: DramaModelKind, value: string | number) {
  if (value === modelValue(kind)) return
  const option = availableModels.value.find(item => item.kind === kind && modelKey(item) === value)
  if (value !== '' && !option) return
  await send({ action: 'selectModel', kind, selection: option ? { configId: option.configId, model: option.model } : null })
}

function canOpen(target: Stage) {
  if (loading.value || !draft.value) return false
  if (target === 'reference') return true
  if (target === 'outline') return !!draft.value.pitches?.length
  if (target === 'write') return draft.value.outlineConfirmed
  if (target === 'review') return allWritten.value
  return draft.value.finalized && !draft.value.candidate
}

function isComplete(target: Stage) {
  if (target === 'reference') return Boolean(draft.value?.pitches)
  if (target === 'outline') return draft.value?.outlineConfirmed
  if (target === 'write') return allWritten.value
  if (target === 'review') return draft.value?.finalized
  return Boolean(draft.value?.delivery)
}

function selectStage(target: Stage) {
  if (!canOpen(target)) return
  if (chapterDirty.value && target !== 'write') {
    error.value = '请先保存本章或恢复已保存正文。'
    return
  }
  stage.value = target
  error.value = ''
}

function selectChapter(number: number, restore = false) {
  if (!restore && chapterNumber.value === number) return
  if (chapterDirty.value && !restore && chapterNumber.value !== number) {
    error.value = '请先保存本章或恢复已保存正文。'
    return
  }
  chapterNumber.value = number
  const chapter = draft.value?.chapters[number - 1]
  chapterEdit.value = chapter ? copy(chapter) : undefined
  error.value = ''
}

let alive = true
let pollTimer: ReturnType<typeof setTimeout> | undefined
let reading = false
let modelListRequest = 0

async function loadModels() {
  const request = ++modelListRequest
  modelsLoading.value = true
  modelsError.value = false
  try {
    const options = await downmarketDramaAPI.models()
    if (alive && request === modelListRequest) availableModels.value = options
  } catch {
    if (alive && request === modelListRequest) modelsError.value = true
  } finally {
    if (alive && request === modelListRequest) modelsLoading.value = false
  }
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer)
  if (!alive || loading.value || !(draft.value?.job?.status === 'running' || runningImages.value)) return
  pollTimer = setTimeout(poll, document.hidden ? 5000 : 1600)
}

async function poll() {
  const current = draft.value
  if (!current || !alive || loading.value) return
  if (reading || sending.value) { schedulePoll(); return }
  reading = true
  try {
    const status = await downmarketDramaAPI.progress(current.id, current.revision)
    if (alive && draft.value === current && !loading.value && !sending.value) {
      pollError.value = ''
      if ('draft' in status) adopt(status.draft)
      else {
        const images = new Map(status.images.map(image => [image.id, image]))
        adopt({ ...current, job: status.job, assets: current.assets.map(asset => ({ ...asset, ...images.get(asset.id) })) })
      }
    }
  } catch {
    if (alive && draft.value?.id === current.id) pollError.value = '正在重新连接项目，生成任务可继续运行。'
  } finally {
    reading = false
    schedulePoll()
  }
}

async function retryImageDelivery(taskId: number) {
  const current = draft.value
  if (!current || sending.value) return
  sending.value = true
  error.value = ''
  try {
    await taskAPI.recover(taskId)
    if (alive && draft.value === current) {
      adopt({ ...current, assets: current.assets.map(asset =>
        asset.taskId === taskId ? { ...asset, imageStatus: 'running', imageError: undefined } : asset,
      ) })
    }
  } catch (cause) {
    if (alive && draft.value === current) error.value = (cause as Error).message
  } finally {
    sending.value = false
    schedulePoll()
  }
}

function adopt(next: DownmarketDrama, openingProject = false) {
  const previous = draft.value
  const previousChapter = previous?.chapters[chapterNumber.value - 1]
  draft.value = next
  if (openingProject || !same(previous?.brief, next.brief)) brief.value = copy(next.brief)
  if (openingProject || !same(previous?.pitches, next.pitches) || previous?.selectedPitch !== next.selectedPitch) pitchIndex.value = next.selectedPitch
  if (openingProject || !same(previous?.outline, next.outline)) outline.value = next.outline ? copy(next.outline) : undefined
  if (openingProject || !same(previous?.candidate, next.candidate)) candidateEdit.value = next.candidate ? copy(next.candidate.content) : undefined
  if (openingProject || !same(previous?.opening, next.opening)) {
    openingMode.value = next.opening?.mode || 'conflict'
    openingEdit.value = ''
  }
  if (openingProject) {
    stage.value = next.candidate ? 'review' : next.finalized ? 'production' : allWritten.value ? 'review' : next.outlineConfirmed ? 'write' : next.pitches ? 'outline' : 'reference'
    outlineNotes.value = ''
    openingReference.value = ''
    openingNotes.value = ''
    allowMissingImages.value = false
    fileNotice.value = ''
    paceChapter.value = 1
    selectChapter(Math.max(1, next.chapters.length), true)
  } else if (previous?.job?.status === 'running' && next.job?.status === 'done') {
    if (next.job.action === 'analyze') stage.value = 'outline'
    if (next.job.action === 'write') { stage.value = 'write'; selectChapter(next.chapters.length, true) }
  }
  if (!openingProject && previous && previous.chapters.length === next.chapters.length &&
      !same(previousChapter, next.chapters[chapterNumber.value - 1])) selectChapter(chapterNumber.value, true)
  schedulePoll()
}

async function loadDirectory() {
  loading.value = true
  error.value = ''
  try {
    directory.value = await downmarketDramaAPI.list()
    const requested = typeof route.query.draft === 'string' ? route.query.draft : ''
    const id = directory.value.find(project => project.id === requested)?.id || directory.value[0]?.id
    if (id) await openProject(id)
  } catch (cause) { error.value = (cause as Error).message }
  finally { loading.value = false; schedulePoll() }
}

async function openProject(id: string) {
  loading.value = true
  error.value = ''
  pollError.value = ''
  conflict.value = false
  creating.value = false
  try {
    const item = await downmarketDramaAPI.get(id)
    if (!alive) return
    adopt(item, true)
    await router.replace({ query: { ...route.query, draft: id } })
  } catch (cause) { error.value = (cause as Error).message }
  finally { loading.value = false; schedulePoll() }
}

async function create() {
  if (sending.value || !newTitle.value.trim()) return
  sending.value = true
  error.value = ''
  try {
    const item = await downmarketDramaAPI.create(newTitle.value.trim())
    if (!alive) return
    directory.value = [item, ...directory.value]
    adopt(item, true)
    newTitle.value = ''
    creating.value = false
    await router.replace({ query: { ...route.query, draft: item.id } })
  } catch (cause) { error.value = (cause as Error).message }
  finally { sending.value = false }
}

function requestDelete() {
  if (!draft.value) return
  pendingDelete.value = { id: draft.value.id, title: draft.value.title }
  deleteError.value = ''
  deleteDialog.value?.showModal()
}

async function deleteProject() {
  const item = pendingDelete.value
  if (!item || sending.value) return
  sending.value = true
  deleteError.value = ''
  try {
    try { await downmarketDramaAPI.delete(item.id) }
    catch (cause) {
      if ((cause as { status?: number }).status !== 404) throw cause
    }
    if (!alive) return
    deleteDialog.value?.close()
    directory.value = directory.value.filter(project => project.id !== item.id)
    draft.value = undefined
    error.value = ''
    pollError.value = ''
    conflict.value = false
    const next = directory.value[0]
    if (next) await openProject(next.id)
    else {
      const { draft: _deleted, ...query } = route.query
      await router.replace({ query })
    }
  } catch (cause) {
    if (alive) deleteError.value = (cause as Error).message
  } finally {
    sending.value = false
    schedulePoll()
  }
}

async function send(command: DramaCommand) {
  if (!draft.value || sending.value) return false
  sending.value = true
  error.value = ''
  conflict.value = false
  try {
    const saved = await downmarketDramaAPI.command(draft.value.id, draft.value.revision, command)
    if (!alive) return false
    adopt(saved)
    if (command.action === 'confirmOutline') selectStage('write')
    if (command.action === 'finalize') selectStage('production')
    return true
  } catch (cause) {
    conflict.value = (cause as { status?: number }).status === 409
    error.value = (cause as Error).message
    return false
  } finally {
    sending.value = false
    schedulePoll()
  }
}

async function saveBrief() {
  const pasted = brief.value.reference.trim()
  if (pasted.length > DRAMA_INLINE_REFERENCE_CHARACTERS &&
      !await uploadReference(new File([pasted], '粘贴的对标文案.txt', { type: 'text/plain' }))) return false
  if (!briefDirty.value) return true
  return send({ action: 'saveBrief', brief: copy(brief.value) })
}
async function analyze() {
  if (briefDirty.value && !await saveBrief()) return
  await send({ action: 'analyze' })
}
function requestOutline() {
  if (pitchIndex.value !== undefined) void send({ action: 'outline', pitch: pitchIndex.value, notes: outlineNotes.value })
}
function confirmOutline() {
  if (outline.value) void send({ action: 'confirmOutline', outline: copy(outline.value) })
}
async function saveChapter(chapter: number, content: DramaChapter) {
  const saved = await send({ action: 'saveChapter', chapter, content: copy(content) })
  if (saved && chapterNumber.value === chapter) selectChapter(chapter, true)
}
function revise(chapter: number, source: DramaRevisionSource, notes?: string) {
  void send({ action: 'revise', chapter, source, notes })
}

async function importReference(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) await uploadReference(file)
}

async function uploadReference(file: File) {
  const current = draft.value
  if (!current || busy.value) return false
  fileNotice.value = ''
  error.value = ''
  conflict.value = false
  if (!/\.(txt|md|markdown)$/iu.test(file.name)) {
    error.value = '请选择 TXT 或 Markdown 文件。'
    return false
  }
  if (file.size > DRAMA_REFERENCE_UPLOAD_BYTES) {
    error.value = `对标文案文件最多 ${DRAMA_REFERENCE_UPLOAD_MB} MB。`
    return false
  }
  uploadingReference.value = true
  sending.value = true
  try {
    const next = await downmarketDramaAPI.importReference(current.id, current.revision, file)
    if (!alive) return false
    const unsavedSpecs = { ...brief.value, reference: next.brief.reference }
    adopt(next)
    brief.value = unsavedSpecs
    if (!next.referenceFile) fileNotice.value = '已保存「' + file.name + '」。'
    return true
  } catch (cause) {
    conflict.value = (cause as { status?: number }).status === 409
    error.value = (cause as Error).message || '文案导入失败。'
    return false
  } finally {
    uploadingReference.value = false
    sending.value = false
    schedulePoll()
  }
}

async function clearReference() {
  if (await send({ action: 'clearReference' })) fileNotice.value = ''
}

function downloadScript() {
  const value = draft.value
  if (!value) return
  const body = value.chapters.map((chapter, index) => '第' + (index + 1) + '章 ' + chapter.title + '\n\n' + chapter.text).join('\n\n')
  const url = URL.createObjectURL(new Blob(['\uFEFF', body], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = (value.outline?.title || value.title).replace(/[\\/:*?"<>|]/gu, '_') + '.txt'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

onMounted(loadDirectory)
onMounted(loadModels)
watch(settingsRevision, loadModels)
onBeforeUnmount(() => { alive = false; if (pollTimer) clearTimeout(pollTimer) })
</script>

<style>
.drama-bench { width: min(100%, 1500px); margin: 0 auto; padding: 26px clamp(16px, 3vw, 42px) 48px; min-height: 0; flex: 1; overflow-y: auto; color: var(--text-1); }
.drama-bench h1, .drama-bench h2, .drama-bench h3 { color: var(--text-0); margin: 0; }
.drama-bench h1 { font-size: clamp(24px, 3vw, 32px); line-height: 1.2; }
.drama-bench h2 { font-size: 18px; line-height: 1.35; }
.drama-bench h3 { font-size: 15px; }
.drama-bench p { color: var(--text-2); margin: 0; line-height: 1.6; }
.drama-reference-file { min-width: 0; display: grid; gap: 14px; }
.drama-reference-file h3 { overflow-wrap: anywhere; }
.drama-source-hint { font-size: 12px; }
.drama-top, .drama-heading, .drama-section-head, .drama-inline, .drama-delivery { display: flex; align-items: center; gap: 10px; }
.drama-top, .drama-section-head, .drama-delivery { justify-content: space-between; flex-wrap: wrap; }
.drama-heading { gap: 13px; }
.drama-heading p, .drama-section-head p, .drama-delivery p { margin: 4px 0 0; font-size: 13px; }
.drama-mark { display: grid; place-items: center; width: 46px; height: 46px; flex: 0 0 46px; border: 1px solid var(--surface-outline-strong); border-radius: 13px; background: var(--accent-bg); color: var(--accent-text); }
.drama-inline { flex-wrap: wrap; }
.drama-inline > span { color: var(--text-2); font-size: 12px; }
.drama-paper { min-width: 0; display: grid; align-content: start; gap: 14px; padding: clamp(15px, 2vw, 24px); background: var(--surface-raised); border: 1px solid var(--surface-outline); border-radius: 15px; }
.drama-empty { place-content: center; justify-items: center; min-height: 230px; margin-top: 19px; color: var(--text-2); }
.drama-start { max-width: 490px; margin: 24px 0 0; padding: 26px; }
.drama-start p { margin-top: 4px; }
.drama-bench fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.drama-bench .drama-field { display: grid; min-width: 0; gap: 6px; font-size: 13px; font-weight: 560; }
.drama-bench :is(input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea) { width: 100%; min-width: 0; padding: 8px 10px; border: 1px solid var(--surface-outline-strong); border-radius: 8px; background: var(--surface-input); color: var(--text-1); font: inherit; font-weight: 400; }
.drama-bench :is(input,select,textarea,button,summary,a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.drama-bench textarea { min-height: 62px; resize: vertical; line-height: 1.65; }
.drama-bench textarea.drama-script { line-height: 1.8; font-size: 14px; }
.drama-bench input[type="file"] { max-width: 100%; overflow: hidden; font: inherit; }
.drama-bench input[type="file"]::file-selector-button { border: 1px solid var(--surface-outline); border-radius: 6px; padding: 5px 8px; font: inherit; background: var(--surface-input); color: var(--text-1); cursor: pointer; }
.drama-bench input:is([type="checkbox"],[type="radio"]) { accent-color: var(--accent); }
.drama-bench button:disabled, .drama-bench fieldset:disabled { opacity: .55; cursor: default; }
.project-picker { display: flex; gap: 7px; align-items: center; font-size: 12px; }
.project-picker span { white-space: nowrap; color: var(--text-2); }
.project-picker select { max-width: min(260px, 48vw); }
.drama-delete-trigger, .drama-bench .drama-delete-error { color: var(--action-danger, #b94346); }
.drama-delete-dialog { width: min(420px, calc(100vw - 32px)); margin: auto; padding: 23px; border: 1px solid var(--surface-outline-strong); border-radius: 13px; background: var(--surface-raised); color: var(--text-1); }
.drama-delete-dialog::backdrop { background: rgb(0 0 0 / 57%); }
.drama-bench .drama-delete-dialog p { margin: 10px 0 16px; }
.drama-delete-dialog .drama-inline { justify-content: flex-end; }
.drama-steps { display: flex; gap: 6px; margin: 20px 0 14px; padding: 5px; overflow-x: auto; border: 1px solid var(--surface-outline); border-radius: 12px; background: var(--surface-raised); }
.drama-steps button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; white-space: nowrap; min-width: 128px; padding: 11px 9px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text-2); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.drama-steps button[aria-current="step"], .drama-steps button:hover:not(:disabled) { border-color: var(--surface-outline); background: var(--accent-bg); color: var(--accent-text); }
.drama-models { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; margin-bottom: 14px; padding: 8px 12px; border: 1px solid var(--surface-outline); border-radius: 12px; background: var(--surface-raised); }
.drama-model { display: flex; align-items: center; gap: 8px; flex: 0 1 350px; min-width: 0; }
.drama-model > span { flex-shrink: 0; color: var(--text-2); font-size: 12px; }
.drama-model .base-select { flex: 1; min-width: 0; }
.drama-models > small { color: var(--text-2); }
.step-check { color: var(--accent-text); }
.drama-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
.reference-columns { grid-template-columns: minmax(0, 2.3fr) minmax(235px, 1fr); }
.writing-columns { grid-template-columns: minmax(215px, .63fr) minmax(0, 2fr); }
.review-columns { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); }
.drama-specs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.drama-choice { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.drama-specs .drama-choice { grid-column: 1 / -1; }
.drama-spec-total { display: grid; color: var(--text-2); gap: 3px; padding: 12px; border-radius: 9px; background: var(--surface-muted); font-size: 12px; }
.drama-spec-total strong { color: var(--text-0); font-size: 25px; font-variant-numeric: tabular-nums; }
.drama-banner { margin: 12px 0; display: flex; align-items: center; gap: 8px; padding: 9px 13px; border-radius: 10px; border: 1px solid var(--surface-outline); background: var(--surface-raised); color: var(--accent-text); overflow-wrap: anywhere; }
.drama-banner .btn { margin-left: auto; flex-shrink: 0; }
.drama-banner.error, .drama-bench .asset-error { color: var(--action-danger, #b94346); }
.drama-spin { animation: drama-spin 1s linear infinite; flex: 0 0 auto; }
@keyframes drama-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .drama-spin { animation: none; } }
.drama-upload { position: relative; overflow: hidden; cursor: pointer; }
.drama-upload:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.drama-upload input { position: absolute; inset: 0; opacity: 0; width: 100%; cursor: pointer; }
.drama-tag { border: 1px solid var(--surface-outline); color: var(--accent-text); background: var(--accent-bg); font-size: 12px; border-radius: 20px; padding: 4px 10px; }
.drama-details { min-width: 0; padding: 10px 13px; border: 1px solid var(--surface-outline); border-radius: 9px; background: var(--surface-muted); }
.drama-details > summary { color: var(--text-1); font-size: 14px; font-weight: 650; cursor: pointer; overflow-wrap: anywhere; }
.drama-details[open] > :not(summary) { margin-top: 11px; }
.drama-prose { white-space: pre-wrap; overflow-wrap: anywhere; }
.drama-pitches { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 11px; }
.drama-pitch { display: grid; align-content: start; gap: 7px; border: 1px solid var(--surface-outline); border-radius: 11px; padding: 12px; background: var(--surface-muted); cursor: pointer; overflow-wrap: anywhere; line-height: 1.55; font-size: 13px; }
.drama-pitch.selected { border-color: var(--accent); background: var(--accent-bg); }
.drama-pitch-title { color: var(--text-0); display: flex; gap: 6px; align-items: baseline; font-weight: 650; font-size: 15px; }
.drama-pitch small { color: var(--text-2); }
.drama-outline { display: grid; gap: 12px; }
.drama-outline-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; }
.drama-chapter-list { gap: 7px; }
.drama-chapter-list p, .drama-chapter-count { font-size: 13px; }
.drama-chapter-link { display: grid; grid-template-columns: auto 1fr auto; align-items: center; text-align: left; gap: 8px; min-width: 0; padding: 8px; border: 1px solid var(--surface-outline); border-radius: 7px; background: transparent; color: var(--text-1); cursor: pointer; }
.drama-chapter-link span { color: var(--text-2); font-size: 12px; }
.drama-chapter-link strong { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.drama-chapter-link[aria-pressed="true"], .drama-bench .btn[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-text); }
.drama-plan { border-top: 1px solid var(--surface-outline); margin-top: 10px; padding-top: 10px; }
.drama-plan ul { margin: 7px 0; padding-left: 18px; }
.drama-plan p { margin: 5px 0; }
.drama-opening-options > .drama-field, .drama-opening-options > button { margin-top: 11px; }
.drama-bench .drama-hint { padding: 8px 10px; border-radius: 7px; color: var(--text-2); background: var(--accent-bg); font-size: 13px; }
.drama-asset-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 265px), 1fr)); gap: 12px; align-items: start; }
.drama-delivery { padding-top: 12px; border-top: 1px solid var(--surface-outline); }
@media (max-width: 760px) {
  .drama-columns, .drama-pitches, .drama-outline-actions { grid-template-columns: 1fr; }
  .drama-chapter-list { grid-auto-columns: minmax(125px, 1fr); grid-auto-flow: column; grid-template-rows: auto auto auto; overflow-x: auto; }
  .drama-chapter-list > :is(h2,p) { grid-column: 1 / -1; }
  .drama-chapter-link { grid-template-columns: minmax(0, 1fr) auto; }
  .drama-chapter-link span { grid-column: 1 / -1; }
}
</style>
