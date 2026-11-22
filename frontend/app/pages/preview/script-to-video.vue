<template>
  <div ref="workspace" class="video-preview-page">
    <header class="vp-heading">
      <div class="vp-title">
        <span class="vp-title-icon"><Clapperboard :size="23" /></span>
        <div>
          <div class="vp-title-line">
            <h1>剧本转视频</h1>
            <span class="vp-preview-label">AI 制作</span>
          </div>
          <p>从一场戏，到每一个可生成的镜头。</p>
        </div>
      </div>
      <div class="vp-heading-actions">
        <button class="btn" :disabled="!episodeOpen" @click="dialog = 'skills'">
          <SlidersHorizontal :size="14" /> Agent 与 Skills</button
        ><button
          class="btn"
          :disabled="
            !episodeOpen || exporting || !hasStoryboard || !currentEpisode.outlineConfirmed
          "
          @click="exportCards(cards)"
        >
          <Download :size="14" />{{ exporting ? '打包中…' : '导出本集' }}
        </button>
        <button v-if="!episodeOpen && !noProjects" type="button" class="btn" aria-haspopup="dialog" @click="openProjectVideoExport">
          <Download :size="14" />导出全部视频
        </button>
      </div>
    </header>

    <ScriptVideoPreviewProjectBar
      :projects="projects"
      :project-id="selectedProjectId"
      :deleting-project-id="deletingProjectId"
      :style-name="currentProject.settings?.stylePreset?.name"
      :episodes="episodeOptions"
      :episode-id="episodeOpen ? selectedEpisodeId : ''"
      :occupied-episode-ids="occupiedEpisodeIds"
      :selecting-episode="episodeNavigationBusy"
      @project="selectProject"
      @delete-project="deleteProject"
      @episode="selectEpisode"
      @inspect-episodes="episodeLock.refresh()"
      @create-project="openProjectDialog"
      @edit-style="openStyleDialog"
      @add-episode="addEpisode"
      @import-episodes="scriptInput?.click()"
    />

    <div v-if="noProjects" class="vp-empty vp-panel">
      <h2>暂无项目</h2>
    </div>
    <div v-else-if="!episodeOpen" class="vp-empty vp-panel" role="status">
      <p>{{ loadingProjects ? '正在加载项目…' : loadError || (selectingEpisode ? '正在进入分集…' : episodeAccessNotice || '请选择要制作的分集。') }}</p>
    </div>
    <div v-else class="vp-workflow">
      <nav aria-label="剧本转视频流程">
        <button
          v-for="(item, index) in stages"
          :key="item.id"
          :class="{ active: stage === item.id }"
          :aria-current="stage === item.id ? 'step' : undefined"
          @click="navigateStage(item.id)"
        >
          <span
            ><Check
              v-if="index < stages.findIndex((s) => s.id === stage)"
              :size="12"
            /><template v-else>{{ index + 1 }}</template></span
          >{{ item.label }}<ChevronRight v-if="index < 2" :size="13" />
        </button>
      </nav>
      <div class="vp-output-switch" aria-label="项目操作">
        <div class="vp-episode-status">
          <span>修改状态</span>
          <BaseSelect
            v-model="episodeProgressSelection"
            :options="episodeProgressOptions"
            :searchable="false"
            variant="inspector"
            aria-label="修改分集状态"
          />
        </div>
        <button v-if="stage === 'production'" type="button" aria-haspopup="dialog" @click="dialog = 'script'">
          <FileText :size="14" />查看原文
        </button>
        <button class="vp-workflow-assets" type="button" aria-haspopup="dialog" @click="dialog = 'assets'">
          <Images :size="14" />项目资产
        </button>
        <button type="button" :class="{ active: stage === 'production' }" @click="navigateStage('production')">
          <MonitorPlay :size="14" />项目内生成
        </button>
        <button type="button" aria-haspopup="dialog" @click="openProjectVideoExport">
          <Download :size="14" />导出全部视频
        </button>
      </div>
    </div>
    <div v-if="episodeOpen" class="vp-preview-notice">
      <LoaderCircle
        v-if="loadingProjects || savingProjects.has(currentProject.id) || busy || currentTextRun"
        :size="13"
        class="animate-spin"
      /><ShieldCheck v-else :size="13" />
      <span role="status">{{
        loadingProjects
          ? '正在加载项目…'
          : loadError ||
            currentSaveError ||
            currentTextStatus ||
            ([currentAIError && summarizeAIError(currentAIError), currentProgressText].filter(Boolean).join(' ')) ||
            (savingProjects.has(currentProject.id)
              ? '正在同步…'
              : pendingEdits.has(currentProject.id) ? (locallySaved.has(currentProject.id) ? '已保存到本机，等待同步' : '正在保存本机草稿…') : '项目已同步')
      }}</span>
      <button v-if="currentSaveError" @click="retrySave">重试同步</button>
      <span v-if="occupiedEpisodeIds.includes(selectedEpisodeId)" class="vp-muted">另一个页面也在编辑本集</span>
      <button v-if="currentAIError && !loadingProjects && !loadError" @click="dialog = 'ai-error'">查看错误详情</button>
      <button
        v-if="currentTextRun && !(stage === 'production' && editorTab === 'revise' && activeRevisionState)"
        type="button"
        :disabled="currentTextRun.cancelRequested"
        @click="cancelTextGeneration"
      >{{ currentTextRun.cancelRequested ? '正在取消…' : '取消生成' }}</button>
      <ModelSelect
        v-model="textSelection"
        label="编排文字模型"
        :options="textOptions"
        :show-config="true"
        :disabled="!canEditSharedProject"
      />
      <button type="button" :disabled="episodeNavigationBusy" @click="leaveEpisode">退出分集</button>
    </div>

    <details v-if="episodeOpen && stage === 'production' && editingWarnings.length" class="vp-editing-warnings">
      <summary>分镜提示 · {{ editingWarnings.length }} 项</summary>
      <p>以下提示可在分镜中修改，不影响继续编辑。出片前请补齐实际使用的素材。</p>
      <ul><li v-for="issue in editingWarnings" :key="issue.code + issue.message">{{ issue.message }}</li></ul>
    </details>

    <div
      v-if="episodeOpen && stage === 'materials'"
      class="vp-materials vp-panel"
      :inert="busy || loadingProjects || !!loadError"
    >
      <section class="vp-script-editor">
        <div class="vp-section-header">
          <div>
            <h2>第 {{ currentEpisode.number }} 集剧本</h2>
            <p>
              多选剧本文件或导入 ZIP。有场次编号时按集归并（如 6-01 归入第 6 集），无场次标记的续文接到上一场。
              整批无场次时按分集文件导入。
            </p>
          </div>
        </div>
        <input
          v-model="currentEpisode.title"
          class="input vp-project-title"
          aria-label="分集标题"
        /><textarea
          v-model="script"
          :disabled="busy"
          class="textarea vp-script-textarea"
          aria-label="剧本内容"
          placeholder="粘贴剧本，或导入 TXT / Markdown 文件…"
        />
        <div class="vp-editor-foot">
          <span
            >{{ script.length }} 字 ·
            {{ currentEpisode.confirmed ? '剧本已确认' : '待确认' }}
            <template v-if="currentEpisode.sourceChapters?.length"> · 来源 {{ sourceChapterCount(currentEpisode.sourceChapters) }} 章</template>
            · 主干剧情优先排入 2 分钟，台词需要时自动延长</span
          >
        </div>
        <ScriptVideoPreviewImportReport
          v-if="episodeImportReport"
          v-bind="episodeImportReport"
        />
      </section>
      <section class="vp-material-assets">
        <div class="vp-section-header">
          <div>
            <h2>项目资产包</h2>
            <p>识别背景、道具、角色、生物目录，各集共用，按名称 @ 引用。</p>
          </div>
          <span class="tag">{{ assets.length }} 项</span>
        </div>
        <div class="vp-dropzone" @dragover.prevent @drop.prevent="dropAssets">
          <FolderOpen :size="24" /><strong>{{
            assetImporting ? '正在读取资产包…' : '导入整个素材文件夹或 ZIP'
          }}</strong>
          <span>保留图片名称和造型后缀，自动识别子目录</span>
          <div class="vp-import-actions">
            <button
              class="btn btn-sm"
              :disabled="assetImporting || !canEditSharedProject"
              @click="assetFolderInput?.click()"
            >
              <FolderOpen :size="13" />导入文件夹
            </button>
            <button
              class="btn btn-sm"
              :disabled="assetImporting || !canEditSharedProject"
              @click="assetZipInput?.click()"
            >
              <Package :size="13" />导入 ZIP
            </button>
            <button
              class="btn btn-ghost btn-sm"
              :disabled="assetImporting || !canEditSharedProject"
              @click="assetInput?.click()"
            >
              选择图片
            </button>
          </div>
        </div>
        <ScriptVideoPreviewImportReport
          v-if="assetImportReport"
          v-bind="assetImportReport"
        />
        <div class="vp-material-grid">
          <button
            v-for="asset in assets.slice(0, 24)"
            :key="asset.id"
            @click="editAsset(asset.id)"
          >
            <span><ScriptVideoPreviewAssetImage :asset="asset" /></span
            ><strong>{{ asset.name }}</strong
            ><small>{{ kindLabel(asset.kind) }}</small>
          </button>
        </div>
        <button class="btn vp-wide" @click="dialog = 'assets'">
          <Images :size="14" />管理全部 {{ assets.length }} 项资产
        </button>
      </section>
      <footer class="vp-material-footer">
        <span><ShieldCheck :size="14" />SD2.5 主 Skill · 原文台词与剧情优先</span>
        <button
          class="btn btn-primary"
          :disabled="outlineButtonDisabled"
          @click="makeOutline"
        >
          <LoaderCircle v-if="busy" class="animate-spin" :size="15" /><Sparkles
            v-else
            :size="15"
          />{{ busy ? '正在编排…' : '确认本集剧本，生成大纲'
          }}<ArrowRight :size="15" />
        </button>
      </footer>
    </div>

    <div
      v-else-if="episodeOpen && stage === 'outline'"
      class="vp-outline vp-panel"
      :inert="busy"
    >
      <div class="vp-section-header">
        <div>
          <h2>分段大纲</h2>
          <p>
            {{ cards.length }} 段 · 共 {{ totalDuration }} 秒（优先控制在 120 秒内） · 内容与素材问题仅提示，可在分镜中修改
          </p>
        </div>
        <button class="btn btn-sm" :disabled="outlineButtonDisabled" @click="makeOutline">
          <RefreshCw :size="13" />重新编排
        </button>
      </div>
      <nav v-if="outlineRows.length > 1" class="vp-outline-index" aria-label="跳转片段">
        <button
          v-for="({ card, range }, index) in outlineRows"
          :key="card.id"
          class="btn btn-sm"
          :title="card.title"
          @click="jumpToOutlineCard(card.id)"
        >
          <strong>第 {{ index + 1 }} 段</strong><span>{{ range }}</span>
        </button>
      </nav>
      <div class="vp-outline-list">
        <article
          v-for="({ card, range, sections }, index) in outlineRows"
          :id="`outline-card-${card.id}`"
          :key="card.id"
          class="vp-outline-card"
          :aria-labelledby="`outline-title-${card.id}`"
          tabindex="-1"
        >
          <header class="vp-outline-heading">
            <div>
              <div class="vp-outline-time">
                <Clock3 :size="13" />{{ range }} · {{ card.duration }} 秒
                <span v-if="card.combat" class="vp-combat"><Swords :size="12" />高燃打斗 Skill</span>
              </div>
              <h3 :id="`outline-title-${card.id}`">{{ card.title || `第 ${index + 1} 段` }}</h3>
            </div>
            <button class="btn btn-sm" :aria-expanded="editingOutlineCardId === card.id" @click="toggleOutlineEdit(card.id)">
              <Check v-if="editingOutlineCardId === card.id" :size="13" />
              <Pencil v-else :size="13" />
              {{ editingOutlineCardId === card.id ? '完成编辑' : '编辑大纲' }}
            </button>
          </header>
          <div v-if="editingOutlineCardId === card.id" class="vp-outline-form">
            <div class="vp-outline-fields">
              <label>片段标题
                <input
                  v-model="card.title"
                  class="input"
                  @input="currentEpisode.outlineConfirmed = false"
                />
              </label>
              <label>时长（秒）
                <input
                  class="input"
                  type="number"
                  :value="card.duration"
                  min="2"
                  max="30"
                  step="any"
                  @input="
                    resizeCard(
                      card,
                      Number(($event.target as HTMLInputElement).value),
                    )
                  "
                />
              </label>
            </div>
            <textarea
              :id="`outline-summary-${card.id}`"
              v-model="card.summary"
              @input="currentEpisode.outlineConfirmed = false"
              rows="8"
              aria-label="片段事件大纲"
              placeholder="写下本段的情节、关键台词和承接"
            />
          </div>
          <div v-else class="vp-outline-body">
            <div
              v-for="(section, sectionIndex) in sections"
              :key="sectionIndex"
              class="vp-outline-section"
              :class="{ 'vp-outline-section-labeled': section.label }"
            >
              <h4 v-if="section.label">{{ section.label }}</h4>
              <p v-if="section.text">{{ section.text }}</p>
            </div>
            <p v-if="!sections.length" class="vp-outline-empty">这段还没有填写大纲。</p>
          </div>
          <footer class="vp-outline-footer">
            <div class="vp-outline-tags">
              <button
                class="btn btn-ghost btn-sm"
                @click="openBindingDialog(card.id)"
              >
                <Images :size="12" />选择本段资产
              </button>
              <span
                v-for="asset in assets.filter((a) =>
                  card.assetIds.includes(a.id),
                )"
                :key="asset.id"
                >@{{ asset.name }}</span
              >
            </div>
            <div class="vp-outline-tools">
              <button
                class="btn btn-icon btn-sm"
                :disabled="index === 0"
                aria-label="上移片段"
                @click="moveCard(index, -1)"
              >
                <ArrowUp :size="13" />
              </button>
              <button
                class="btn btn-icon btn-sm"
                aria-label="删除片段"
                @click="removeCard(card.id)"
              >
                <Trash2 :size="13" />
              </button>
            </div>
          </footer>
        </article>
        <button class="vp-add-outline" @click="addCard">
          <Plus :size="15" />添加一个片段
        </button>
      </div>
      <footer class="vp-material-footer">
        <button class="btn" @click="stage = 'materials'">
          <ArrowLeft :size="14" />返回剧本与资产</button
        ><button
          class="btn btn-primary"
          :disabled="busy || !!currentTextRun || !cards.length"
          @click="confirmOutline"
        >
          <LoaderCircle v-if="busy" class="animate-spin" :size="14" /><Check
            v-else
            :size="14"
          />{{ busy ? '编排任务进行中…' : storyboardAction.label }}
        </button>
      </footer>
    </div>

    <div v-else-if="episodeOpen" class="vp-production">
      <div class="vp-workbench" :inert="busy">
        <div class="vp-editor-panel vp-panel">
          <ScriptVideoPreviewEditor
            v-if="selectedCard"
            :key="`${currentEpisode.id}:${selectedCard.id}`"
            v-model:tab="editorTab"
            :card="selectedCard"
            :frame-editor="frameEditor"
            :completed-task-video-url="latestCompletedVideoUrls.get(selectedCard.id)"
            :video-versions="selectedVideoVersions"
            :promoting-video-version="promotingVideoVersion"
            :assets="assets"
            :production="currentEpisode.production"
            :style-preset="currentProject.settings?.stylePreset"
            :video-provider="currentEpisode.modelProvider"
            :video-model="currentEpisode.modelName"
            :episode-number="currentEpisode.number"
            :segment-number="cards.findIndex((item) => item.id === selectedCard?.id) + 1"
            :segment-count="cards.length"
            :segment-start="cards.slice(0, cards.findIndex((item) => item.id === selectedCard?.id)).reduce((sum, item) => sum + item.duration, 0)"
            :can-upload-prompt-media="canEditSharedProject"
            :uploading-prompt-media="uploadingPromptMedia.get(currentProject.id)"
            @upload-prompt-media="uploadPromptMedia"
            :video-voice-warning="videoVoiceWarningForCard(selectedCard.id)"
            :request-revision="revisionRequester"
            :revision-state="activeRevisionState"
            :revision-blocked="!!currentTextRun"
            :restored-revision="selectedRestoredRevision"
            @cancel-revision="cancelTextGeneration"
            @consume-restored-revision="clearRestoredRevision"
            :running="
              videoRequestPending || videoCanceling || activeCardIds.includes(selectedCard.id) || tasks.some(
                (t) =>
                  t.cardId === selectedCard?.id && t.status === 'processing',
              )
            "
            :can-cancel-video="canCancelSelectedVideo"
            :canceling-video="videoCanceling || !!selectedVideoTask && cancelingVideo.has(selectedVideoTask.id)"
            @update="updateCard"
            @generate="requestVideoGeneration([selectedCard!.id])"
            @cancel-video="cancelVideoGeneration(selectedVideoTask, selectedCard!.id)"
            @promote-video-version="promoteVideoVersion(selectedCard!.id, $event)"
            @export="exportCards([selectedCard!])"
            @preview-final-prompt="showFinalPrompt({ cardId: selectedCard!.id, title: selectedCard!.title, event: $event })"
          />
          <div v-else class="vp-empty">
            <Clapperboard :size="35" />
            <h2>为这场戏添加第一个片段</h2>
            <button class="btn btn-primary" @click="addCard">添加片段</button>
          </div>
        </div>

        <aside class="vp-inspector vp-panel">
          <div class="vp-section-header">
            <h2>生成设置</h2>
            <span class="vp-live-dot" />
          </div>
          <ScriptVideoPreviewModelSelect v-model="videoModel" @change="setVideoModel" />
          <div class="vp-two-fields">
            <div class="vp-field">
              <span>画幅</span>
              <BaseSelect v-model="aspectRatio" :options="aspectRatioOptions" :searchable="false" variant="inspector" aria-label="画幅" />
            </div>
            <div class="vp-field">
              <span>分辨率</span>
              <BaseSelect v-model="resolution" :options="modelResolutions" :searchable="false" variant="inspector" aria-label="分辨率" />
            </div>
          </div>
          <div v-if="selectedCard" class="vp-field">
            <label for="vp-generation-duration">生成时长</label>
            <BaseSelect
              v-model="videoDuration"
              input-id="vp-generation-duration"
              aria-label="生成时长"
              variant="inspector"
              :options="videoDurationOptions"
              :searchable="false"
              :disabled="!currentEpisode.modelMaxDuration || videoRequestPending"
            />
            <p v-if="videoDurationHint" class="vp-duration-hint" :class="{ 'vp-duration-warning': selectedVideoDurationIssue }">
              {{ videoDurationHint }}
            </p>
          </div>
          <div class="vp-inspector-divider" />
          <div class="vp-section-header">
            <h2>编排规则</h2>
            <button class="vp-link" @click="dialog = 'skills'">查看</button>
          </div>
          <div class="vp-skill-summary">
            <span class="vp-mini-icon"><Clapperboard :size="14" /></span>
            <div>
              <strong>SD2.5 短剧分镜 v2.1</strong
              ><small>主 Skill · 分镜规则与五维镜头资料</small>
            </div>
            <Check :size="13" />
          </div>
          <label class="vp-skill-summary vp-combat-switch"
            ><span class="vp-mini-icon"><Swords :size="14" /></span>
            <div>
              <strong>高燃打斗</strong
              ><small>打斗子 Skill · 下次编排生效</small>
            </div>
            <input
              v-model="combatEnabled"
              type="checkbox"
              :disabled="!canEditSharedProject"
              aria-label="启用高燃打斗"
          /></label>
          <div class="vp-inspector-divider" />
          <div class="vp-section-header">
            <h2>生成任务</h2>
            <span class="vp-muted">{{ tasks.length }}</span>
          </div>
          <p v-if="videoTailWaiting" class="vp-muted vp-tail-wait" role="status">
            等待上一段出片，出片后接续生成。
          </p>
          <div class="vp-tasks">
            <div
              v-for="task in tasks.slice().reverse()"
              :key="task.id"
              class="vp-task"
            >
              <LoaderCircle
                v-if="task.status === 'processing'"
                :size="14"
                class="animate-spin"
              /><X
                v-else-if="task.status === 'failed' || task.status === 'canceled'"
                :size="14"
              /><CircleCheck v-else :size="14" />
              <div>
                <strong>{{
                  task.title ||
                  cards.find((card) => card.id === task.cardId)?.title ||
                  '视频任务'
                }}</strong
                ><span class="vp-task-model">{{ task.modelLabel }}<template v-if="task.duration"> · {{ task.duration }} 秒</template></span
                ><small
                  >{{
                    task.status === 'processing'
                      ? '视频生成中…'
                      : task.status === 'failed'
                        ? '生成失败'
                        : task.status === 'canceled'
                          ? task.code?.startsWith('SUBMISSION_UNKNOWN') ? '已停止站内等待' : '已取消'
                          : '视频已生成'
                  }}
                </small>
                <small v-if="videoTaskError(task)" class="vp-task-stale">{{ videoTaskError(task) }}</small>
                <small v-if="task.lightingReviewShots?.length" class="vp-task-stale">光线待复核 · 镜头 {{ task.lightingReviewShots.join('、') }} 与上一段末镜的受光差异较大</small>
                <a v-if="task.continuation?.imageUrl" :href="task.continuation.imageUrl" target="_blank" rel="noopener" class="vp-link vp-tail-link">
                  <img :src="task.continuation.imageUrl" alt="上一段尾帧" loading="lazy" />
                  {{ task.continuation.mode === 'first-frame' ? '上一段尾帧 · 本段首帧' : '上一段尾帧 · 开场参考' }}
                </a>
                <a
                  v-if="task.videoUrl"
                  :href="task.videoUrl"
                  target="_blank"
                  rel="noopener"
                  class="vp-link"
                  >查看视频</a
                >
                <button v-if="task.taskId" type="button" class="vp-link" @click="showFinalPrompt({ cardId: task.cardId, title: task.title || '视频任务', task, event: $event })">
                  查看该次提示词
                </button>
                <button v-if="task.status === 'processing'" type="button" class="vp-link"
                  :disabled="videoCanceling || cancelingVideo.has(task.id)" @click="cancelVideoGeneration(task)">
                  {{ cancelingVideo.has(task.id) ? '正在取消…' : '取消生成' }}
                </button>
                <div
                  v-if="
                    (task.status === 'failed' || task.status === 'canceled') &&
                    latestTaskByCard.get(task.cardId)?.id === task.id &&
                    cards.some(card => card.id === task.cardId)
                  "
                >
                  <small v-if="videoVoiceWarningForCard(task.cardId)" :id="`vp-task-voice-${task.id}`" class="vp-video-voice-warning" role="status">
                    {{ videoVoiceWarningForCard(task.cardId) }}
                  </small>
                  <button
                    type="button"
                    class="vp-link"
                    :disabled="videoRequestPending || activeCardIds.includes(task.cardId) || taskActions.has(task.id) || !!videoVoiceWarningForCard(task.cardId)"
                    :aria-describedby="videoVoiceWarningForCard(task.cardId) ? `vp-task-voice-${task.id}` : undefined"
                    @click="requestVideoGeneration([task.cardId])"
                  >
                    {{ isVideoDeliveryRecovery(task) ? '恢复原任务' : '重新生成' }}
                  </button>
                </div>
                <small v-if="task.staleResult" class="vp-task-stale">生成期间输入有更新，已保留为历史成片</small>
                <small
                  v-else-if="
                    cards.some(card => card.id === task.cardId && card.version !== task.cardVersion &&
                      (card.status !== 'ready' || !task.videoUrl || card.videoUrl !== task.videoUrl))
                  "
                  class="vp-task-stale"
                  >分镜版本已更新，可重新生成</small
                >
              </div>
            </div>
            <div v-if="!tasks.length" class="vp-no-tasks">
              <MonitorPlay :size="23" /><span>选好片段，开始第一次生成</span>
            </div>
          </div>
          <p v-if="batchVideoVoiceWarning" id="vp-batch-video-voice" class="vp-video-voice-warning" role="status">
            {{ batchVideoVoiceWarning }}
          </p>
          <button v-if="activeVideoRun || videoCanceling" class="btn vp-wide" type="button" :disabled="videoCanceling" @click="cancelVideoGeneration()">
            <X :size="13" />{{ videoCanceling ? '正在取消…' : '取消本集视频生成' }}
          </button>
          <button v-else
            class="btn vp-wide"
            :disabled="!cards.length || running || !!activeCardIds.length || !!batchVideoVoiceWarning"
            :aria-describedby="batchVideoVoiceWarning ? 'vp-batch-video-voice' : undefined"
            @click="requestVideoGeneration(cards.map(card => card.id))"
          >
            <Layers :size="13" />批量生成视频
          </button>
        </aside>
      </div>

      <section class="vp-rail vp-panel">
        <div class="vp-rail-head">
          <div>
            <strong>分镜片段</strong
            ><span>{{ cards.length }} 段 / {{ totalDuration }} 秒</span
            ><span class="vp-rail-ready"
              >{{
                officialVideoCount
              }}
              段已就绪</span
            >
          </div>
          <div>
            <button type="button" class="btn vp-segment-export" @click="episodePreview?.open()">
              <MonitorPlay :size="13" aria-hidden="true" />查看本集样片
            </button>
            <button type="button" class="btn btn-primary vp-segment-export" :disabled="!cards.length" @click="openSegmentExport">
              <Download :size="13" />一键导出
            </button>
            <button v-if="hasStoryboard" class="vp-link" :disabled="busy || !!currentTextRun" @click="dialog = 'review'">
              <ShieldCheck :size="13" />整集 AI 复核
            </button>
            <button class="vp-link" @click="stage = 'outline'">
              调整大纲 <ArrowUpRight :size="12" /></button
            ><button class="vp-link" @click="addCard">
              <Plus :size="13" />添加片段
            </button>
          </div>
        </div>
        <div class="vp-card-track">
          <div v-for="(card, index) in cards" :key="card.id" class="vp-segment-item">
            <button
              type="button"
              class="vp-segment-card"
              :class="{ selected: selectedCardId === card.id }"
              @click="openSegmentCard(card, $event)"
            >
              <div class="vp-segment-art">
                <ScriptVideoPreviewAssetImage v-if="coverAsset(card)" :asset="coverAsset(card)!" />
                <span v-if="['queued', 'generating'].includes(segmentDisplayStatus(card))" class="vp-segment-loading" role="status">
                  <LoaderCircle :size="16" class="animate-spin" aria-hidden="true" />
                  {{ statusLabel(segmentDisplayStatus(card)) }}
                </span>
                <span v-if="segmentPlayback.get(card.id)" class="vp-segment-play" title="播放成片">
                  <Play :size="18" fill="currentColor" />
                </span>
                <span class="vp-segment-number">{{ String(index + 1).padStart(2, '0') }}</span>
                <span class="vp-segment-duration">{{ card.duration }}s</span>
                <span v-if="card.combat" class="vp-segment-combat"><Swords :size="12" /></span>
              </div>
              <div class="vp-segment-copy">
                <strong>{{ card.title }}</strong>
                <small>
                  <i :class="segmentDisplayStatus(card)" />{{ statusLabel(segmentDisplayStatus(card)) }}
                  <span>{{ card.shots.length }} 镜</span>
                </small>
              </div>
            </button>
            <button
              type="button"
              class="vp-segment-delete"
              :disabled="busy || videoRequestPending || segmentDisplayStatus(card) === 'generating'"
              :aria-label="`删除第 ${index + 1} 段 ${card.title}`"
              title="删除片段"
              @click="openSegmentDeletion(card)"
            >
              <Trash2 :size="13" />
            </button>
          </div>
          <button class="vp-add-segment" @click="addCard">
            <Plus :size="22" /><span>添加片段</span>
          </button>
        </div>
      </section>
      <ScriptVideoEpisodePreview
        :key="episodeKey"
        ref="episodePreview"
        :episode-label="`第 ${currentEpisode.number} 集 · ${currentEpisode.title}`"
        :clips="episodePreviewClips"
      />
    </div>

    <input
      ref="scriptInput"
      type="file"
      accept=".txt,.md,.markdown,.zip,text/plain,text/markdown,application/zip"
      multiple
      hidden
      @change="importScript"
    /><input
      ref="assetFolderInput"
      type="file"
      webkitdirectory
      multiple
      hidden
      @change="importAssets"
    /><input
      ref="assetZipInput"
      type="file"
      accept=".zip,application/zip,application/x-zip-compressed"
      multiple
      hidden
      @change="importAssets"
    /><input
      ref="assetInput"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      hidden
      @change="importAssets"
    />
    <Teleport to="body"
      ><div
        v-if="dialog && (episodeOpen || dialog === 'project' || dialog === 'project-video-export')"
        class="vp-modal-overlay"
        @click.self="dialog = null"
        @keydown.esc="dialog = null"
      >
        <section
          class="vp-modal"
          :class="{ 'vp-assets-modal': dialog === 'assets', 'vp-final-prompt-modal': dialog === 'prompt-preview' }"
          role="dialog"
          aria-modal="true"
          :aria-label="dialogTitle"
          @keydown.tab="keepDialogFocus"
        >
          <header>
            <div>
              <span class="vp-modal-eyebrow">{{
                dialog === 'skills' ? 'AGENT CONFIGURATION' : 'SCRIPT TO VIDEO'
              }}</span>
              <h2>{{ dialogTitle }}</h2>
            </div>
            <button
              ref="modalClose"
              class="btn btn-icon"
              aria-label="关闭对话框"
              @click="dialog = null"
            >
              <X :size="17" />
            </button>
          </header>
          <template v-if="dialog === 'script'">
            <div class="vp-modal-body">
              <div class="vp-script-lock">
                <ShieldCheck :size="15" />第 {{ currentEpisode.number }} 集 ·
                {{ currentEpisode.title }} · 已确认
              </div>
              <pre class="vp-confirmed-script" aria-label="已确认剧本原文">{{
                confirmedScript
              }}</pre>
              <span class="vp-muted"
                >{{ confirmedScript.length }} 字 ·
                原文仅供核对，分镜与提示词在制作区编辑。</span
              >
            </div>
            <footer>
              <span class="vp-muted">{{ projectTitle }}</span
              ><button class="btn btn-primary" @click="dialog = null">
                关闭原文
              </button>
            </footer>
          </template>
          <template v-else-if="dialog === 'prompt-preview' && promptPreview">
            <div class="vp-modal-body">
              <p class="vp-final-prompt-meta">
                <strong>{{ promptPreview.title }}</strong>
                <span>{{ promptPreview.context }}</span>
                <span v-if="promptPreview.delivery" class="vp-final-prompt-count">{{ promptPreview.delivery.prompt.length }} 字</span>
              </p>
              <p v-if="promptPreview.pending" class="vp-muted" role="status">正在准备提示词…</p>
              <p v-else-if="promptPreview.error" class="vp-ai-error-detail" role="alert">{{ promptPreview.error }}</p>
              <template v-else-if="promptPreview.delivery">
                <p v-if="promptPreview.delivery.pending" class="vp-final-prompt-warning" role="status">{{ promptPreview.delivery.pending }}</p>
                <p v-if="promptPreview.delivery.missingVoices.length" class="vp-final-prompt-warning" role="status">{{ missingVideoVoiceMessage(promptPreview.delivery.missingVoices) }}</p>
                <p v-for="warning in promptPreview.delivery.warnings" :key="warning" class="vp-final-prompt-warning" role="status">{{ warning }}</p>
                <ScriptVideoFinalPrompt
                  :prompt="promptPreview.delivery.prompt"
                  :style-section="promptPreview.delivery.style"
                  :images="promptPreview.delivery.images"
                  :audios="promptPreview.delivery.audios"
                  :first-frame="promptPreview.delivery.firstFrame"
                />
              </template>
            </div>
            <footer v-if="promptPreview.delivery">
              <span class="vp-muted" role="status">{{ promptPreview.copied === true
                ? '已复制到剪贴板'
                : promptPreview.copied === false ? '可点击复制重试，或选中文本手动复制' : '' }}</span>
              <button type="button" class="btn btn-primary" @click="copyPromptPreview()">复制提示词</button>
            </footer>
          </template>
          <template v-else-if="dialog === 'project'">
            <form @submit.prevent="createProject">
              <div class="vp-modal-body">
                <label class="vp-field"
                  >项目名称<input
                    v-model="newProjectTitle"
                    class="input"
                    aria-label="新项目名称"
                    placeholder="为这部剧起个名字"
                    autofocus
                /></label>
                <p class="vp-modal-description">
                  一个项目包含多集剧本，角色、场景和道具可在各集间共用。
                </p>
                <ScriptVideoStylePresetEditor v-model="newProjectStyle" :presets="stylePresets" />
              </div>
              <footer class="vp-project-form-footer">
                <button type="button" class="btn" @click="dialog = null">
                  取消</button
                ><button
                  type="submit"
                  class="btn btn-primary"
                  :disabled="!newProjectTitle.trim() || !validNewProjectStyle || creatingProject"
                >
                  {{ creatingProject ? '正在创建…' : '创建项目' }}
                </button>
              </footer>
            </form>
          </template>
          <template v-else-if="dialog === 'style'">
            <form @submit.prevent="saveProjectStyle">
              <div class="vp-modal-body">
                <p class="vp-modal-description">{{ styleProjectTitle }} · 保存后，所选风格内容会同步到本项目已有的视频提示词，各集后续生成也会使用同一预设。</p>
                <ScriptVideoStylePresetEditor v-model="projectStyleDraft" :presets="stylePresets" />
              </div>
              <footer class="vp-project-form-footer">
                <button type="button" class="btn" @click="dialog = null">取消</button>
                <button type="submit" class="btn btn-primary" :disabled="!validProjectStyle || savingStyle || !canEditSharedProject">{{ savingStyle ? '正在保存…' : '保存项目风格' }}</button>
              </footer>
            </form>
          </template>
          <ScriptVideoProjectVideoExport
            v-else-if="dialog === 'project-video-export'"
            :key="currentProject.id"
            :project-id="currentProject.id"
            :episode-id="episodeOpen ? currentEpisode.id : undefined"
          />
          <template v-else-if="dialog === 'video-export'">
            <div class="vp-modal-body">
              <p class="vp-modal-description">默认选中所有有成片的片段（含上一版），按分镜顺序拼接成一个 MP4。</p>
              <div class="vp-export-clips">
                <label v-for="(card, index) in cards" :key="card.id" class="vp-export-clip">
                  <input
                    v-model="selectedExportIds"
                    type="checkbox"
                    :value="card.id"
                    :disabled="segmentExportBusy || !exportableCardIds.has(card.id)"
                  />
                  <span class="vp-export-number">{{ String(index + 1).padStart(2, '0') }}</span>
                  <strong>{{ card.title }}</strong>
                  <span class="vp-muted">{{ card.duration }} 秒</span>
                  <span class="vp-muted">{{ exportCardLabel(card) }}</span>
                </label>
              </div>
              <p v-if="segmentExportError || segmentExport?.error" class="vp-video-voice-warning" role="alert">
                {{ segmentExportError || segmentExport?.error }}
              </p>
              <p v-else-if="segmentExportBusy" class="vp-modal-description" role="status">正在拼接所选视频…</p>
            </div>
            <footer>
              <span class="vp-muted">已选 {{ selectedExportCards.length }} 段</span>
              <button
                type="button"
                class="btn btn-primary vp-export-submit"
                :disabled="segmentExportLoading || segmentExportBusy || !selectedExportCards.length"
                @click="exportSelectedSegments"
              >
                <LoaderCircle v-if="segmentExportBusy" :size="14" class="animate-spin" aria-hidden="true" />
                <Download v-else :size="14" aria-hidden="true" />
                {{ segmentExportBusy ? '拼接中…' : '拼接并导出' }}
              </button>
            </footer>
          </template>
          <template v-else-if="dialog === 'segment-delete' && pendingSegmentDeletion">
            <div class="vp-modal-body">
              <p class="vp-modal-description">删除「{{ pendingSegmentDeletion.title }}」后，它将从本集分镜片段中移除。</p>
            </div>
            <footer>
              <button class="btn" type="button" @click="dialog = null">取消</button>
              <button class="btn vp-confirm-delete" type="button" @click="confirmSegmentDeletion">
                <Trash2 :size="14" />确认删除
              </button>
            </footer>
          </template>
          <template v-else-if="dialog === 'video-retry' && pendingVideoRetry">
            <div class="vp-modal-body">
              <p class="vp-modal-description">
                {{ pendingVideoRetry.jobs.size }} 个片段的上次提交可能已被服务商受理。重新生成可能重复计费。
              </p>
              <p v-if="retryVideoVoiceWarning" id="vp-retry-video-voice" class="vp-video-voice-warning" role="status">
                {{ retryVideoVoiceWarning }}
              </p>
            </div>
            <footer>
              <button class="btn" @click="dialog = null">取消</button>
              <button
                v-if="pendingVideoRetry.cardIds.length > pendingVideoRetry.jobs.size"
                class="btn"
                :disabled="!!remainingVideoVoiceWarning"
                :aria-describedby="remainingVideoVoiceWarning ? 'vp-retry-video-voice' : undefined"
                @click="confirmVideoRetry(false)"
              >
                仅生成其余片段
              </button>
              <button
                class="btn btn-primary"
                :disabled="!!retryVideoVoiceWarning"
                :aria-describedby="retryVideoVoiceWarning ? 'vp-retry-video-voice' : undefined"
                @click="confirmVideoRetry(true)"
              >确认生成</button>
            </footer>
          </template>
          <template v-else-if="dialog === 'assets'">
            <div class="vp-modal-body vp-assets-body">
              <div class="vp-assets-toolbar">
                <p v-if="occupiedEpisodeIds.length" class="vp-modal-description" style="color: #b77429;" role="status">
                  还有其他页面在编辑本项目。共享资产以最后保存的修改为准。
                </p>
                <div class="vp-assets-import-bar">
                  <p class="vp-modal-description">
                    目录自动分类，完整文件名用于 @ 引用。不同造型分别保留，同名图片自动消歧。
                  </p>
                  <div class="vp-import-actions">
                    <button
                      class="btn btn-sm"
                      :disabled="assetImporting || !canEditSharedProject"
                      @click="assetFolderInput?.click()"
                    >
                      <FolderOpen :size="13" />导入文件夹
                    </button>
                    <button
                      class="btn btn-sm"
                      :disabled="assetImporting || !canEditSharedProject"
                      @click="assetZipInput?.click()"
                    >
                      <Package :size="13" />导入 ZIP
                    </button>
                    <button
                      class="btn btn-sm"
                      :disabled="assetImporting || !canEditSharedProject"
                      @click="assetInput?.click()"
                    >
                      <Upload :size="13" />选择图片
                    </button>
                  </div>
                </div>
                <p v-if="occupiedEpisodeIds.includes(selectedEpisodeId)" class="vp-muted">另一个页面也在编辑本集。</p>
                <div class="vp-search">
                  <Search :size="13" /><input
                    v-model="assetManageSearch"
                    placeholder="按资产名或目录搜索"
                    aria-label="搜索资产名称与目录"
                  />
                </div>
                <div class="vp-asset-manage-tabs" role="tablist" aria-label="资产分类">
                  <button
                    v-for="(kind, index) in assetManageTabs"
                    :id="`vp-asset-tab-${kind.value}`"
                    :key="kind.value"
                    type="button"
                    role="tab"
                    :aria-selected="assetManageKind === kind.value"
                    aria-controls="vp-managed-assets"
                    :tabindex="assetManageKind === kind.value ? 0 : -1"
                    :class="{ active: assetManageKind === kind.value }"
                    @click="assetManageKind = kind.value"
                    @keydown="onAssetManageTabKeydown($event, index)"
                  >{{ kind.label }}<span>{{ kind.count }}</span></button>
                </div>
              </div>
              <div
                id="vp-managed-assets"
                class="vp-managed-assets"
                role="tabpanel"
                :aria-labelledby="`vp-asset-tab-${assetManageKind}`"
                tabindex="0"
              >
                <ScriptVideoPreviewImportReport
                  v-if="assetImportReport"
                  class="vp-assets-import-report"
                  v-bind="assetImportReport"
                />
                <div class="vp-asset-edit-grid">
                  <div
                    v-for="asset in managedAssets"
                    :key="asset.id"
                    class="vp-asset-edit-row"
                    :class="{ focused: editingAssetId === asset.id }"
                    :title="asset.sourcePath || asset.name"
                  >
                    <span class="vp-asset-edit-image"><ScriptVideoPreviewAssetImage :asset="asset" /></span>
                    <div class="vp-asset-edit-fields">
                      <ScriptVideoAssetNameInput
                        :name="asset.name"
                        :disabled="!canEditSharedProject"
                        :commit="value => renameAsset(asset, value)"
                      />
                      <div class="vp-asset-edit-meta">
                        <BaseSelect
                          v-if="asset.kind !== 'audio'"
                          :model-value="asset.kind"
                          :options="assetKindOptions"
                          :searchable="false"
                          class="vp-asset-kind-select"
                          :aria-label="`资产类型 ${asset.name}`"
                          :disabled="!canEditSharedProject"
                          @update:model-value="changeAssetKind(asset, $event)"
                        />
                        <span v-else>音频</span>
                        <span v-if="asset.kind === 'audio' && asset.voiceAudio" class="vp-asset-source" :title="asset.voiceAudio.name">{{ asset.voiceAudio.name }}</span>
                        <span v-else-if="asset.sourcePath" class="vp-asset-source" :title="asset.sourcePath">{{ asset.sourcePath }}</span>
                      </div>
                    </div>
                    <div class="vp-asset-edit-actions">
                      <label v-if="asset.kind === 'audio'" class="btn btn-sm vp-asset-replace">
                        <Upload :size="13" aria-hidden="true" />
                        {{ voiceEdits.has(asset.id) ? '正在替换…' : '替换音频' }}
                        <input
                          type="file"
                          accept=".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav"
                          class="vp-replace-file"
                          :aria-label="`替换音频 ${asset.name}`"
                          :disabled="!canEditSharedProject || voiceEdits.has(asset.id)"
                          @change="replacePromptAudio(asset.id, $event)"
                        />
                      </label>
                      <label v-else class="btn btn-sm vp-asset-replace">
                        <Upload :size="13" aria-hidden="true" />
                        {{ replacingImages.has(asset.id) ? '正在替换…' : '替换图片' }}
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          class="vp-replace-file"
                          :aria-label="`替换图片 ${asset.name}`"
                          :disabled="!canEditSharedProject || replacingImages.has(asset.id)"
                          @change="replaceAssetImage(asset.id, $event)"
                        />
                      </label>
                      <button
                        type="button"
                        class="btn btn-icon vp-asset-delete"
                        :aria-label="`删除资产 ${asset.name}`"
                        aria-haspopup="dialog"
                        title="删除资产"
                        :disabled="!canEditSharedProject"
                        @click="requestAssetDeletion(asset)"
                      >
                        <Trash2 :size="14" />
                      </button>
                    </div>
                    <ScriptVideoCharacterVoice
                      v-if="asset.kind === 'character'"
                      class="vp-asset-voice"
                      :asset="asset"
                      :disabled="!episodeOpen || voiceEdits.has(asset.id)"
                      :uploading="voiceEdits.get(asset.id)?.operation === 'upload'"
                      @upload="uploadCharacterVoice(asset.id, $event)"
                      @remove="removeCharacterVoice(asset.id)"
                      @model-voice="setCharacterModelVoice(asset.id, $event)"
                    />
                    <audio v-else-if="asset.kind === 'audio' && asset.voiceAudio?.url" class="vp-asset-voice"
                      :key="asset.voiceAudio.url" :src="asset.voiceAudio.url" :aria-label="`试听音频 ${asset.name}`" controls preload="none" />
                  </div>
                </div>
                <div v-if="!managedAssets.length" class="vp-assets-empty" role="status">
                  <Images :size="28" />
                  <strong>{{ assets.length ? '没有匹配的资产' : '还没有资产' }}</strong>
                  <span>{{ assetManageSearch ? '试试其他名称或目录关键词' : '可导入文件夹、ZIP 或选择图片' }}</span>
                </div>
              </div>
            </div>
            <footer>
              <span class="vp-muted">
                共 {{ assets.length }} 项资产<span v-if="managedAssets.length !== assets.length"> · 当前显示 {{ managedAssets.length }} 项</span>
              </span>
              <button class="btn btn-primary" @click="dialog = null">
                完成<Check :size="14" />
              </button>
            </footer>
          </template>
          <template v-else-if="dialog === 'bindings'">
            <div class="vp-modal-body">
              <p class="vp-modal-description">
                {{ selectedCard?.title }} ·
                选择完整资产名，确认人物造型与本段配图。
              </p>
              <div class="vp-search">
                <Search :size="13" /><input
                  v-model="bindingSearch"
                  placeholder="搜索角色、造型或道具名"
                  aria-label="搜索本段资产"
                />
              </div>
              <label class="vp-check-label"
                ><input
                  v-model="bindCharacterToEpisode"
                  type="checkbox"
                />角色造型同时应用到本集涉及该人物的片段</label
              >
              <div class="vp-binding-grid">
                <button
                  v-for="asset in bindingAssets"
                  :key="asset.id"
                  class="vp-library-asset"
                  :class="{ used: selectedCard?.assetIds.includes(asset.id) }"
                  :aria-pressed="selectedCard?.assetIds.includes(asset.id)"
                  @click="chooseBinding(asset)"
                >
                  <span class="vp-library-image"
                    ><ScriptVideoPreviewAssetImage :asset="asset" /></span
                  ><span class="vp-library-copy"
                    ><strong>{{ asset.name }}</strong
                    ><small>{{ kindLabel(asset.kind) }}</small></span
                  ><Check
                    v-if="selectedCard?.assetIds.includes(asset.id)"
                    :size="13"
                  /><Plus v-else :size="13" />
                </button>
              </div>
            </div>
            <footer>
              <span class="vp-muted">只有已选择的素材会绑定到对应片段</span
              ><button class="btn btn-primary" @click="dialog = null">
                完成关联
              </button>
            </footer>
          </template>
          <template v-else-if="dialog === 'ai-error'">
            <div class="vp-modal-body">
              <pre class="vp-ai-error-detail">{{ currentAIError }}</pre>
            </div>
          </template>
          <template v-else-if="dialog === 'review'">
            <div class="vp-modal-body">
              <p class="vp-modal-description">对照本集原剧本，检查剧情、人物站位和片段衔接。每次复核单独调用一次文字模型。</p>
              <p v-if="currentReview" class="vp-muted">上次复核 · {{ new Date(currentReview.updatedAt).toLocaleString() }}</p>
              <template v-if="currentReview">
                <strong>{{ currentReview.passed ? '复核通过' : '发现需要调整的片段' }}</strong>
                <p class="vp-modal-description">{{ currentReview.continuityReview }}</p>
                <ul v-if="currentReview.issues.length" class="vp-validation-issues">
                  <li v-for="(issue, index) in currentReview.issues" :key="index" class="error">
                    <span>第 {{ issue.segmentNumber }} 段</span><p>{{ issue.message }}</p>
                  </li>
                </ul>
              </template>
              <p v-if="currentAIError" class="vp-ai-error-detail">{{ currentAIError }}</p>
            </div>
            <footer>
              <button class="btn" @click="dialog = null">返回制作</button>
              <button
                v-if="currentTextRun?.action === 'review'"
                class="btn"
                :disabled="currentTextRun.cancelRequested"
                @click="cancelTextGeneration"
              >{{ currentTextRun.cancelRequested ? '正在取消…' : '取消生成' }}</button>
              <button class="btn btn-primary" :disabled="busy || !!currentTextRun || !hasStoryboard" @click="runAI('review')">
                {{ currentTextRun?.action === 'review' ? '正在复核…' : currentReview ? '重新复核 · 1 次调用' : '开始复核 · 1 次调用' }}
              </button>
            </footer>
          </template>
          <template v-else-if="dialog === 'validation'">
            <div class="vp-modal-body">
              <div
                class="vp-validation-status"
                :class="{ passed: validation?.ok }"
                role="status"
              >
                <ShieldCheck :size="22" />
                <div>
                  <strong>{{
                    validation?.ok ? '检验通过' : '发现需要调整的问题'
                  }}</strong>
                  <p>
                    {{ validationScope }} · {{ validation?.cardCount }} 个片段
                  </p>
                </div>
              </div>
              <p class="vp-modal-description">
                字段与时长错误需要调整；内容与素材提示可在分镜中修改，不影响继续编辑。
              </p>
              <ul v-if="validation?.issues.length" class="vp-validation-issues">
                <li
                  v-for="(issue, index) in validation.issues"
                  :key="index"
                  :class="{ error: issue.level === 'ERROR' }"
                >
                  <span>{{ issue.level === 'ERROR' ? '需修改' : '提示' }}</span>
                  <p>
                    {{ issue.message
                    }}<small v-if="issue.line"
                      >（导出文稿第 {{ issue.line }} 行）</small
                    >
                  </p>
                </li>
              </ul>
              <p v-else class="vp-muted">
                本次字段与时长检查通过。
              </p>
              <ul v-if="validation?.warnings.length" class="vp-validation-issues">
                <li v-for="issue in validation.warnings" :key="issue.code + issue.message">
                  <span>提示</span><p>{{ issue.message }}</p>
                </li>
              </ul>
            </div>
            <footer>
              <span class="vp-muted">修改后继续操作即可，无需单独检验</span
              ><button class="btn btn-primary" @click="dialog = null">
                返回制作
              </button>
            </footer>
          </template>
          <template v-else
            ><div class="vp-modal-body">
              <div class="vp-agent-identity">
                <span><Clapperboard :size="23" /></span>
                <div>
                  <h3>剧本转视频</h3>
                  <p>读取剧本与资产，编排分镜并生成可引用资产的视频提示词。</p>
                </div>
                <span class="vp-preview-label">编排 Agent</span>
              </div>
              <nav class="vp-config-tabs">
                <button
                  :class="{ active: configTab === 'rules' }"
                  @click="configTab = 'rules'"
                >
                  System Prompt</button
                ><button
                  :class="{ active: configTab === 'skills' }"
                  @click="configTab = 'skills'"
                >
                  Skills <span>2</span>
                </button>
              </nav>
              <template v-if="configTab === 'rules'"
                ><label class="vp-field"
                  >编排指令<textarea
                    v-model="agentPrompt"
                    class="textarea vp-agent-prompt"
                  />
                </label>
                <div class="vp-config-rule-grid">
                  <span>原文台词保持锁定</span><span>先确认分段大纲</span
                  ><span>继承人物与末帧状态</span
                  ><label
                    ><input
                      v-model="combatEnabled"
                      type="checkbox"
                      :disabled="!canEditSharedProject"
                    />打戏按需调用高燃 Skill</label
                  >
                </div>
                <p class="vp-modal-description">
                  编排指令对当前项目的后续 AI
                  请求生效。剧本和原台词保持锁定，题材、五维与打斗资料按内容读取。
                </p></template
              ><template v-else
                ><article class="vp-config-skill">
                  <div>
                    <Clapperboard :size="17" /><strong
                      >SD2.5 短剧分镜智能体 v2.1</strong
                    ><span class="tag">主 Skill</span>
                  </div>
                  <p>
                    完整移植 v2.1 分镜包。主 Skill
                    读取总规则、正式输出模板、题材模块和五维镜头原始资料，从剧本编排分段大纲、五列分镜及带
                    @ 资产的视频提示词。
                  </p>
                  <ul>
                    <li>主干剧情优先排入 120 秒，通常分 4 段，尾段按剧情收束</li>
                    <li>合并次要动作，保留原文台词。台词拥挤时自动跨段，仍说不完再延长</li>
                    <li>逐镜时长之和等于本段目标时长</li>
                  </ul>
                  <p class="vp-skill-path">
                    backend/workspace/skills/script-to-video/SKILL.md
                  </p>
                  <p>
                    使用已配置文字模型真实编排，按阶段读取完整资料。分镜和候选输出后自动执行
                    TypeScript 检查，通过后才能采用或交付。
                  </p>
                </article>
                <article class="vp-config-skill">
                  <div>
                    <Swords :size="17" /><strong>高燃打斗</strong
                    ><label class="vp-check-label"
                      ><input
                        v-model="combatEnabled"
                        type="checkbox"
                        :disabled="!canEditSharedProject"
                      />启用</label
                    >
                  </div>
                  <p>
                    这个子 Skill
                    沿用已有的完整「高燃打斗」规则与资料，供打戏按镜头查阅攻防、兵器、受击反馈和特效。招式与胜负以本场剧本为准。
                  </p>
                  <p class="vp-skill-path">
                    backend/workspace/skills/script-to-video/fight-choreography/SKILL.md
                  </p>
                  <div class="vp-config-tags">
                    <span>攻防拆招</span><span>武器动作</span
                    ><span>受击反馈</span><span>打斗运镜</span>
                  </div>
                </article></template
              >
            </div>
            <footer>
              <button class="btn" @click="agentPrompt = defaultAgentPrompt">
                恢复默认指令</button
              ><button class="btn btn-primary" :disabled="!canEditSharedProject" @click="savePreviewConfig">
                <Check :size="14" />保存编排设置
              </button>
            </footer></template
          >
        </section>
      </div>
      <dialog
        v-if="dialog === 'assets' && episodeOpen"
        ref="assetDeleteDialog"
        class="vp-asset-delete-dialog"
        :aria-labelledby="assetDeleteTitleId"
        :aria-describedby="assetDeleteMessageId"
        @close="pendingAssetDeletion = undefined"
      >
        <h2 :id="assetDeleteTitleId">删除资产</h2>
        <p :id="assetDeleteMessageId">确定从项目资产中删除「{{ pendingAssetDeletion?.name }}」吗？使用了它的片段可能需要重新选择素材。</p>
        <div class="vp-asset-delete-actions">
          <button type="button" class="btn" autofocus @click="assetDeleteDialog?.close()">取消</button>
          <button type="button" class="btn vp-confirm-delete" @click="confirmAssetDeletion">确认删除</button>
        </div>
      </dialog>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
// Script-to-video production workspace using the existing studio design tokens.
definePageMeta({ alias: ['/script-to-video'] })
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleCheck,
  Clapperboard,
  Clock3,
  Download,
  FileText,
  FolderOpen,
  FlaskConical,
  Images,
  Layers,
  LoaderCircle,
  MonitorPlay,
  Package,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Swords,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { onBeforeRouteLeave } from 'vue-router'
import ScriptVideoEpisodePreview from '~/components/ScriptVideoEpisodePreview.vue'
import { useScriptVideoEpisodeLock } from '~/composables/useScriptVideoEpisodeLock'
import { useScriptVideoReferenceFrames } from '~/composables/useScriptVideoReferenceFrames'
import { usesJimengVideo } from '~/utils/jimengVideo'
import { jimengVideoModel } from '../../../../backend/src/services/jimeng-video-models'
import { LIBTV_VIDEO_RATIOS, libtvVideoModel } from '../../../../backend/src/services/libtv-video-models'
import {
  SCRIPT_VIDEO_STYLE_PRESETS,
  getScriptVideoStylePreset,
  hasScriptVideoPromptBody,
  isScriptVideoStylePreset,
  splitScriptVideoPromptStyle,
  type ScriptVideoStylePreset,
} from '../../../../backend/src/services/script-video-style'
import { buildScriptVideoDelivery, getScriptVideoMissingVoices, scriptVideoDeliveryTags, type ScriptVideoContinuation, type ScriptVideoLightingRange } from '../../../../backend/src/services/script-video-delivery'
import { buildScriptVideoEpisodeLightingPlan } from '../../../../backend/src/services/script-video-lighting-plan'
import { previousScriptVideoCard } from '../../../../backend/src/services/script-video-predecessor'
import { latestScriptVideoTaskUrls, officialScriptVideoUrl } from '../../../../backend/src/services/script-video-versions'
import { AICOST_VIDEO_RATIOS, AICOST_VIDEO_RESOLUTIONS, aicostVideoModelCapabilities } from '../../../../backend/src/services/aicost-video-models'
import { seedanceModelLimits } from '../../../../backend/src/services/seedance-models'
import { isScriptVideoChibiAppearance, scriptVideoCharacterBase, scriptVideoCharacterName } from '../../../../backend/src/services/script-video-asset-identity'
import { getScriptVideoOutlineDurationIssues } from '../../../../backend/src/services/script-video-types'
import { isScriptVideoEpisodeProgress, SCRIPT_VIDEO_EPISODE_PROGRESS_OPTIONS, type ScriptVideoEpisodeProgress } from '../../../../backend/src/services/script-video-episode-progress'
import { getScriptVideoContinuationScene } from '../../../../backend/src/services/script-video-scene-boundary'
import {
  hasScriptVideoStoryboard,
  scriptVideoCardPlayback,
  listScriptVideoVersions,
  scriptVideoEpisodeProgress,
  scriptVideoTimecode,
  splitScriptVideoOutlineSummary,
  type PreviewCard,
  type PreviewAsset,
  type PreviewProduction,
} from '~/utils/scriptVideoPreview'
import { exportPreviewPackage } from '~/utils/scriptVideoPreviewExport'
import {
  readEpisodeFile,
  groupImportedEpisodes,
  type ImportedEpisode,
} from '~/utils/scriptVideoPreviewEpisodes'
import {
  importPreviewAssets,
  readScriptVideoZip,
  resolvePreviewAssetNames,
} from '~/utils/scriptVideoPreviewAssets'
import {
  validatePreviewCards,
  type PreviewValidation,
} from '~/utils/scriptVideoPreviewValidation'

import { aiConfigAPI, uploadAPI } from '~/composables/useApi'
import {
  scriptVideoRequest,
  scriptVideoSession,
  scriptVideoJobError,
  waitScriptVideoJob,
  ScriptVideoRequestError,
  type ScriptVideoClientJob,
  type ScriptVideoJobProgress,
  type ScriptVideoRevisionCandidate,
} from '~/utils/scriptVideoClient'
import { diffScriptVideoChanges } from '../../../../backend/src/services/script-video-sync'
import { readScriptVideoDrafts, writeScriptVideoDraft, type ScriptVideoDraft } from '~/utils/scriptVideoDrafts'
import { readSiteAccount } from '~/utils/siteSession'
import { mergeScriptVideoProject } from '~/utils/scriptVideoStateMerge'
import {
  captureScriptVideoScroll,
  readScriptVideoViewPosition,
  restoreScriptVideoScroll,
  restoreScriptVideoStage,
  writeScriptVideoViewPosition,
  type ScriptVideoEditorTab,
  type ScriptVideoStage as Stage,
  type ScriptVideoViewPosition,
} from '~/utils/scriptVideoViewPosition'

const stages: Array<{ id: Stage; label: string }> = [
  { id: 'materials', label: '剧本与资产' },
  { id: 'outline', label: '分段大纲' },
  { id: 'production', label: '视频制作' },
]
type Task = {
  id: string
  taskId?: number
  cardId: string
  cardVersion: number
  title?: string
  status: 'processing' | 'completed' | 'failed' | 'canceled'
  videoUrl?: string
  staleResult?: boolean
  error?: string
  code?: string
  stage?: string
  modelLabel?: string
  duration?: number
  configId?: number
  spec?: string
  parts?: number
  continuation?: ScriptVideoContinuation
  lightingRanges?: ScriptVideoLightingRange[]
  lightingReviewShots?: number[]
}
type PreviewEpisode = {
  id: string
  _loaded?: boolean
  _episodeRevision?: number
  progress?: ReturnType<typeof scriptVideoEpisodeProgress>
  progressOverride?: ScriptVideoEpisodeProgress | null
  number: number
  title: string
  script: string
  sourceChapters?: ImportedEpisode['sourceChapters']
  sceneEstimates?: ImportedEpisode['sceneEstimates']
  expectedDuration?: number
  confirmedScript: string
  confirmed: boolean
  outlineConfirmed: boolean
  outlineDurationPolicy?: '30-except-tail-v1'
  stage: Stage
  cards: PreviewCard[]
  production?: PreviewProduction
  selectedCardId: string
  tasks: Task[]
  outlineSummaries: Record<string, string>
  busy: boolean
  modelConfigId?: number
  modelName?: string
  modelProvider?: string
  modelKey: string
  modelLabel: string
  modelMinDuration?: number
  modelMaxDuration: number
  modelWholeSeconds?: boolean
  modelMaxAudioReferences?: number | null
  modelMaxAudioDuration?: number
  aspectRatio: string
  resolution: string
  videoDurations?: Record<string, number>
}
type PreviewProject = {
  id: string
  revision: number
  settings?: {
    systemPrompt?: string
    combatEnabled?: boolean
    textSelection?: string
    stylePreset?: ScriptVideoStylePreset
  }
  title: string
  assets: PreviewAsset[]
  episodes: PreviewEpisode[]
  episodeId: string
}
let nextPreviewId = 0
function previewId(kind: string) {
  return `${kind}-${Date.now()}-${++nextPreviewId}-${Math.random().toString(36).slice(2, 10)}`
}
function makeEpisode(
  title: string,
  number: number,
  source = '',
): PreviewEpisode {
  return {
    id: previewId('episode'),
    number,
    title,
    script: source,
    confirmedScript: '',
    confirmed: false,
    outlineConfirmed: false,
    stage: 'materials',
    cards: [],
    selectedCardId: '',
    tasks: [],
    outlineSummaries: {},
    busy: false,
    modelKey: '',
    modelLabel: '',
    modelMaxDuration: 0,
    aspectRatio: '16:9',
    resolution: '480P',
  }
}
const loadingProjects = ref(true)
const loadError = ref('')
const aiErrors = ref<Record<string, string>>({})
type TextAction = Exclude<NonNullable<ScriptVideoClientJob['action']>, 'video'>
type TextRun = {
  projectId: string
  episodeId: string
  action: TextAction
  cardId?: string
  jobId?: string
  cancelRequested: boolean
  controller: AbortController
}
const textRuns = ref<Record<string, TextRun>>({})
const restoredRevisions = ref<Record<string, ScriptVideoRevisionCandidate>>({})
type AIProgress = {status: ScriptVideoClientJob['status']; progress: ScriptVideoJobProgress; jobId?: string; code?: string}
const aiProgress = ref<Record<string, AIProgress>>({})
type EpisodeReview = {passed: boolean; continuityReview: string; issues: {segmentNumber: number; message: string}[]; updatedAt: string}
const episodeReviews = ref<Record<string, EpisodeReview>>({})
const placeholderEpisode = makeEpisode('未命名分集', 1)
const placeholderProject: PreviewProject = {
  id: 'loading',
  revision: 0,
  title: '',
  assets: [],
  episodes: [placeholderEpisode],
  episodeId: placeholderEpisode.id,
}
const projects = ref<PreviewProject[]>([])
const selectedProjectId = ref('')
const selectedEpisodeId = ref('')
const selectingEpisode = ref(false)
const workspace = ref<HTMLElement | null>(null)
const editorTab = ref<ScriptVideoEditorTab>('prompt')
const restoredStage = ref<Stage>()
let restoringView = true
let lastViewPosition: ScriptVideoViewPosition | undefined
const episodeAccessNotice = ref('')
const deletingProjectId = ref('')
const noProjects = computed(() => !loadingProjects.value && !loadError.value && !projects.value.length)
const currentProject = computed(
  () =>
    projects.value.find((project) => project.id === selectedProjectId.value) ||
    projects.value[0] || placeholderProject,
)
const currentEpisode = computed(
  () =>
    currentProject.value.episodes.find(
      (episode) => episode.id === selectedEpisodeId.value,
    ) || placeholderEpisode,
)
const episodeOptions = computed(() =>
  projects.value.length ? currentProject.value.episodes.map((episode) => ({
    id: episode.id,
    number: episode.number,
    title: episode.title,
    confirmed: episode.confirmed,
    progress: episode._loaded === false ? episode.progress : scriptVideoEpisodeProgress(episode),
  })) : [],
)
const episodeProgressOptions = [
  { value: 'auto', label: '自动判断' },
  ...SCRIPT_VIDEO_EPISODE_PROGRESS_OPTIONS.map(progress => ({ value: progress, label: progress })),
]
const episodeProgressSelection = computed({
  get: () => currentEpisode.value.progressOverride ?? 'auto',
  set: (value: string | number) => {
    if (!episodeOpen.value) return
    if (value === 'auto') currentEpisode.value.progressOverride = null
    else if (isScriptVideoEpisodeProgress(value)) currentEpisode.value.progressOverride = value
  },
})
const projectTitle = computed(() => currentProject.value.title)
const stage = computed({
  get: () => restoredStage.value ?? currentEpisode.value.stage,
  set: (value: Stage) => {
    restoredStage.value = undefined
    currentEpisode.value.stage = value
  },
})
watch(() => currentEpisode.value.stage, () => { restoredStage.value = undefined })
watch(stage, next => {
  if (next === 'production') editorTab.value = 'prompt'
}, { flush: 'sync' })
const script = computed({
  get: () => currentEpisode.value.script,
  set: (value: string) => {
    currentEpisode.value.script = value
    currentEpisode.value.confirmed =
      value === currentEpisode.value.confirmedScript && Boolean(value.trim())
  },
})
const confirmedScript = computed(() => currentEpisode.value.confirmedScript)
const currentAIError = computed(
  () => aiErrors.value[currentEpisode.value.id] || '',
)
const episodeKey = computed(() => `${currentProject.value.id}/${currentEpisode.value.id}`)
const currentReview = computed(() => episodeReviews.value[episodeKey.value])
const currentProgress = computed(() => aiProgress.value[episodeKey.value])
const currentProgressText = computed(() => storyboardProgressText(currentProgress.value))
const currentTextRun = computed(() => textRuns.value[episodeKey.value])
const currentTextStatus = computed(() => {
  const run = currentTextRun.value
  if (!run) return ''
  if (run.cancelRequested) return '正在取消生成…'
  return currentProgressText.value || {
    outline: '正在生成分段大纲…',
    storyboard: '正在生成分镜…',
    review: '正在复核分镜…',
    revisions: '正在生成修改候选…',
  }[run.action]
})
const storyboardAction = computed(() => storyboardActionFor(currentProgress.value))
const cards = computed({
  get: () => currentEpisode.value.cards,
  set: (value: PreviewCard[]) => {
    currentEpisode.value.cards = value
  },
})
const hasStoryboard = computed(() => hasScriptVideoStoryboard(currentEpisode.value))
const assets = computed({
  get: () => currentProject.value.assets,
  set: (value: PreviewAsset[]) => {
    currentProject.value.assets = value
  },
})
const selectedCardId = computed({
  get: () => currentEpisode.value.selectedCardId,
  set: (value: string) => {
    currentEpisode.value.selectedCardId = value
  },
})
const tasks = computed({
  get: () => currentEpisode.value.tasks,
  set: (value: Task[]) => {
    currentEpisode.value.tasks = value
  },
})
const busy = computed({
  get: () => deletingProjectId.value === currentProject.value.id ||
    currentEpisode.value.busy || (!!currentTextRun.value && currentTextRun.value.action !== 'revisions'),
  set: (value: boolean) => {
    currentEpisode.value.busy = value
  },
})
const outlineButtonDisabled = computed(
  () => busy.value || !!currentTextRun.value || (assets.value.length > 0 && !script.value.trim()),
)
const combatEnabled = computed({
  get: () => currentProject.value.settings?.combatEnabled !== false,
  set: (value: boolean) => {
    if (canEditSharedProject.value) {
      currentProject.value.settings = { ...currentProject.value.settings, combatEnabled: value }
    }
  },
})
const exporting = ref(false),
  importing = ref(false),
  assetImporting = ref(false)
type ImportReport = {
  title: string
  summary: string
  details: string[]
  errors: string[]
}
const assetReports = ref<Record<string, ImportReport>>({})
const episodeReports = ref<Record<string, ImportReport>>({})
const assetImportReport = computed(
  () => assetReports.value[currentProject.value.id],
)
const episodeImportReport = computed(
  () => episodeReports.value[currentProject.value.id],
)
const assetManageSearch = ref('')
const assetManageKind = ref('all')
const managedAssets = computed(() =>
  assets.value.filter((asset) =>
    (assetManageKind.value === 'all' || asset.kind === assetManageKind.value) &&
    `${asset.name}\n${asset.sourcePath || ''}`
      .toLowerCase()
      .includes(assetManageSearch.value.toLowerCase()),
  ),
)
const validation = ref<PreviewValidation>()
const validationScope = ref('')
const bindingSearch = ref('')
const bindCharacterToEpisode = ref(true)
const bindingAssets = computed(() =>
  assets.value.filter((asset) =>
    asset.kind !== 'audio' && asset.name.toLowerCase().includes(bindingSearch.value.toLowerCase()),
  ),
)
const newProjectTitle = ref('')
const stylePresets = shallowRef<readonly ScriptVideoStylePreset[]>(SCRIPT_VIDEO_STYLE_PRESETS)
const newProjectStyle = ref<ScriptVideoStylePreset>(getScriptVideoStylePreset('cool')!)
const projectStyleDraft = ref<ScriptVideoStylePreset>(getScriptVideoStylePreset('cool')!)
let projectStyleBaseline: ScriptVideoStylePreset | undefined
let stylePresetRequest: Promise<void> | undefined
function sameStylePreset(first?: ScriptVideoStylePreset, second?: ScriptVideoStylePreset) {
  return !!first && !!second && first.id === second.id && first.name === second.name && first.prefix === second.prefix
}
function refreshStyleDraft(
  draft: { value: ScriptVideoStylePreset }, previous: readonly ScriptVideoStylePreset[],
  next: readonly ScriptVideoStylePreset[], baseline?: ScriptVideoStylePreset,
) {
  const saved = previous.find(preset => preset.id === draft.value.id)
  if (!sameStylePreset(draft.value, saved) && !sameStylePreset(draft.value, baseline)) return
  const latest = next.find(preset => preset.id === draft.value.id && preset.name === draft.value.name)
  if (latest && !sameStylePreset(draft.value, latest)) draft.value = { ...latest }
}
function loadStylePresets(): Promise<void> {
  if (stylePresetRequest) return stylePresetRequest
  stylePresetRequest = (async () => {
    const response = await scriptVideoRequest<ScriptVideoStylePreset[]>('/style-presets', 'GET', undefined,
      AbortSignal.any([requestController.signal, AbortSignal.timeout(8000)]))
    if (!alive || !Array.isArray(response)) return
    const previous = stylePresets.value
    const latest = (['cool', 'warm'] as const).map(id => response.find(preset =>
      isScriptVideoStylePreset(preset) && preset.id === id && preset.name === (id === 'cool' ? '冷色调' : '暖色调')))
    if (latest.some(preset => !preset)) return
    const next = latest.map(preset => previous.find(saved => sameStylePreset(saved, preset)) || { ...preset! })
    refreshStyleDraft(newProjectStyle, previous, next)
    refreshStyleDraft(projectStyleDraft, previous, next, projectStyleBaseline)
    if (next.some((preset, index) => preset !== previous[index])) stylePresets.value = next
  })().catch(() => {
    // Keep the current presets and local drafts available while offline.
  }).finally(() => { stylePresetRequest = undefined })
  return stylePresetRequest
}
const creatingProject = ref(false)
const savingStyle = ref(false)
const styleProjectId = ref('')
const voiceEdits = ref(new Map<string, {
  projectId: string; operation: 'upload' | 'save'; completion: Promise<void>
}>())
function pendingAudioEdits(projectId: string) {
  const edits = [...voiceEdits.value.values()].filter(edit => edit.projectId === projectId)
  if (edits.length) return Promise.all(edits.map(edit => edit.completion))
}
const styleProjectTitle = computed(() => projects.value.find(project => project.id === styleProjectId.value)?.title || '')
const validNewProjectStyle = computed(() => isScriptVideoStylePreset(newProjectStyle.value))
const validProjectStyle = computed(() => isScriptVideoStylePreset(projectStyleDraft.value))
const selectedCard = computed(
  () =>
    cards.value.find((card) => card.id === selectedCardId.value) ||
    cards.value[0],
)
const activeRevisionState = computed(() => {
  const run = currentTextRun.value
  if (run?.action !== 'revisions' || (run.cardId && run.cardId !== selectedCard.value?.id)) return undefined
  return run.cancelRequested ? 'canceling' : 'running'
})
const selectedRestoredRevision = computed(() => restoredRevisions.value[`${episodeKey.value}/${selectedCard.value?.id}`])
function clearRestoredRevision() {
  delete restoredRevisions.value[`${episodeKey.value}/${selectedCard.value?.id}`]
}
watch(() => selectedCard.value?.id, () => { editorTab.value = 'prompt' }, { flush: 'sync' })
const totalDuration = computed(() =>
  Number(cards.value.reduce((sum, card) => sum + card.duration, 0).toFixed(1)),
)
const editingWarnings = computed(() => {
  const written = cards.value.filter(card => card.shots?.length && card.prompt?.trim())
  if (!written.length) return []
  return validatePreviewCards(written, assets.value, {
    ...deliveryOptions(currentProject.value, currentEpisode.value),
    script: confirmedScript.value, production: currentEpisode.value.production,
    scope: written.length === cards.value.length ? 'episode' : 'prefix',
  }).warnings
})
const editingOutlineCardId = ref('')
const outlineRows = computed(() => {
  let elapsed = 0
  return cards.value.map((card) => {
    const start = scriptVideoTimecode(elapsed)
    elapsed += card.duration
    return {
      card,
      range: `${start}–${scriptVideoTimecode(elapsed)}`,
      sections: splitScriptVideoOutlineSummary(card.summary),
    }
  })
})
watch([() => currentEpisode.value.id, stage], () => {
  editingOutlineCardId.value = ''
})
const assetKinds = [
  { value: 'all', label: '全部' },
  { value: 'character', label: '角色' },
  { value: 'scene', label: '场景' },
  { value: 'prop', label: '道具' },
  { value: 'creature', label: '生物' },
  { value: 'audio', label: '音频' },
]
const assetKindOptions = assetKinds.filter(kind => kind.value !== 'all' && kind.value !== 'audio')
const assetManageTabs = computed(() => assetKinds.map(kind => ({
  ...kind,
  count: kind.value === 'all' ? assets.value.length : assets.value.filter(asset => asset.kind === kind.value).length,
})))
function onAssetManageTabKeydown(event: KeyboardEvent, index: number) {
  const lastIndex = assetKinds.length - 1
  const nextIndex = event.key === 'ArrowRight' ? (index + 1) % assetKinds.length
    : event.key === 'ArrowLeft' ? (index + lastIndex) % assetKinds.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? lastIndex : -1
  if (nextIndex < 0) return
  event.preventDefault()
  assetManageKind.value = assetKinds[nextIndex]!.value
  const tab = event.currentTarget as HTMLButtonElement
  const nextTab = tab.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]
  nextTab?.focus()
}
const kindLabel = (kind: string) =>
  ({ character: '角色', scene: '背景', prop: '道具', creature: '生物', audio: '音频' })[
    kind
  ] || '资产'
const statusLabel = (status: string) =>
  ({
    draft: '待生成',
    queued: '排队中',
    generating: '生成中',
    ready: '视频已生成',
    failed: '生成失败',
    canceled: '已取消',
    previous: '有上一版成片',
  })[status] || '待生成'
const dialog = ref<
    | 'script'
    | 'assets'
    | 'skills'
    | 'project'
    | 'style'
    | 'video-retry'
    | 'video-export'
    | 'project-video-export'
    | 'segment-delete'
    | 'prompt-preview'
    | 'validation'
    | 'ai-error'
    | 'review'
    | 'bindings'
    | null
  >(null),
  editingAssetId = ref(''),
  configTab = ref('skills')
const dialogTitle = computed(
  () =>
    ({
      script: '已确认剧本原文',
      project: '新建剧本转视频项目',
      style: '项目统一风格',
      'video-retry': '重新生成视频',
      'video-export': '一键导出',
      'project-video-export': '导出全部视频',
      'segment-delete': '删除片段',
      'prompt-preview': '最终视频提示词',
      assets: '管理本次资产',
      skills: 'Agent 与 Skills',
      validation: '分镜需要调整',
      'ai-error': 'AI 编排错误详情',
      review: '整集 AI 复核',
      bindings: '选择片段资产与人物造型',
    })[dialog.value || ''] || '',
)
const modalClose = ref<HTMLButtonElement | null>(null)
let promptReturnFocus: HTMLElement | null = null
let projectExportTrigger: HTMLElement | null = null
function openProjectVideoExport(event: MouseEvent) {
  projectExportTrigger = event.currentTarget as HTMLElement
  dialog.value = 'project-video-export'
}
const focusTrappedDialogs = ['prompt-preview', 'video-export', 'segment-delete', 'project-video-export']
watch(dialog, async (next, previous) => {
  if (next && focusTrappedDialogs.includes(next)) {
    await nextTick()
    modalClose.value?.focus()
  } else if (previous === 'prompt-preview' && !next) {
    promptReturnFocus?.focus()
    promptReturnFocus = null
  } else if (previous === 'project-video-export' && !next) {
    projectExportTrigger?.focus()
    projectExportTrigger = null
  }
})
function keepDialogFocus(event: KeyboardEvent) {
  if (!dialog.value || !focusTrappedDialogs.includes(dialog.value)) return
  const controls = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), a[href], audio[controls], [tabindex]:not([tabindex="-1"])',
  )).filter(control => control.getClientRects().length)
  const first = controls[0], last = controls.at(-1)
  if (event.shiftKey && event.target === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && event.target === last) {
    event.preventDefault()
    first?.focus()
  }
}
const defaultAgentPrompt =
  '你是剧本转视频编排 Agent。读取本集剧本与资产，先出大纲，确认后写正式分镜与视频提示词。把主干剧情优先排进 120 秒以内，通常安排 4 段，非尾段精确 30 秒，尾段按剧情收束。保持已确认事件的顺序、人物关系和结果，删减次要动作、走位和重复反应，把能并行的画面放在原对白、心声或画外音进行时。按自然语速逐字保留原台词。某一段拥挤时用相邻段余量，在自然停顿处跨段承接。全篇仍说不完时自动延长，只增加必要时间。模型自行决定时长和分段，保留用户的资产选择与跨段动作、声音衔接。原文中的预计时长不参与估算。按本段出镜资产写 @ 引用，按实际剧情读取题材资料。'
const agentPrompt = ref(defaultAgentPrompt),
  lockDialogue = ref(true),
  requireOutline = ref(true),
  keepContinuity = ref(true)
const videoModel = computed({
  get: () => currentEpisode.value.modelKey,
  set: (value: string) => {
    currentEpisode.value.modelKey = value
  },
})
const selectedSeedance = computed(() => {
  const episode = currentEpisode.value
  return episode.modelProvider === 'volcengine' ? seedanceModelLimits(episode.modelName || '') : null
})
const usesAicost = computed(() => currentEpisode.value.modelProvider === 'aicost')
const usesJimeng = computed(() => usesJimengVideo(currentEpisode.value.modelProvider, currentEpisode.value.modelName))
const selectedLibTV = computed(() => currentEpisode.value.modelProvider === 'libtv'
  ? libtvVideoModel(currentEpisode.value.modelName || '') : undefined)
const selectedAicost = computed(() => usesAicost.value ? aicostVideoModelCapabilities(currentEpisode.value.modelName || '') : null)
const modelResolutions = computed(() =>
  (usesAicost.value ? selectedAicost.value?.resolutions ?? AICOST_VIDEO_RESOLUTIONS
    : usesJimeng.value ? jimengVideoModel(currentEpisode.value.modelName || '')?.resolutions
    : selectedLibTV.value?.resolutions ?? selectedSeedance.value?.resolutions)
    ?.map(size => size.toUpperCase()) ?? ['480P', '720P', '1080P'],
)
const modelAspectRatios = computed<readonly string[]>(() =>
  usesAicost.value ? selectedAicost.value?.ratios ?? AICOST_VIDEO_RATIOS
    : selectedLibTV.value ? LIBTV_VIDEO_RATIOS
    : usesJimeng.value ? ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
    : selectedSeedance.value?.version === '2.5' ? ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'] : ['16:9', '9:16', '1:1', '4:3', '3:4'],
)
const aspectRatioOptions = computed(() => modelAspectRatios.value.map(ratio => ({
  value: ratio,
  label: ratio === 'adaptive' ? '自动适配' : ratio,
})))
const aspectRatio = computed({
  get: () => currentEpisode.value.aspectRatio,
  set: (value: string) => {
    currentEpisode.value.aspectRatio = value
  },
})
const resolution = computed({
  get: () => currentEpisode.value.resolution?.toUpperCase() || '',
  set: (value: string) => {
    currentEpisode.value.resolution = value
  },
})
const videoDuration = computed<number | string>({
  get: () => selectedCard.value ? (currentEpisode.value.videoDurations?.[selectedCard.value.id] ?? '') : '',
  set: (value) => {
    const card = selectedCard.value
    if (!card || !episodeOpen.value || videoRequestPending.value) return
    const episode = currentEpisode.value
    const durations = { ...episode.videoDurations }
    if (value === '') delete durations[card.id]
    else if (typeof value === 'number' && Number.isInteger(value) && !videoDurationIssue(episode, value)) durations[card.id] = value
    else return
    episode.videoDurations = durations
  },
})
const selectedVideoDurationIssue = computed(() => selectedCard.value && currentEpisode.value.modelMaxDuration > 0
  ? videoDurationIssue(currentEpisode.value, typeof videoDuration.value === 'number' ? videoDuration.value : selectedCard.value.duration) : '')
const videoDurationOptions = computed(() => {
  const episode = currentEpisode.value
  const min = Math.max(1, Math.ceil(episode.modelMinDuration ?? 1))
  const max = Math.min(30, Math.floor(episode.modelMaxDuration))
  const options: { value: number | string; label: string; disabled?: boolean }[] = [
    { value: '', label: `跟随分镜（${selectedCard.value?.duration ?? 0} 秒）` },
  ]
  const selected = videoDuration.value
  if (typeof selected === 'number' && (selected < min || selected > max)) {
    options.push({ value: selected, label: `${selected} 秒`, disabled: true })
  }
  for (let seconds = min; seconds <= max; seconds++) {
    options.push({ value: seconds, label: `${seconds} 秒` })
  }
  return options
})
const videoDurationHint = computed(() => {
  const card = selectedCard.value
  if (!card) return ''
  if (selectedVideoDurationIssue.value) return selectedVideoDurationIssue.value
  return typeof videoDuration.value === 'number'
    ? `分镜 ${card.duration} 秒 · ${card.shots.length} 个镜头`
    : '可单独设置当前片段的出片时长'
})
const scriptInput = ref<HTMLInputElement>(),
  assetInput = ref<HTMLInputElement>(),
  assetFolderInput = ref<HTMLInputElement>(),
  assetZipInput = ref<HTMLInputElement>()
const running = computed(() =>
  videoRequestPending.value || tasks.value.some((task) => task.status === 'processing'),
)
let alive = true
const requestController = new AbortController()
const saveErrors = ref<Record<string, string>>({})
const savingProjects = ref(new Set<string>())
const currentSaveError = computed(
  () => saveErrors.value[currentProject.value.id] || '',
)
const syncing = ref(false)
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const saveQueues = new Map<string, Promise<void>>()
const locallySaved = ref(new Set<string>())
const pendingEdits = ref(new Set<string>())
const serverSnapshots = new Map<string, PreviewProject>()
const episodeLock = useScriptVideoEpisodeLock()
const occupiedEpisodeIds = computed(() => Object.keys(episodeLock.occupied.value))
const episodeOpen = computed(() => !selectingEpisode.value && !!selectedEpisodeId.value &&
  currentEpisode.value._loaded !== false && currentEpisode.value !== placeholderEpisode)
const episodeNavigationBusy = computed(() => selectingEpisode.value || importing.value ||
  assetImporting.value || savingStyle.value || voiceEdits.value.size > 0 || !!deletingProjectId.value ||
  !!currentTextRun.value?.cancelRequested)
const canEditSharedProject = computed(() => episodeOpen.value)
const textOptions = ref<
  {
    key: string
    model: string
    provider: string
    configId: number
    configName: string
  }[]
>([])
const textSelection = computed({
  get: () => currentProject.value.settings?.textSelection || '',
  set: (value: string) => {
    if (!canEditSharedProject.value) return
    currentProject.value.settings = {
      ...currentProject.value.settings,
      textSelection: value,
    }
  },
})
type EpisodeSummary = Pick<PreviewEpisode, 'id' | 'number' | 'title' | 'stage' | 'confirmed' | 'outlineConfirmed' | 'progressOverride'> &
  { progress?: PreviewEpisode['progress']; revision?: number }
type ProjectSummary = Omit<PreviewProject, 'assets' | 'episodes'> & { assets?: PreviewAsset[]; episodes: EpisodeSummary[] }
type SavedChanges = { project: ProjectSummary; episodes: PreviewEpisode[]; revision: number; sequence: number }
type Draft = ScriptVideoDraft<PreviewProject>
type Writer = Pick<Draft, 'clientId' | 'sequence' | 'sending'>
const writers = new Map<string, Writer>()
const diskQueues = new Map<string, Promise<void>>()
const timersForRetry = new Map<string, ReturnType<typeof setTimeout>>()
const sharedLoaded = new Map<string, number>()
let draftAccount = ''
let tabId = ''
let canSend = true
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) }
function localProject(id: string) { return projects.value.find(project => project.id === id) }
function writer(id: string): Writer {
  if (!writers.has(id)) writers.set(id, { clientId: previewId('editor'), sequence: 0 })
  return writers.get(id)!
}
function changesSince(base: PreviewProject, local: PreviewProject) {
  return diffScriptVideoChanges(base, local, { loadedEpisodeIds: local.episodes.filter(ep => ep._loaded !== false).map(ep => ep.id) })
}
function materialize(summary: ProjectSummary, bodies: PreviewEpisode[], old?: PreviewProject): PreviewProject {
  const byId = new Map(bodies.map(ep => [ep.id, ep]))
  const bodyRevisions = new Map(summary.episodes.map(ep => [ep.id, ep.revision ?? summary.revision]))
  const previous = new Map(old?.episodes.map(ep => [ep.id, ep]))
  // A detail GET and a PATCH can finish on either side of the shared summary.
  // Advance directory metadata and individual bodies independently.
  const staleSummary = !!old && summary.revision < (sharedLoaded.get(summary.id) ?? -1)
  const directory = staleSummary ? old! : summary
  if (!staleSummary) sharedLoaded.set(summary.id, summary.revision)
  const episodes = directory.episodes.map(row => {
    const body = byId.get(row.id), prior = previous.get(row.id)
    const bodyRevision = bodyRevisions.get(row.id) ?? -1
    if (body && bodyRevision >= (prior?._episodeRevision ?? -1)) {
      return { ...body, _loaded: true, _episodeRevision: bodyRevision }
    }
    if (prior && prior._loaded !== false) return staleSummary || bodyRevision < (prior._episodeRevision ?? -1)
      ? prior : { ...prior, ...row }
    return { ...placeholderEpisode, ...row, _loaded: false }
  })
  return { ...directory, revision: Math.max(summary.revision, old?.revision ?? -1), assets: directory.assets ?? old?.assets ?? [], episodes }
}
function acceptProject(remote: PreviewProject, submitted?: PreviewProject) {
  const local = localProject(remote.id), base = submitted ?? serverSnapshots.get(remote.id)
  if (!submitted && (serverSnapshots.get(remote.id)?.revision ?? -1) > remote.revision) return
  const actual = (serverSnapshots.get(remote.id)?.revision ?? -1) > remote.revision ? serverSnapshots.get(remote.id)! : remote
  const installed = local && base ? mergeScriptVideoProject(base, copy(local), actual).project : copy(actual)
  serverSnapshots.set(remote.id, copy(actual))
  if (local) {
    for (const key of Object.keys(local)) if (!(key in installed)) Reflect.deleteProperty(local, key)
    Object.assign(local, installed)
  }
  else projects.value.push(installed)
}
async function refreshProject(projectId: string, episodeId?: string, signal?: AbortSignal, withShared = true) {
  const basePath = `/projects/${encodeURIComponent(projectId)}`
  const [summary, detail] = await Promise.all([
    withShared || !sharedLoaded.has(projectId) ? scriptVideoRequest<ProjectSummary>(`${basePath}?view=summary`, 'GET', undefined, signal) : undefined,
    episodeId ? scriptVideoRequest<{ episode: PreviewEpisode; revision: number; episodeRevision: number }>(
      `${basePath}/episodes/${encodeURIComponent(episodeId)}`, 'GET', undefined, signal) : undefined,
    withShared || !sharedLoaded.has(projectId) ? loadStylePresets() : undefined,
  ])
  if (!alive || signal?.aborted) return
  const base = serverSnapshots.get(projectId)
  if (summary) acceptProject(materialize(summary, [], base))
  const updated = serverSnapshots.get(projectId)
  if (detail && updated) {
    const index = updated.episodes.findIndex(ep => ep.id === episodeId)
    if (index >= 0 && detail.episodeRevision >= (updated.episodes[index]!._episodeRevision ?? -1)) {
      const next = { ...updated, revision: Math.max(detail.revision, updated.revision), episodes: updated.episodes.slice() }
      next.episodes[index] = { ...detail.episode, _loaded: true, _episodeRevision: detail.episodeRevision }
      acceptProject(next)
    }
  }
}
function persistDraft(id: string, dirty: boolean): Promise<void> {
  const project = localProject(id), base = serverSnapshots.get(id)
  if (!project || !base) return Promise.resolve()
  const record = dirty ? copy<Draft>({ account: draftAccount, tabId, projectId: id, ...writer(id), base, local: project }) : undefined
  const prior = diskQueues.get(id) ?? Promise.resolve()
  const next = prior.catch(() => {}).then(() => {
    if (alive) return writeScriptVideoDraft(draftAccount, tabId, id, record)
  }).then(() => {
    if (diskQueues.get(id) !== next) return
    if (dirty) locallySaved.value.add(id)
    else locallySaved.value.delete(id)
  })
  diskQueues.set(id, next)
  return next
}
function writeStatus(id: string) {
  const project = localProject(id), base = serverSnapshots.get(id)
  if (!base || !project) return false
  const dirty = !!writer(id).sending || changesSince(base, project).length > 0
  if (dirty) pendingEdits.value.add(id)
  else pendingEdits.value.delete(id)
  return dirty
}
async function keepDraft(id: string) {
  if (writeStatus(id)) await persistDraft(id, true)
}
async function retrySave() {
  if (!canSend && navigator.onLine) await reconnect()
  await saveProjectNow().catch(error => toast.error(error.message))
}
async function syncProject(projectId: string) {
  const state = writer(projectId)
  for (;;) {
    const project = localProject(projectId), base = serverSnapshots.get(projectId)
    if (!project || !base) return
    const changes = changesSince(base, project)
    if (!state.sending && !changes.length) break
    if (!state.sending) state.sending = { sequence: ++state.sequence, changes, submitted: copy(project) }
    const batch = state.sending
    pendingEdits.value.add(projectId)
    try { await persistDraft(projectId, true) }
    catch { locallySaved.value.delete(projectId) }
    if (!canSend || !navigator.onLine) throw new Error(locallySaved.value.has(projectId) ? '已保存到本机，等待网络或原账号恢复后同步' : '未能写入本机草稿，请保持此页面打开')
    const saved = await scriptVideoRequest<SavedChanges>(`/projects/${projectId}/changes`, 'PATCH', {
      clientId: state.clientId, sequence: batch.sequence, changes: batch.changes,
      expectedUser: draftAccount,
      loadedEpisodeIds: selectedProjectId.value === projectId && selectedEpisodeId.value ? [selectedEpisodeId.value] : [],
    }, AbortSignal.timeout(20_000)).catch(error => {
      // A definite rejection has not consumed the write. Let a corrected edit replace
      // it. An ambiguous failure retains its exact sequence and payload for replay.
      if (error instanceof ScriptVideoRequestError && [400, 404, 409, 413, 422].includes(error.status)) {
        state.sending = undefined
        void persistDraft(projectId, true).catch(() => {})
      }
      if (error instanceof ScriptVideoRequestError && [401, 403].includes(error.status)) canSend = false
      throw error
    })
    if (saved.sequence !== batch.sequence) throw new Error('未收到本次保存确认，修改已保留')
    const latest = serverSnapshots.get(projectId)
    acceptProject(materialize(saved.project, saved.episodes, latest), batch.submitted)
    state.sending = undefined
    delete saveErrors.value[projectId]
    // A newly mounted instance of this tab may already have edited the draft.
    // Leave the durable sequence for that instance to acknowledge idempotently.
    if (!alive) return
  }
  if (pendingEdits.value.has(projectId) || locallySaved.value.has(projectId)) {
    pendingEdits.value.delete(projectId)
    await persistDraft(projectId, false).catch(() => {})
  }
  delete saveErrors.value[projectId]
}
async function saveProjectNow(projectId = currentProject.value.id): Promise<void> {
  if (loadingProjects.value || projectId === 'loading' || projectId === deletingProjectId.value) return
  clearTimeout(saveTimers.get(projectId))
  clearTimeout(timersForRetry.get(projectId))
  const running = saveQueues.get(projectId)
  if (running) { await running; if (writeStatus(projectId)) await saveProjectNow(projectId); return }
  const queued = syncProject(projectId).catch(error => {
    saveErrors.value[projectId] = error instanceof ScriptVideoRequestError ? error.message :
      locallySaved.value.has(projectId) ? '已保存到本机，等待同步' : '同步失败，请保持此页面打开'
    if (alive && navigator.onLine && canSend && (!(error instanceof ScriptVideoRequestError) || error.status >= 500)) {
      timersForRetry.set(projectId, setTimeout(() => { void saveProjectNow(projectId).catch(() => {}) }, 6000))
    }
    throw error
  }).finally(() => { savingProjects.value.delete(projectId); saveQueues.delete(projectId) })
  savingProjects.value.add(projectId)
  saveQueues.set(projectId, queued)
  await queued
}
watch(projects, () => {
  if (loadingProjects.value || syncing.value || !alive) return
  for (const project of projects.value) {
    if (project.id === deletingProjectId.value) continue
    const wasDirty = pendingEdits.value.has(project.id)
    if (!writeStatus(project.id)) {
      if (wasDirty) void persistDraft(project.id, false).catch(() => {})
      continue
    }
    locallySaved.value.delete(project.id)
    void persistDraft(project.id, true).catch(() => {
      locallySaved.value.delete(project.id)
      saveErrors.value[project.id] = '本机草稿未写入，请保持此页面打开'
    })
    clearTimeout(saveTimers.get(project.id))
    saveTimers.set(project.id, setTimeout(() => { void saveProjectNow(project.id).catch(() => {}) }, 500))
  }
}, { deep: true })
async function reconnect() {
  const account = await readSiteAccount()
  canSend = (account?.username ?? '') === draftAccount
  if (!canSend) return
  for (const id of pendingEdits.value) void saveProjectNow(id).catch(() => {})
}
async function persistBeforeNavigation(id = currentProject.value.id) {
  if (!writeStatus(id)) return
  try { await keepDraft(id) }
  catch { await saveProjectNow(id); return }
  void saveProjectNow(id).catch(() => {})
}

function textRequestOptions(project = currentProject.value) {
  const selected = textOptions.value.find(
    (item) => item.key === project.settings?.textSelection,
  )
  return {
    configId: selected?.configId,
    model: selected?.model,
    systemPrompt: project.settings?.systemPrompt || defaultAgentPrompt,
    combatEnabled: project.settings?.combatEnabled !== false,
  }
}
const revisionRequester = computed(() => {
  const projectId = currentProject.value.id,
    episodeId = currentEpisode.value.id
  return async (card: PreviewCard, instruction: string) => {
    const owner = projects.value.find((item) => item.id === projectId)
    if (!owner || !episodeLock.owns(projectId, episodeId)) throw new Error('请重新进入分集后再试')
    const run = beginTextRun(projectId, episodeId, 'revisions', card.id)
    if (!run) throw new Error('本集已有编排任务，请稍后重试')
    const options = textRequestOptions(owner)
    try {
      const completed = await submitTextRun(run, { ...options, cardId: card.id, instruction, sourcePrompt: card.prompt })
      return completed.result as ScriptVideoRevisionCandidate
    } finally {
      finishTextRun(run)
    }
  }
})
watch(selectedProjectId, (value) => {
  episodeLock.watchProject(value)
  try {
    if (value) localStorage.setItem('script-video-last-project', value)
    else localStorage.removeItem('script-video-last-project')
  } catch { /* Project selection still works with storage disabled. */ }
})
function keepViewPosition(withScroll = false) {
  if (restoringView || loadingProjects.value || selectingEpisode.value || !selectedProjectId.value ||
      selectedEpisodeId.value && !episodeOpen.value) return
  const position: ScriptVideoViewPosition = { projectId: selectedProjectId.value }
  if (episodeOpen.value) {
    Object.assign(position, { episodeId: selectedEpisodeId.value, stage: stage.value,
      cardId: selectedCard.value?.id, tab: editorTab.value })
    if (withScroll && workspace.value) position.scroll = captureScriptVideoScroll(workspace.value)
    else if (lastViewPosition?.projectId === position.projectId && lastViewPosition.episodeId === position.episodeId &&
        lastViewPosition.stage === position.stage && lastViewPosition.cardId === position.cardId && lastViewPosition.tab === position.tab) {
      position.scroll = lastViewPosition.scroll
    }
  }
  lastViewPosition = position
  writeScriptVideoViewPosition(position)
}
function saveViewOnPageHide() { keepViewPosition(true) }
watch([selectedProjectId, selectedEpisodeId, selectingEpisode, stage, () => selectedCard.value?.id, editorTab],
  () => keepViewPosition(), { flush: 'post' })
onMounted(async () => {
  lastViewPosition = readScriptVideoViewPosition()
  window.addEventListener('pagehide', saveViewOnPageHide, true)
  window.addEventListener('online', reconnect)
  try {
    const [identity, session, directory] = await Promise.all([
      readSiteAccount(), scriptVideoSession(), scriptVideoRequest<Pick<PreviewProject, 'id' | 'title' | 'revision'>[]>('/projects?view=summary')
        .then(rows => ({ rows, error: '', denied: false })).catch(error => ({
          rows: [] as Pick<PreviewProject, 'id' | 'title' | 'revision'>[], error: error.message || '项目目录加载失败',
          denied: error instanceof ScriptVideoRequestError && [401, 403].includes(error.status),
        })),
      loadStylePresets(),
    ])
    if (!alive) return
    if (directory.denied) throw new Error(directory.error)
    tabId = session ?? previewId('tab')
    draftAccount = identity?.username ?? ''
    try {
      if (directory.error && !identity) {
        draftAccount = sessionStorage.getItem('script-video-draft-account') || ''
        canSend = false
      } else sessionStorage.setItem('script-video-draft-account', draftAccount)
    } catch { /* Tab identity is still isolated when storage is blocked. */ }
    const drafts = await readScriptVideoDrafts<PreviewProject>(draftAccount, tabId).catch(() => [])
    if (!alive) return
    syncing.value = true
    for (const draft of drafts) {
      if (!directory.error && !directory.rows.some(row => row.id === draft.projectId)) continue
      serverSnapshots.set(draft.projectId, draft.base)
      writers.set(draft.projectId, { clientId: draft.clientId, sequence: draft.sequence, sending: draft.sending })
      projects.value.push(draft.local)
      locallySaved.value.add(draft.projectId)
      pendingEdits.value.add(draft.projectId)
    }
    for (const row of directory.rows) {
      if (!localProject(row.id)) acceptProject({ ...row, episodeId: '', assets: [], episodes: [] })
    }
    if (!projects.value.length && directory.error) throw new Error(directory.error)
    let remembered = lastViewPosition?.projectId
    if (!remembered) {
      try { remembered = localStorage.getItem('script-video-last-project') || undefined } catch { /* Use the first project. */ }
    }
    selectedProjectId.value = projects.value.find(project => project.id === remembered)?.id || projects.value[0]?.id || ''
    await nextTick()
    syncing.value = false
    loadingProjects.value = false
    const project = currentProject.value
    if (project.id !== 'loading' && !directory.error) {
      const requestedEpisode = lastViewPosition?.projectId === project.id ? lastViewPosition.episodeId : undefined
      try { await refreshProject(project.id, requestedEpisode) }
      catch (error) {
        if (error instanceof ScriptVideoRequestError && error.status === 404 && requestedEpisode) await refreshProject(project.id)
        else if (!project.episodes.length) throw error
      }
    }
    let position = lastViewPosition?.projectId === project.id ? lastViewPosition : undefined
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    // Apply the old saved selection on the first reload after an upgrade.
    if (!lastViewPosition && remembered === project.id && navigation?.type === 'reload') {
      position = { projectId: project.id, episodeId: project.episodeId }
    }
    if (position?.episodeId && project.episodes.some(episode => episode.id === position.episodeId)) {
      await selectEpisode(position.episodeId, position, true)
      if (episodeOpen.value) {
        const episodeId = position.episodeId
        const focusCard = selectedCard.value?.id
        const focusStage = stage.value
        requestAnimationFrame(() => {
          if (alive && workspace.value && selectedProjectId.value === project.id && selectedEpisodeId.value === episodeId &&
              selectedCard.value?.id === focusCard && stage.value === focusStage && position?.tab === editorTab.value &&
              (!position.stage || position.stage === focusStage) && (focusStage !== 'production' || position.cardId === focusCard)) {
            restoreScriptVideoScroll(workspace.value, position.scroll)
          }
        })
      }
    }
    agentPrompt.value = currentProject.value.settings?.systemPrompt || defaultAgentPrompt
    if (canSend && !directory.error) for (const id of pendingEdits.value) void saveProjectNow(id).catch(() => {})
  } catch (error) {
    syncing.value = false
    loadError.value = error instanceof Error ? error.message : '项目加载失败'
    loadingProjects.value = false
  } finally {
    restoringView = false
    if (alive && episodeOpen.value) keepViewPosition()
  }
  try {
    const configs = await aiConfigAPI.list('text')
    textOptions.value = (Array.isArray(configs) ? configs : [])
      .filter((row: any) => row.is_active)
      .flatMap((row: any) => {
        let models: any = row.model
        try {
          models = JSON.parse(models)
        } catch {}
        return (Array.isArray(models) ? models : [models])
          .filter((model: any) => typeof model === 'string' && model)
          .map((model: string) => ({
            key: `${row.id}:${model}`,
            model,
            provider: row.provider,
            configId: Number(row.id),
            configName: row.name || row.provider,
          }))
      })
  } catch (error) {
    toast.error('文字模型配置读取失败，请检查设置')
  }
})
function coverAsset(card: PreviewCard) {
  return (
    assets.value.find(
      (a) => card.assetIds.includes(a.id) && a.kind === 'scene',
    ) || assets.value.find((a) => a.kind !== 'audio' && card.assetIds.includes(a.id))
  )
}
function updateCard(card: PreviewCard, targetEpisode?: PreviewEpisode) {
  const episode = targetEpisode ?? currentEpisode.value
  const index = episode.cards.findIndex((c) => c.id === card.id)
  if (index < 0) return
  if (!targetEpisode && stage.value === 'outline') episode.outlineConfirmed = false
  const { referenceFrameSettings: _snapshotSettings, ...content } = card
  const settings = episode.cards[index].referenceFrameSettings
  episode.cards[index] = {
    ...content,
    ...(settings && { referenceFrameSettings: settings }),
    status: 'draft',
    version: episode.cards[index].version + 1,
  }
}
function openBindingDialog(cardId: string) {
  selectedCardId.value = cardId
  bindingSearch.value = ''
  dialog.value = 'bindings'
}
function characterSummaryMatcher(characters: PreviewAsset[], keyFor: (asset: PreviewAsset) => string) {
  const aliases = new Map<string, string | null>()
  for (const asset of characters) {
    const base = scriptVideoCharacterBase(asset)
    if (!base) continue
    const key = keyFor(asset)
    const names = [scriptVideoCharacterName(asset), '@' + asset.name]
    if (isScriptVideoChibiAppearance(asset)) names.push('Q版' + base, 'Q版小' + base, '3DQ版' + base, '3DQ版小' + base)
    else names.push(base)
    // 剧本通常用群体所在目录的完整称谓，如“阿勒图雅亲卫”。
    if (base.endsWith('/群体')) names.push(base.slice(0, -'/群体'.length))
    for (const name of names.filter(Boolean)) {
      const previous = aliases.get(name)
      aliases.set(name, previous === undefined || previous === key ? key : null)
    }
  }
  const pattern = [...aliases.keys()]
    .sort((left, right) => right.length - left.length)
    .map(name => name.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&'))
    .join('|')
  const matcher = pattern ? new RegExp(pattern, 'gu') : undefined
  return (text: string) => new Set(
    (matcher ? text.match(matcher) || [] : [])
      .map(name => aliases.get(name))
      .filter((name): name is string => Boolean(name)),
  )
}
function chooseBinding(asset: PreviewAsset) {
  const card = selectedCard.value
  if (!card) return
  const remove = card.assetIds.includes(asset.id)
  const base = asset.kind === 'character' ? scriptVideoCharacterBase(asset) : ''
  const characters = assets.value.filter(item => item.kind === 'character')
  const keyFor = (item: PreviewAsset) => scriptVideoCharacterBase(item) + (isScriptVideoChibiAppearance(item) ? '/Q版' : '/真人')
  const presentation = base ? keyFor(asset) : ''
  const sameAppearance = characters.filter(item => presentation && keyFor(item) === presentation)
  const sameAppearanceIds = new Set(sameAppearance.map(item => item.id))
  const sameAppearanceNames = new Set(sameAppearance.map(item => item.name))
  const mentionedAppearances = characterSummaryMatcher(characters, keyFor)
  cards.value = cards.value.map((item) => {
    if (item.id !== card.id) {
      if (!base || !bindCharacterToEpisode.value) return item
      if (remove && !item.assetIds.includes(asset.id)) return item
      if (!item.assetIds.some(id => sameAppearanceIds.has(id)) && !mentionedAppearances(item.summary).has(presentation)) return item
    }
    const ids = item.assetIds.filter(id => remove ? id !== asset.id : !sameAppearanceIds.has(id))
    if (!remove) {
      const replaced = item.assetIds.findIndex(id => sameAppearanceIds.has(id))
      ids.splice(replaced < 0 ? ids.length : replaced, 0, asset.id)
    }
    let summary = item.summary
    if (base) {
      const lines = summary.split('\n').filter(line => {
        if (line.startsWith('【已确认人物造型】')) {
          const name = /绑定 @(.+?)。?$/u.exec(line)?.[1]
          return !name || !sameAppearanceNames.has(name)
        }
        if (!remove && line.startsWith('【待确认造型')) {
          const pending = mentionedAppearances(line)
          return pending.size !== 1 || !pending.has(presentation)
        }
        return true
      })
      summary = lines.join('\n')
      if (!remove) summary += (summary && !summary.endsWith('\n') ? '\n' : '') + `【已确认人物造型】${base} 绑定 @${asset.name}。`
    }
    return {
      ...item,
      assetIds: ids,
      summary,
      version: item.version + 1,
      status: 'draft' as const,
    }
  })
  currentEpisode.value.outlineConfirmed = false
}
function summarizeAIError(message: string) {
  const text = message.trim()
  if (/请确定[^\n：:]+的造型[：:]/u.test(text)) return '上次 AI 编排要求确认人物造型。'
  if (/台词无法在\s*\d+\s*秒内按自然语速完整说完/u.test(text) && /请确认处理方式/u.test(text)) {
    return '上次分镜因台词超时暂停。再次生成时会自动调整分段。'
  }
  if (/(?:原稿预计|原文预计|预计时长)\s*[：:]?\s*\d+(?:\.\d+)?\s*秒/u.test(text) &&
      /请确认取舍[：:]\s*(?:[AＡ][.．、]\s*)?(?:按|采用|压到)\s*(?:约)?\s*\d+\s*秒/u.test(text)) {
    return '上次编排因时长确认暂停，可重新生成。'
  }
  const parts = text.split(/[；\n]/u).map(part => part.trim()).filter(Boolean)
  const reason = parts.length > 1 && parts[0].length < 20 && /失败|不完整|未完成|未通过/u.test(parts[0])
    ? parts[1] : parts[0]
  const first = (reason || 'AI 编排未完成').replace(/\s+/gu, ' ')
  return first.length > 60 ? first.slice(0, 59) + '…' : first
}
function storyboardProgressText(state?: AIProgress) {
  if (!state) return ''
  const { phase, completed, total, batchSize } = state.progress
  const repairAttempts = batchSize
    ? state.progress.segmentRepairAttempts ?? state.progress.repairAttempts ?? 0
    : state.progress.repairAttempts ?? 0
  if (state.status === 'failed') {
    if (state.code === 'STORYBOARD_REPAIRS_EXHAUSTED') return batchSize === 1
      ? `当前段自动修复已达 3 次，已保存 ${completed}/${total} 段。点击继续可重试当前段。`
      : '自动修复已达 3 次，任务已停止。请查看错误详情。'
    if (state.code === 'STALE') return ''
    if (phase === 'repairing') return `本轮修复已中断，已用 ${repairAttempts}/3 次。草稿已保存。`
    if (!completed) return ''
    return `已保存 ${completed}/${total} 段。点击继续可使用本次草稿。`
  }
  if (state.status === 'completed' || state.status === 'canceled' || !total) return ''
  if (phase === 'repairing') return `正在${batchSize === 1 ? '修复当前段' : '自动修复'}（第 ${repairAttempts}/3 次），整集共 ${total} 段`
  if (phase === 'validating' && batchSize && completed + batchSize < total)
    return `正在校验当前批次，已保存 ${completed}/${total} 段`
  if (phase === 'validating') return `正在校验整集，共 ${total} 段${repairAttempts ? `，${batchSize === 1 ? '当前段' : '已自动'}修复 ${repairAttempts}/3 次` : ''}`
  if (completed === total) return `${total} 段已生成，等待整集校验…`
  return `正在${batchSize ? '分批' : '整集'}生成，已保存 ${completed}/${total} 段`
}
function storyboardActionFor(state?: AIProgress) {
  if (state?.status === 'failed' && state.code !== 'STALE') {
    if (state.code === 'STORYBOARD_REPAIRS_EXHAUSTED') {
      if (state.progress.batchSize === 1 && state.jobId) {
        return { label: '继续当前段', body: { resumeFromJobId: state.jobId, retryCurrentSegment: true } }
      }
      return { label: '重新生成整集', body: { restartAfterRepairs: true } }
    }
    if (state.jobId && (state.progress.completed || state.progress.repairAttempts || state.progress.segmentRepairAttempts)) {
      const partial = state.progress.phase === 'generating' && state.progress.completed < state.progress.total
      return { label: partial ? '续写剩余片段' : '继续处理已保存的分镜', body: { resumeFromJobId: state.jobId } }
    }
  }
  return { label: '确认大纲，生成分镜与提示词', body: {} }
}
function showProject(id: string) {
  selectedEpisodeId.value = ''
  selectedProjectId.value = id
  restoredStage.value = undefined
  editorTab.value = 'prompt'
  agentPrompt.value =
    currentProject.value.settings?.systemPrompt || defaultAgentPrompt
  episodeAccessNotice.value = ''
  dialog.value = null
}
async function selectProject(id: string) {
  if (episodeNavigationBusy.value || id === selectedProjectId.value ||
      !projects.value.some((project) => project.id === id)) return
  selectingEpisode.value = true
  try {
    await persistBeforeNavigation()
    episodeLock.leave()
    showProject(id)
    await refreshProject(id)
    agentPrompt.value = currentProject.value.settings?.systemPrompt || defaultAgentPrompt
  } catch (error: any) {
    toast.error(error.message)
  } finally {
    selectingEpisode.value = false
  }
}
async function deleteProject(projectId: string) {
  if (episodeNavigationBusy.value) return
  const project = projects.value.find((item) => item.id === projectId)
  if (!project) return
  if (project.episodes.some(episode => episode.busy || textRuns.value[`${projectId}/${episode.id}`])) {
    toast.info('项目仍有任务正在运行，请完成后再删除')
    return
  }

  deletingProjectId.value = projectId
  const timer = saveTimers.get(projectId)
  if (timer) clearTimeout(timer)
  saveTimers.delete(projectId)
  try {
    await saveQueues.get(projectId)?.catch(() => {})
    await scriptVideoRequest(`/projects/${projectId}`, 'DELETE').catch((error) => {
      if (!(error instanceof ScriptVideoRequestError && error.status === 404)) throw error
    })
    const index = projects.value.findIndex((item) => item.id === projectId)
    projects.value = projects.value.filter((item) => item.id !== projectId)
    saveQueues.delete(projectId)
    writers.delete(projectId)
    await diskQueues.get(projectId)?.catch(() => {})
    await writeScriptVideoDraft(draftAccount, tabId, projectId).catch(() => {})
    serverSnapshots.delete(projectId)
    sharedLoaded.delete(projectId)
    diskQueues.delete(projectId)
    clearTimeout(timersForRetry.get(projectId))
    timersForRetry.delete(projectId)
    pendingEdits.value.delete(projectId)
    locallySaved.value.delete(projectId)
    delete saveErrors.value[projectId]
    project.assets.forEach(releaseAssetImage)
    if (selectedProjectId.value === projectId) {
      await episodeLock.leave()
      const next = projects.value[index] || projects.value.at(-1)
      showProject(next?.id || '')
      if (next) {
        await refreshProject(next.id).catch(() => toast.error('下一项目的目录读取失败，请重新选择项目'))
        agentPrompt.value = currentProject.value.settings?.systemPrompt || defaultAgentPrompt
      }
    }
    toast.success(`已删除《${project.title}》`)
  } catch (error: any) {
    toast.error(error.message || '项目删除失败，请重试')
  } finally {
    deletingProjectId.value = ''
    if (projects.value.some((item) => item.id === projectId)) {
      void saveProjectNow(projectId).catch(() => {})
    }
  }
}
async function selectEpisode(id: string, position?: ScriptVideoViewPosition, alreadyFetched = false) {
  const projectId = currentProject.value.id
  if (episodeNavigationBusy.value || episodeLock.owns(projectId, id) ||
      !currentProject.value.episodes.some((episode) => episode.id === id)) return
  selectingEpisode.value = true
  episodeAccessNotice.value = ''
  try {
    await persistBeforeNavigation(projectId)
    const cached = localProject(projectId)?.episodes.find(ep => ep.id === id)
    if (!cached || cached._loaded === false) {
      await refreshProject(projectId, id, undefined, !sharedLoaded.has(projectId))
    } else if (!alreadyFetched && navigator.onLine && serverSnapshots.get(projectId)?.episodes.some(ep => ep.id === id)) {
      void refreshProject(projectId, id, requestController.signal, !sharedLoaded.has(projectId)).catch(() => {})
    }
    selectedEpisodeId.value = id
    episodeLock.enter(projectId, id)
    restoredStage.value = restoreScriptVideoStage(position?.stage, {
      confirmed: currentEpisode.value.confirmed, outlineConfirmed: currentEpisode.value.outlineConfirmed,
      cardCount: cards.value.length, hasStoryboard: hasStoryboard.value,
    })
    const cardId = position?.cardId
    if (cardId && cards.value.some(card => card.id === cardId)) {
      selectedCardId.value = cardId
      editorTab.value = position?.tab ?? 'prompt'
    } else editorTab.value = 'prompt'
    dialog.value = null
    void restoreEpisodeAIJobs(projectId, id)
  } catch (error: any) {
    if (!selectedEpisodeId.value) episodeLock.leave()
    episodeAccessNotice.value = error.message || '无法进入分集，请重试。'
    toast.error(episodeAccessNotice.value)
  } finally {
    selectingEpisode.value = false
  }
}
async function leaveEpisode() {
  if (episodeNavigationBusy.value) return
  selectingEpisode.value = true
  try {
    await persistBeforeNavigation()
    episodeLock.leave()
    selectedEpisodeId.value = ''
    restoredStage.value = undefined
    editorTab.value = 'prompt'
    episodeAccessNotice.value = ''
    dialog.value = null
  } catch (error: any) {
    toast.error(error.message)
  } finally {
    selectingEpisode.value = false
  }
}
function navigateStage(next: Stage) {
  if (
    next !== 'materials' &&
    (!currentEpisode.value.confirmed || !cards.value.length)
  ) {
    stage.value = 'materials'
    toast.info('请先确认本集剧本并生成分段大纲')
    return
  }
  if (next === 'production' && !currentEpisode.value.outlineConfirmed) {
    stage.value = 'outline'
    toast.info('请先确认本集分段大纲')
    return
  }
  if (next === 'production' && !hasStoryboard.value) {
    stage.value = 'outline'
    toast.info('整集分镜生成并通过校验后即可进入视频制作')
    return
  }
  stage.value = next
}
function editAsset(id: string) {
  editingAssetId.value = id
  assetManageSearch.value = ''
  assetManageKind.value = assets.value.find(asset => asset.id === id)?.kind || 'all'
  dialog.value = 'assets'
}
function requireSharedProjectEdit() {
  if (canEditSharedProject.value) return true
  toast.info('请先进入分集。')
  return false
}
async function savePreviewConfig() {
  if (!requireSharedProjectEdit()) return
  currentProject.value.settings = {
    ...currentProject.value.settings,
    systemPrompt: agentPrompt.value,
    combatEnabled: combatEnabled.value,
  }
  try {
    await saveProjectNow()
    dialog.value = null
    toast.success('编排设置已保存')
  } catch (error: any) {
    toast.error(error.message)
  }
}
function openProjectDialog() {
  newProjectTitle.value = ''
  newProjectStyle.value = { ...stylePresets.value.find(preset => preset.id === 'cool')! }
  dialog.value = 'project'
  void loadStylePresets()
}
function openStyleDialog() {
  if (!requireSharedProjectEdit()) return
  styleProjectId.value = currentProject.value.id
  projectStyleDraft.value = { ...(currentProject.value.settings?.stylePreset || stylePresets.value.find(preset => preset.id === 'cool')!) }
  projectStyleBaseline = { ...projectStyleDraft.value }
  dialog.value = 'style'
  void loadStylePresets()
}
async function saveProjectStyle() {
  if (!validProjectStyle.value || savingStyle.value || !requireSharedProjectEdit()) return
  const project = projects.value.find(item => item.id === styleProjectId.value)
  if (!project) return
  savingStyle.value = true
  const style = { ...projectStyleDraft.value }
  project.settings = { ...project.settings, stylePreset: style }
  try {
    await saveProjectNow(project.id)
    dialog.value = null
    toast.success('项目风格已保存，视频提示词前缀已同步')
  } catch (error: any) {
    toast.error(error.message || '风格保存失败，请重试')
  } finally {
    savingStyle.value = false
  }
}
async function createProject() {
  if (!newProjectTitle.value.trim() || !validNewProjectStyle.value || creatingProject.value) return
  creatingProject.value = true
  try {
    const project = await scriptVideoRequest<PreviewProject>(
      '/projects',
      'POST',
      { title: newProjectTitle.value.trim(), stylePreset: { ...newProjectStyle.value } },
    )
    acceptProject(materialize(project, project.episodes))
    await selectProject(project.id)
    if (selectedProjectId.value === project.id) await selectEpisode(project.episodeId)
    toast.success('项目已创建，可以导入分集剧本和资产包')
  } catch (error: any) {
    toast.error(error.message)
  } finally {
    creatingProject.value = false
  }
}
async function addEpisode() {
  if (episodeNavigationBusy.value) return
  const project = currentProject.value
  const number =
    Math.max(
      ...project.episodes.map((episode) => episode.number),
      0,
    ) + 1
  const episode = makeEpisode('未命名分集', number)
  project.episodes.push(episode)
  await selectEpisode(episode.id)
}
function setVideoModel(selection: {
  key: string
  label: string
  minDuration: number
  maxDuration: number
  wholeSeconds: boolean
  maxAudioReferences: number | null
  maxAudioDuration: number
  configId?: number
  model?: string
  provider?: string
}) {
  if (selection.key !== videoModel.value) return
  const previousModel = currentEpisode.value.modelName
  const previousConfig = currentEpisode.value.modelConfigId
  const changedModel = !!previousModel && (previousModel !== selection.model ||
    (previousConfig != null && previousConfig !== selection.configId))
  currentEpisode.value.modelConfigId = selection.configId
  currentEpisode.value.modelProvider = selection.provider
  currentEpisode.value.modelName = selection.model
  currentEpisode.value.modelLabel = selection.label
  currentEpisode.value.modelMinDuration = selection.minDuration
  currentEpisode.value.modelMaxDuration = selection.maxDuration
  currentEpisode.value.modelWholeSeconds = selection.wholeSeconds
  currentEpisode.value.modelMaxAudioReferences = selection.maxAudioReferences
  currentEpisode.value.modelMaxAudioDuration = selection.maxAudioDuration
  if (selection.key && (changedModel || !modelResolutions.value.includes(resolution.value))) {
    resolution.value = modelResolutions.value.includes('480P') ? '480P' : modelResolutions.value[0] || '480P'
  }
  if (selection.key && !modelAspectRatios.value.includes(aspectRatio.value)) {
    aspectRatio.value = modelAspectRatios.value.includes('16:9') ? '16:9' : modelAspectRatios.value[0] || '16:9'
  }
}
function beginTextRun(projectId: string, episodeId: string, action: TextAction, cardId?: string, jobId?: string) {
  const key = `${projectId}/${episodeId}`
  if (textRuns.value[key]) return undefined
  const run = reactive<TextRun>({ projectId, episodeId, action, cardId, jobId, cancelRequested: false, controller: new AbortController() })
  textRuns.value[key] = run
  delete aiErrors.value[episodeId]
  delete aiProgress.value[key]
  return run
}
function finishTextRun(run: TextRun) {
  const key = `${run.projectId}/${run.episodeId}`
  if (textRuns.value[key] === run) delete textRuns.value[key]
}
async function cancelTextGeneration() {
  const run = currentTextRun.value
  if (!run || run.cancelRequested) return
  run.cancelRequested = true
  await cancelReservedTextRun(run)
}
async function cancelReservedTextRun(run: TextRun) {
  if (!run.jobId) return
  try {
    const job = await scriptVideoRequest<ScriptVideoClientJob>(
      `/projects/${run.projectId}/jobs/${run.jobId}/cancel`,
      'POST',
    )
    if (job.status === 'canceled') {
      run.controller.abort()
      if (alive) toast.info('生成已取消，现有内容已保留')
    } else {
      run.cancelRequested = false
    }
  } catch (error) {
    run.cancelRequested = false
    if (alive) toast.error(error instanceof Error ? error.message : '取消生成失败，请重试')
  }
}
async function submitTextRun(run: TextRun, body: unknown) {
  try {
    await saveProjectNow(run.projectId)
  } catch (error) {
    if (!run.cancelRequested) throw error
  }
  if (run.cancelRequested) {
    if (alive) toast.info('生成已取消，现有内容已保留')
    throw new DOMException('生成已取消', 'AbortError')
  }
  requestController.signal.throwIfAborted()
  // Keep the reservation request open to obtain its job ID if cancellation is requested in flight.
  const job = await scriptVideoRequest<ScriptVideoClientJob>(
    `/projects/${run.projectId}/episodes/${run.episodeId}/${run.action}`,
    'POST',
    body,
  )
  run.jobId = job.id
  if (run.cancelRequested) await cancelReservedTextRun(run)
  return monitorTextRun(run, job)
}
async function monitorTextRun(run: TextRun, job: ScriptVideoClientJob) {
  const signal = AbortSignal.any([requestController.signal, run.controller.signal])
  return monitorAIJob(run.projectId, run.episodeId, job, signal)
}
async function monitorAIJob(projectId: string, episodeId: string, job: ScriptVideoClientJob, signal = requestController.signal) {
  const key = `${projectId}/${episodeId}`
  const update = (progress: ScriptVideoJobProgress, status: ScriptVideoClientJob['status'], current: ScriptVideoClientJob) => {
    aiProgress.value[key] = {status, progress, code: current.code, jobId: current.id}
  }
  if (job.progress) update(job.progress, job.status, job)
  try {
    const completed = await waitScriptVideoJob(projectId, job.id, signal, update)
    if (job.action === 'review') {
      episodeReviews.value[key] = { ...completed.result, updatedAt: completed.updatedAt }
    } else if (job.action !== 'revisions') {
      await refreshProject(projectId, episodeId)
    }
    return completed
  } finally {
    if (aiProgress.value[key]?.jobId === job.id && aiProgress.value[key]?.status !== 'failed') {
      delete aiProgress.value[key]
    }
  }
}
async function restoreEpisodeAIJobs(projectId: string, episodeId: string) {
  let jobs: ScriptVideoClientJob[]
  try {
    jobs = await scriptVideoRequest<ScriptVideoClientJob[]>(
      `/projects/${projectId}/jobs?episodeId=${encodeURIComponent(episodeId)}&view=restore`,
      'GET', undefined, requestController.signal,
    )
  } catch {
    return
  }
  const episode = videoEpisode(projectId, episodeId)
  if (!episode || !episodeLock.owns(projectId, episodeId)) return

  const key = `${projectId}/${episodeId}`
  const review = jobs.findLast(job => job.action === 'review' && job.status === 'completed')
  if (review?.result) episodeReviews.value[key] = { ...review.result, updatedAt: review.updatedAt }
  const last = jobs.findLast(job => job.action !== 'video')
  if (textRuns.value[key]) return
  if (last?.status === 'failed' && last.code !== 'ASSET_VARIANT_REQUIRED') {
    aiErrors.value[episodeId] = scriptVideoJobError(last)
    if (last.progress) aiProgress.value[key] = { status: last.status, progress: last.progress, code: last.code, jobId: last.id }
  }
  const active = jobs.findLast(job => job.action && job.action !== 'video' &&
    (job.status === 'queued' || job.status === 'running'))
  if (episode.busy || !active?.action || active.action === 'video') return
  const run = beginTextRun(projectId, episodeId, active.action, active.cardId, active.id)
  if (!run) return
  try {
    const completed = await monitorTextRun(run, active)
    if (run.action === 'revisions') {
      const result = completed.result as ScriptVideoRevisionCandidate | undefined
      if (result?.card) restoredRevisions.value[`${key}/${result.card.id}`] = result
    }
  } catch (error: any) {
    if (alive && error.name !== 'AbortError') {
      aiErrors.value[episodeId] = error.message || 'AI 编排未完成'
      toast.error(summarizeAIError(aiErrors.value[episodeId]))
    }
  } finally {
    finishTextRun(run)
  }
}
async function runAI(action: 'outline' | 'storyboard' | 'review') {
  const project = currentProject.value,
    episode = currentEpisode.value
  const options = textRequestOptions(project)
  const resume = action === 'storyboard' ? storyboardAction.value.body : {}
  if (busy.value || !episode.script.trim()) return
  const run = beginTextRun(project.id, episode.id, action)
  if (!run) return
  if (action === 'outline') {
    episode.confirmedScript = episode.script
    episode.confirmed = true
  } else if (action === 'storyboard') episode.outlineConfirmed = true
  try {
    const completed = await submitTextRun(run, { ...options, ...resume })
    const timing = completed?.result?.timing
    const message = {
      outline: '分段大纲已生成',
      review: '的 AI 复核已完成',
      storyboard: timing
        ? `分镜已生成，已自动调整为 ${timing.segments} 段，共 ${timing.seconds} 秒`
        : '分镜与视频提示词已生成并完成自动检查',
    }
    toast.success(`第 ${episode.number} 集${message[action]}`)
  } catch (error: any) {
    if (alive && error.name !== 'AbortError') {
      aiErrors.value[episode.id] = error.message || 'AI 生成失败，原版本已保留'
      toast.error(summarizeAIError(aiErrors.value[episode.id]))
    }
  } finally {
    finishTextRun(run)
  }
}
async function makeOutline() {
  if (outlineButtonDisabled.value) return
  if (!assets.value.length) {
    toast.info('请先生成并导入项目资产')
    return
  }
  await runAI('outline')
}
function jumpToOutlineCard(cardId: string) {
  const card = document.getElementById(`outline-card-${cardId}`)
  card?.focus({ preventScroll: true })
  card?.scrollIntoView({ block: 'start' })
}
async function toggleOutlineEdit(cardId: string) {
  editingOutlineCardId.value = editingOutlineCardId.value === cardId ? '' : cardId
  if (editingOutlineCardId.value) {
    await nextTick()
    document.getElementById(`outline-summary-${cardId}`)?.focus()
  }
}
async function confirmOutline() {
  const episode = currentEpisode.value
  if (episode.outlineDurationPolicy === '30-except-tail-v1') {
    const issues = getScriptVideoOutlineDurationIssues(episode.cards)
    if (issues.length) {
      toast.error(issues.map(issue => issue.message).join('；'))
      return
    }
  }
  await runAI('storyboard')
}
function resizeCard(card: PreviewCard, input: number) {
  const duration = Math.max(
      2,
      Math.min(30, Number.isFinite(input) ? input : 30),
    ),
    old = card.shots.reduce((sum, shot) => sum + shot.duration, 0)
  if (!card.shots.length) {
    updateCard({ ...card, duration })
    return
  }
  let elapsed = 0
  const shots = card.shots.map((shot, index) => {
    const seconds =
      index === card.shots.length - 1
        ? Number((duration - elapsed).toFixed(2))
        : Number(((shot.duration / old) * duration).toFixed(2))
    elapsed += seconds
    return { ...shot, duration: seconds }
  })
  const next = { ...card, duration, shots }
  updateCard({ ...next, promptNeedsSync: !card.manuallyAdded })
}
function moveCard(index: number, direction: number) {
  if (stage.value === 'outline') currentEpisode.value.outlineConfirmed = false
  const next = index + direction
  if (next < 0 || next >= cards.value.length) return
  ;[cards.value[index], cards.value[next]] = [
    cards.value[next],
    cards.value[index],
  ]
}
function removeCard(id: string) {
  if (stage.value === 'outline') currentEpisode.value.outlineConfirmed = false
  if (editingOutlineCardId.value === id) editingOutlineCardId.value = ''
  tasks.value = tasks.value.filter((task) => task.cardId !== id)
  cards.value = cards.value.filter((card) => card.id !== id)
  if (selectedCardId.value === id)
    selectedCardId.value = cards.value[0]?.id || ''
}
function addCard() {
  if (stage.value === 'outline') currentEpisode.value.outlineConfirmed = false
  const id = previewId('card')
  const manuallyAdded = stage.value === 'production'
  const card: PreviewCard = {
    id,
    title: '新的片段',
    duration: 5,
    summary: '',
    assetIds: assets.value
      .filter((a) => a.kind === 'scene')
      .slice(0, 1)
      .map((a) => a.id),
    shots: [
      {
        id: `${id}-shot`,
        duration: 5,
        camera: '',
        action: '',
        dialogue: '',
      },
    ],
    prompt: '',
    combat: false,
    status: 'draft',
    version: 1,
    ...(manuallyAdded && { manuallyAdded: true as const }),
  }
  cards.value.push(card)
  selectedCardId.value = id
  if (stage.value === 'outline') void toggleOutlineEdit(id)
  if (manuallyAdded) editorTab.value = 'prompt'
}
function taskParts(card: PreviewCard) {
  return [card.duration]
}
const processingSegmentIds = computed(() => new Set(tasks.value.filter(task => task.status === 'processing').map(task => task.cardId)))
function segmentDisplayStatus(card: PreviewCard) {
  if (queuedCardIds.value.includes(card.id)) return 'queued'
  if (activeCardIds.value.includes(card.id) || processingSegmentIds.value.has(card.id)) return 'generating'
  const pending = activeVideoRun.value?.cardStatuses.get(card.id)
  if (pending) return pending
  if (segmentPlayback.value.get(card.id)?.kind === 'previous') return 'previous'
  const latest = latestTaskByCard.value.get(card.id)?.status
  if ((latest === 'failed' || latest === 'canceled') && card.status !== 'ready') return latest
  return card.status
}

const pendingSegmentDeletion = ref<{ scope: string; id: string; title: string }>()
function openSegmentDeletion(card: PreviewCard) {
  pendingSegmentDeletion.value = { scope: episodeKey.value, id: card.id, title: card.title }
  dialog.value = 'segment-delete'
}
async function confirmSegmentDeletion() {
  const pending = pendingSegmentDeletion.value
  if (!pending || pending.scope !== episodeKey.value || busy.value || videoRequestPending.value) return
  const index = cards.value.findIndex(card => card.id === pending.id)
  const card = cards.value[index]
  const project = currentProject.value
  const episode = currentEpisode.value
  if (!card || segmentDisplayStatus(card) === 'generating' || !episodeLock.owns(project.id, episode.id)) return
  const selected = selectedCardId.value === card.id
  const neighbor = cards.value[index + 1] || cards.value[index - 1]
  removeCard(card.id)
  if (episode.outlineSummaries) delete episode.outlineSummaries[card.id]
  if (selected) selectedCardId.value = neighbor?.id || ''
  dialog.value = null
  pendingSegmentDeletion.value = undefined
  await saveProjectNow(project.id).catch(error => toast.error(error.message || '删除片段失败'))
}

type SegmentExport = { id: number; status: 'processing' | 'completed' | 'failed'; videoUrl?: string; error?: string }
const selectedExportIds = ref<string[]>([])
const segmentExport = ref<SegmentExport | null>(null)
const segmentExportLoading = ref(false)
const segmentExportSubmitting = ref(false)
const segmentExportError = ref('')
const segmentExportBusy = computed(() => segmentExportSubmitting.value || segmentExport.value?.status === 'processing')
const exportableCardIds = computed(() => new Set(cards.value.filter(card =>
  segmentPlayback.value.get(card.id),
).map(card => card.id)))
const officialVideoCount = computed(() => cards.value.filter(card => officialScriptVideoUrl(card)).length)
function exportCardLabel(card: PreviewCard) {
  if (officialScriptVideoUrl(card)) return '正片'
  const playback = segmentPlayback.value.get(card.id)
  if (playback?.kind === 'previous') return '上一版成片'
  return statusLabel(segmentDisplayStatus(card))
}
const selectedExportCards = computed(() => cards.value.filter(card =>
  selectedExportIds.value.includes(card.id) && exportableCardIds.value.has(card.id),
))
const segmentExportFilename = computed(() => `第${currentEpisode.value.number}集-${currentEpisode.value.title || '成片'}.mp4`)
let segmentExportRequest = 0
watch(episodeKey, () => {
  ++segmentExportRequest
  segmentExport.value = null
  segmentExportLoading.value = false
  segmentExportSubmitting.value = false
  segmentExportError.value = ''
  pendingSegmentDeletion.value = undefined
  if (dialog.value === 'video-export' || dialog.value === 'segment-delete') dialog.value = null
})
function segmentExportPath() {
  return `/projects/${currentProject.value.id}/episodes/${currentEpisode.value.id}/video-export`
}
async function pollSegmentExport(path: string, request: number, download: boolean) {
  const id = segmentExport.value?.id
  if (!id) return
  let failures = 0
  while (alive && request === segmentExportRequest && segmentExport.value?.status === 'processing') {
    await new Promise(resolve => setTimeout(resolve, 1500))
    if (!alive || request !== segmentExportRequest) return
    try {
      const { merge: state } = await scriptVideoRequest<{ merge: SegmentExport | null }>(
        `${path}?id=${id}`, 'GET', undefined, requestController.signal,
      )
      if (!alive || request !== segmentExportRequest) return
      segmentExport.value = state
      failures = 0
      if (download && state?.status === 'completed' && state.videoUrl) {
        const anchor = document.createElement('a')
        anchor.href = state.videoUrl
        anchor.download = segmentExportFilename.value
        anchor.click()
      }
    } catch (error) {
      if (!alive || request !== segmentExportRequest) return
      if (++failures < 3) continue
      segmentExport.value = null
      segmentExportError.value = error instanceof Error ? error.message : '暂时无法获取拼接进度'
    }
  }
}
async function openSegmentExport() {
  dialog.value = 'video-export'
  if (segmentExportBusy.value || segmentExportLoading.value) return
  selectedExportIds.value = [...exportableCardIds.value]
  const path = segmentExportPath()
  const request = ++segmentExportRequest
  segmentExportLoading.value = true
  segmentExportError.value = ''
  try {
    const { merge: state } = await scriptVideoRequest<{ merge: SegmentExport | null }>(path, 'GET', undefined, requestController.signal)
    if (!alive || request !== segmentExportRequest) return
    segmentExport.value = state
    void pollSegmentExport(path, request, false)
  } catch (error) {
    if (alive && request === segmentExportRequest)
      segmentExportError.value = error instanceof Error ? error.message : '暂时无法获取导出记录'
  } finally {
    if (request === segmentExportRequest) segmentExportLoading.value = false
  }
}
async function exportSelectedSegments() {
  const cardIds = selectedExportCards.value.map(card => card.id)
  if (!cardIds.length || segmentExportBusy.value || segmentExportLoading.value) return
  const path = segmentExportPath()
  const request = ++segmentExportRequest
  segmentExportSubmitting.value = true
  segmentExport.value = null
  segmentExportError.value = ''
  try {
    await saveProjectNow(currentProject.value.id)
    if (!alive || request !== segmentExportRequest) return
    const state = await scriptVideoRequest<SegmentExport>(path, 'POST', { cardIds }, requestController.signal)
    if (!alive || request !== segmentExportRequest) return
    segmentExport.value = state
    void pollSegmentExport(path, request, true)
  } catch (error) {
    if (alive && request === segmentExportRequest)
      segmentExportError.value = error instanceof Error ? error.message : '视频导出失败'
  } finally {
    if (request === segmentExportRequest) segmentExportSubmitting.value = false
  }
}

const taskActions = ref(new Set<string>())
type FinalPromptMedia = { name: string; url: string }
type FinalPromptReference = FinalPromptMedia & { index: number; tag?: string }
type FinalPromptDelivery = {
  prompt: string
  style?: { name: string; text: string; bodyStart: number }
  images: FinalPromptReference[]
  audios: FinalPromptReference[]
  firstFrame?: FinalPromptMedia
  missingVoices: string[]
  warnings?: string[]
  source: 'preview' | 'submitted' | 'draft'
  pending?: string
}
const promptPreview = ref<{
  request: number
  title: string
  context: string
  delivery: FinalPromptDelivery | null
  pending: boolean
  error: string
  copied: boolean | null
} | null>(null)
let promptPreviewRequest = 0
type VideoGenerationRequest = { projectId: string; episodeId: string; cardIds: string[]; durations?: Record<string, number> }
type VideoSubmission = number | 'needs-approval' | undefined
const pendingVideoRetry = ref<(VideoGenerationRequest & { jobs: Map<string, string> }) | null>(null)
type VideoRun = {
  id: string
  controller: AbortController
  cardIds: string[]
  cardStatuses: Map<string, 'queued' | 'generating'>
  waitingToSubmit: Set<string>
}
const activeVideoRequests = ref(new Map<string, VideoRun>())
const activeVideoRun = computed(() => activeVideoRequests.value.get(episodeKey.value))
const cancelingVideo = ref(new Set<string>())
const videoCanceling = computed(() => cancelingVideo.value.has(episodeKey.value))
const activeTailWaits = ref(new Map<string, number>())
const videoRequestPending = computed(() => activeVideoRequests.value.has(episodeKey.value))
const videoTailWaiting = computed(() => activeTailWaits.value.has(episodeKey.value))
const latestTaskByCard = computed(
  () => indexVideoTasks(tasks.value),
)
const selectedVideoTask = computed(() => {
  const task = latestTaskByCard.value.get(selectedCardId.value)
  return task?.status === 'processing' ? task : undefined
})
const canCancelSelectedVideo = computed(() => {
  const run = activeVideoRun.value
  return !!selectedVideoTask.value || run?.cardIds.length === 1 && run.cardIds[0] === selectedCardId.value
})
async function cancelVideoGeneration(task?: Task, cardId?: string) {
  const projectId = currentProject.value.id, episodeId = currentEpisode.value.id
  const scope = `${projectId}/${episodeId}`
  const key = task?.id ?? scope
  if (cancelingVideo.value.has(key) || videoCanceling.value || !episodeLock.owns(projectId, episodeId)) return
  const run = !task ? activeVideoRequests.value.get(scope) : undefined
  cancelingVideo.value.add(key)
  if (run) {
    run.controller.abort()
    run.cardStatuses.clear()
  }
  try {
    const result = await scriptVideoRequest<{ canceled: number; upstreamUnconfirmed: number }>(
      `/projects/${projectId}/episodes/${episodeId}/video-cancel`, 'POST',
      { ...(task && { jobIds: [task.id] }), ...(cardId && { cardId }), ...(run && { requestId: run.id }) },
    )
    if (run && activeVideoRequests.value.get(scope)?.id === run.id) activeVideoRequests.value.delete(scope)
    await refreshProject(projectId, episodeId).catch(() =>
      toast.error('取消请求已处理，任务列表加载失败。刷新页面可查看最新状态。'),
    )
    if (result.upstreamUnconfirmed) toast.info('已停止站内等待。未确认服务商已取消，可能仍在生成或已计费。')
    else if (result.canceled || run) toast.info('视频生成已取消')
    else toast.info('该视频任务已结束')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '取消视频生成失败，请重试')
  } finally {
    cancelingVideo.value.delete(key)
  }
}
const latestCompletedVideoUrls = computed(() => latestScriptVideoTaskUrls(tasks.value))
const selectedVideoVersions = computed(() => selectedCard.value ? listScriptVideoVersions(selectedCard.value, tasks.value) : [])
const segmentPlayback = computed(() => new Map(cards.value.map(card =>
  [card.id, scriptVideoCardPlayback(card, latestCompletedVideoUrls.value.get(card.id))] as const,
)))
const episodePreview = ref<InstanceType<typeof ScriptVideoEpisodePreview>>()
const episodePreviewClips = computed(() => cards.value.flatMap((card, index) => {
  const playback = segmentPlayback.value.get(card.id)
  if (!playback) return []
  return [{ number: index + 1, title: card.title, url: playback.url, previous: playback.kind === 'previous' }]
}))
const promotingVideoVersion = ref('')
async function promoteVideoVersion(cardId: string, url: string) {
  if (promotingVideoVersion.value) return
  const projectId = currentProject.value.id, episodeId = currentEpisode.value.id
  promotingVideoVersion.value = url
  try {
    await saveProjectNow(projectId)
    await scriptVideoRequest(
      `/projects/${projectId}/episodes/${episodeId}/cards/${cardId}/video-version`, 'POST', { url },
    )
    await refreshProject(projectId, episodeId, requestController.signal, false)
    toast.success('已设为正片')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '设置正片失败，请重试')
  } finally {
    promotingVideoVersion.value = ''
  }
}
function openSegmentCard(card: PreviewCard, event: MouseEvent) {
  selectedCardId.value = card.id
  if (segmentPlayback.value.get(card.id) &&
      (event.detail === 0 || (event.target instanceof Element && event.target.closest('.vp-segment-play')))) {
    editorTab.value = 'preview'
  }
}
const missingVideoVoicesByCard = computed(() => {
  const context = deliveryOptions(currentProject.value, currentEpisode.value)
  return new Map(cards.value.map(card => [card.id, getScriptVideoMissingVoices(card, assets.value, context)]))
})
const videoVoiceHelp = '请检查角色绑定，在「项目资产」上传声音或允许模型配音。'
const batchVideoVoiceWarning = computed(() => {
  const segments = cards.value.flatMap((card, index) => {
    const names = missingVoicesForCard(card.id)
    return names.length ? [`第 ${index + 1} 段（${names.join('、')}）`] : []
  })
  return segments.length ? `批量生成需要补齐${segments.join('、')}的角色参考音频。${videoVoiceHelp}` : ''
})
const retryVideoVoiceWarning = computed(() => pendingVideoRetry.value ? videoVoiceWarningForRequest(pendingVideoRetry.value) : '')
const remainingVideoVoiceWarning = computed(() => {
  const request = pendingVideoRetry.value
  return request ? videoVoiceWarningForRequest({ ...request, cardIds: request.cardIds.filter(id => !request.jobs.has(id)) }) : ''
})
function indexVideoTasks(list: Task[]) {
  return new Map(list.map((task) => [task.cardId, task] as const))
}
function isVideoDeliveryRecovery(task?: Task) {
  return task?.status === 'failed' && task.code === 'DELIVERY_FAILED' && !!task.taskId
}
function missingVideoVoiceMessage(names: readonly string[]) {
  return names.length ? `缺少角色参考音频：${names.join('、')}。${videoVoiceHelp}` : ''
}
function missingVoicesForCard(cardId: string) {
  const task = latestTaskByCard.value.get(cardId)
  if (task?.status === 'processing' || isVideoDeliveryRecovery(task)) return []
  return missingVideoVoicesByCard.value.get(cardId) || []
}
function videoVoiceWarningForCard(cardId: string) {
  return missingVideoVoiceMessage(missingVoicesForCard(cardId))
}
function videoVoiceWarningForRequest(request: VideoGenerationRequest) {
  const project = projects.value.find(item => item.id === request.projectId)
  const episode = project?.episodes.find(item => item.id === request.episodeId)
  if (!project || !episode) return ''
  const taskIndex = indexVideoTasks(episode.tasks)
  const isCurrentEpisode = project.id === currentProject.value.id && episode.id === currentEpisode.value.id
  const missing = new Set<string>()
  for (const card of episode.cards) {
    if (!request.cardIds.includes(card.id)) continue
    const task = taskIndex.get(card.id)
    if (task?.status === 'processing' || isVideoDeliveryRecovery(task)) continue
    const names = isCurrentEpisode ? missingVideoVoicesByCard.value.get(card.id) || []
      : getScriptVideoMissingVoices(card, project.assets, deliveryOptions(project, episode))
    for (const name of names) missing.add(name)
  }
  return missingVideoVoiceMessage([...missing])
}
function rejectVideoRequestWithoutVoices(request: VideoGenerationRequest) {
  const warning = videoVoiceWarningForRequest(request)
  if (!warning) return false
  toast.error(warning)
  return true
}
function pendingVideoTask(episode: PreviewEpisode, card: PreviewCard) {
  return episode.tasks.filter(task => task.cardId === card.id && task.cardVersion === card.version && task.status === 'processing').at(-1)
}
function videoEpisode(projectId: string, episodeId: string) {
  return projects.value
    .find((project) => project.id === projectId)
    ?.episodes.find((item) => item.id === episodeId)
}
async function loadPreviousVideoEpisode(projectId: string, episodeId: string, signal?: AbortSignal) {
  const project = projects.value.find(item => item.id === projectId)
  const index = project?.episodes.findIndex(item => item.id === episodeId) ?? -1
  const previous = project?.episodes[index - 1]
  if (previous?._loaded === false) await refreshProject(projectId, previous.id, signal, false)
}
function videoTaskError(task: { status?: Task['status']; code?: string; error?: string }) {
  if (task.status === 'canceled') return task.error || ''
  if (task.code === 'SUBMISSION_UNKNOWN') return '上次提交结果待确认，重新生成可能重复计费。'
  if (task.code === 'SUBMISSION_UNKNOWN_ACKNOWLEDGED') return '提交结果待确认，已选择重新生成。'
  return task.error || ''
}
function retryJobs(request: VideoGenerationRequest) {
  const latest = indexVideoTasks(videoEpisode(request.projectId, request.episodeId)?.tasks || [])
  const jobs = new Map<string, string>()
  for (const cardId of request.cardIds) {
    const task = latest.get(cardId)
    if ((task?.status === 'failed' || task?.status === 'canceled') && task.code === 'SUBMISSION_UNKNOWN') jobs.set(cardId, task.id)
  }
  return jobs
}
function openVideoRetry(request: VideoGenerationRequest, jobs = retryJobs(request)) {
  if (!jobs.size) return false
  // A different workspace may be visible by the time a provider reports an
  // uncertain submission. The failed task in the source episode retains its retry action.
  if (!episodeLock.owns(request.projectId, request.episodeId)) return true
  pendingVideoRetry.value = { ...request, jobs }
  dialog.value = 'video-retry'
  return true
}
async function requestVideoGeneration(cardIds: string[]) {
  if (cardIds.some(id => activeCardIds.value.includes(id))) return
  if (!navigator.onLine) { toast.info('联网后可生成视频'); return }
  const episode = currentEpisode.value
  const request = { projectId: currentProject.value.id, episodeId: episode.id, cardIds, durations: { ...episode.videoDurations } }
  const voiceReplacement = pendingAudioEdits(request.projectId)
  if (voiceReplacement) {
    await voiceReplacement
    if (!alive || !episodeLock.owns(request.projectId, request.episodeId)) return
  }
  if (rejectVideoRequestWithoutVoices(request)) return
  let jobs = retryJobs(request)
  if (jobs.size) {
    // A stored unknown submission may have since resolved to an ordinary failure.
    const uncertain = (videoEpisode(request.projectId, request.episodeId)?.tasks || [])
      .filter((task) => task.taskId && jobs.get(task.cardId) === task.id)
    await Promise.allSettled(uncertain.map((task) =>
      scriptVideoRequest(`/projects/${request.projectId}/video/${task.taskId}`),
    ))
    try {
      await refreshProject(request.projectId, request.episodeId)
      jobs = retryJobs(request)
    } catch { /* Keep the local uncertainty if status is temporarily unavailable. */ }
  }
  if (!openVideoRetry(request, jobs)) await runVideoRequests(request)
}
async function confirmVideoRetry(confirmed: boolean) {
  const request = pendingVideoRetry.value
  if (!request || !episodeLock.owns(request.projectId, request.episodeId)) return
  pendingVideoRetry.value = null
  dialog.value = null
  if (confirmed) await runVideoRequests(request, request.jobs)
  else await runVideoRequests({ ...request, cardIds: request.cardIds.filter((id) => !request.jobs.has(id)) })
}
function reportVideoError(projectId: string, episodeId: string, message: string) {
  if (!alive) return
  if (episodeLock.owns(projectId, episodeId)) return toast.error(message)
  const project = projects.value.find(item => item.id === projectId)
  const episode = project?.episodes.find(item => item.id === episodeId)
  const source = [project?.title, episode?.number ? `第${episode.number}集` : episode?.title].filter(Boolean).join(' · ')
  toast.error(`${source || '原分集'}：${message}`)
}
async function refreshVideoEpisodeAfterTaskUpdate(projectId: string, episodeId: string, signal = requestController.signal) {
  // The task was already accepted or reached a terminal state on the server.
  // A temporarily unavailable UI snapshot must not interrupt dependent segments.
  try {
    await refreshProject(projectId, episodeId, AbortSignal.any([signal, AbortSignal.timeout(8000)]))
  } catch { /* The next episode activity refresh will update the cached snapshot. */ }
}
async function runVideoRequests(request: VideoGenerationRequest, approvedJobs?: Map<string, string>) {
  const { projectId, episodeId } = request
  const scope = `${projectId}/${episodeId}`
  const run = reactive<VideoRun>({
    id: previewId('video-request'), controller: new AbortController(), cardIds: request.cardIds,
    cardStatuses: new Map(), waitingToSubmit: new Set(),
  })
  let episode = videoEpisode(projectId, episodeId)
  let project = projects.value.find(item => item.id === projectId)
  if (!alive || !project || !episode || !episodeLock.owns(projectId, episodeId) ||
      activeVideoRequests.value.has(scope) || cancelingVideo.value.has(scope)) return
  const canContinue = () => alive && !run.controller.signal.aborted && !!videoEpisode(projectId, episodeId)
  if (rejectVideoRequestWithoutVoices(request)) return

  const selected = new Set(request.cardIds)
  const initialTasks = indexVideoTasks(episode.tasks)
  const scheduled = new Map<string, Promise<VideoSubmission>>()
  const waits = new Map<number, Promise<boolean>>()
  function waitForRender(taskId: number, sourceEpisodeId = episodeId) {
    let wait = waits.get(taskId)
    if (!wait) {
      wait = waitForVideoTail(projectId, episodeId, taskId, run.controller.signal, sourceEpisodeId)
      waits.set(taskId, wait)
    }
    return wait
  }
  const blocked: Array<{ segment: number; previous: string }> = []
  let submitting = Promise.resolve()
  function submit(cardId: string) {
    const next = submitting.then(async (): Promise<VideoSubmission> => {
      if (!canContinue()) return
      const current = videoEpisode(projectId, episodeId)
      const card = current?.cards.find(item => item.id === cardId)
      if (!current || !card) return
      const task = indexVideoTasks(current.tasks).get(cardId)
      if (task?.status === 'processing') return task.taskId
      if (task && isVideoDeliveryRecovery(task)) return recoverFailedVideo(projectId, episodeId, task)
      const uncertain = (task?.status === 'failed' || task?.status === 'canceled') && task.code === 'SUBMISSION_UNKNOWN'
      const approved = uncertain && approvedJobs?.get(cardId) === task.id
      if (uncertain && !approved) return 'needs-approval'
      run.cardStatuses.set(cardId, 'generating')
      return generateCard(card, projectId, episodeId, approved, request.durations?.[cardId], run)
    })
    submitting = next.then(() => {}, () => {})
    return next
  }

  activeVideoRequests.value.set(scope, run)
  const queuePath = `/projects/${projectId}/episodes/${episodeId}/video-queue`
  const toReserve = request.cardIds.filter(id => initialTasks.get(id)?.status !== 'processing' && !isVideoDeliveryRecovery(initialTasks.get(id)))
  let reserved = false, renewing = false
  let keepQueue: ReturnType<typeof setInterval> | undefined
  try {
    await saveProjectNow(projectId)
    if (!canContinue()) return
    if (selected.has(episode.cards[0]?.id || '')) await loadPreviousVideoEpisode(projectId, episodeId, run.controller.signal)
    if (!canContinue()) return
    project = projects.value.find(item => item.id === projectId)!
    episode = videoEpisode(projectId, episodeId)!
    const lightingPlan = episodeLightingPlan(project, episode)
    if (toReserve.length) {
      await scriptVideoRequest(queuePath, 'POST', { requestId: run.id, cardIds: toReserve }, run.controller.signal)
      reserved = true
      for (const id of toReserve) run.waitingToSubmit.add(id)
      if (!canContinue()) return
      keepQueue = setInterval(async () => {
        if (renewing || run.controller.signal.aborted) return
        const waiting = [...run.waitingToSubmit]
        if (!waiting.length) return
        renewing = true
        try { await scriptVideoRequest(queuePath, 'POST', { requestId: run.id, cardIds: waiting }, run.controller.signal) }
        catch { /* The submit endpoint validates reservations atomically. */ }
        finally { renewing = false }
      }, 30_000)
    }
    for (const [index, card] of episode.cards.entries()) {
      if (!selected.has(card.id)) continue
      const predecessor = previousScriptVideoCard(project, episodeId, card.id)
      const previous = predecessor?.card
      const sourceEpisodeId = predecessor?.episode.id || episodeId
      const precedingSubmission = previous && sourceEpisodeId === episodeId ? scheduled.get(previous.id) : undefined
      const existing = initialTasks.get(card.id)
      const alreadySubmitted = existing?.status === 'processing' ||
        isVideoDeliveryRecovery(existing)
      if (!alreadySubmitted) run.cardStatuses.set(card.id, 'queued')
      const needsTail = !alreadySubmitted && previous && !card.referenceFrameSettings?.tail &&
        getScriptVideoContinuationScene(previous, card, project.assets)
      const automaticRanges = (lightingPlan[card.id] || []).filter(range => !card.referenceFrameSettings?.lighting?.[range.firstShot])
      const sceneKeys = new Set(automaticRanges.map(range => range.sceneKey))
      const previousTask = previous && (sourceEpisodeId === episodeId ? initialTasks : indexVideoTasks(predecessor!.episode.tasks)).get(previous.id)
      const pendingLighting = !alreadySubmitted && previous && lightingPlan[previous.id]?.some(range => sceneKeys.has(range.sceneKey))
        ? precedingSubmission || (previousTask?.status === 'processing' ? previousTask.taskId : undefined)
        : undefined
      scheduled.set(card.id, (async (): Promise<VideoSubmission> => {
        if (needsTail) {
          let ready = false
          if (precedingSubmission) {
            const prior = await precedingSubmission
            if (prior === 'needs-approval') return prior
            if (prior) ready = await waitForRender(prior, sourceEpisodeId)
          }
          if (!ready) {
            const current = videoEpisode(projectId, sourceEpisodeId)
            const source = current?.cards.find(item => item.id === previous.id)
            const task = current && source && pendingVideoTask(current, source)
            if (task?.taskId) ready = await waitForRender(task.taskId, sourceEpisodeId)
            const latest = videoEpisode(projectId, sourceEpisodeId)?.cards.find(item => item.id === previous.id)
            ready ||= !!(latest && officialScriptVideoUrl(latest) && (!task || task.taskId))
          }
          if (!ready) {
            if (canContinue()) blocked.push({ segment: index + 1, previous: sourceEpisodeId === episodeId
              ? `第 ${predecessor!.index + 1} 段` : `第 ${predecessor!.episode.number} 集第 ${predecessor!.index + 1} 段` })
            return
          }
        }
        if (pendingLighting) {
          const taskId = await pendingLighting
          if (taskId === 'needs-approval') return
          if (taskId) await waitForRender(taskId, sourceEpisodeId)
        }
        return submit(card.id)
      })())
    }
    const results = await Promise.all([...scheduled].map(async ([id, result]) => {
      try {
        return [id, await result] as const
      } finally {
        run.cardStatuses.delete(id)
        run.waitingToSubmit.delete(id)
      }
    }))
    if (!canContinue()) return
    if (blocked.length === 1) {
      const [{ segment, previous }] = blocked
      reportVideoError(projectId, episodeId, `第 ${segment} 段需要${previous}的尾帧，请等${previous}出片后再生成。`)
    } else if (blocked.length > 1) {
      const segments = blocked.map(item => item.segment).sort((a, b) => a - b).join('、')
      reportVideoError(projectId, episodeId, `第 ${segments} 段需要上一段的尾帧。请等各自承接的上一段出片后再生成。`)
    }
    const needsApproval = results.filter(([, result]) => result === 'needs-approval').map(([id]) => id)
    if (needsApproval.length) openVideoRetry({ ...request, cardIds: needsApproval })
  } catch (error) {
    if (!run.controller.signal.aborted) reportVideoError(projectId, episodeId, error instanceof Error ? error.message : '生成任务未提交')
  } finally {
    clearInterval(keepQueue)
    if (reserved) void scriptVideoRequest(queuePath, 'DELETE', { requestId: run.id }).catch(() => {})
    if (episodeLock.owns(projectId, episodeId)) requestActivityRefresh?.()
    if (activeVideoRequests.value.get(scope)?.id === run.id) activeVideoRequests.value.delete(scope)
  }
}
async function waitForVideoTail(projectId: string, episodeId: string, taskId: number, runSignal: AbortSignal, sourceEpisodeId = episodeId) {
  const scope = `${projectId}/${episodeId}`
  const canContinue = () => alive && !runSignal.aborted && !!videoEpisode(projectId, episodeId)
  activeTailWaits.value.set(scope, (activeTailWaits.value.get(scope) || 0) + 1)
  try {
    let failures = 0
    while (canContinue()) {
      const signal = AbortSignal.any([requestController.signal, runSignal, AbortSignal.timeout(10_000)])
      try {
        const state = await scriptVideoRequest<{ status: Task['status']; videoUrl?: string }>(
          `/projects/${projectId}/video/${taskId}`, 'GET', undefined, signal,
        )
        if (!canContinue()) return false
        if (state.status !== 'processing') {
          await refreshVideoEpisodeAfterTaskUpdate(projectId, sourceEpisodeId, signal)
          return state.status === 'completed' && !!state.videoUrl
        }
        failures = 0
      } catch {
        if (++failures >= 3 || !canContinue()) return false
      }
      await new Promise<void>(resolve => {
        function finish() {
          clearTimeout(timer)
          runSignal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, 5000)
        runSignal.addEventListener('abort', finish, { once: true })
        if (runSignal.aborted) finish()
      })
    }
    return false
  } finally {
    const remaining = (activeTailWaits.value.get(scope) || 1) - 1
    if (remaining) activeTailWaits.value.set(scope, remaining)
    else activeTailWaits.value.delete(scope)
  }
}
async function recoverFailedVideo(projectId: string, episodeId: string, task: Task) {
  const taskId = task.taskId
  if (!taskId || taskActions.value.has(task.id)) return
  taskActions.value.add(task.id)
  try {
    await scriptVideoRequest(`/projects/${projectId}/video/${taskId}/recover`, 'POST')
    await refreshVideoEpisodeAfterTaskUpdate(projectId, episodeId)
    return taskId
  } catch (error) {
    reportVideoError(projectId, episodeId, error instanceof Error ? error.message : '恢复视频任务失败')
  } finally {
    taskActions.value.delete(task.id)
  }
}
function videoDurationIssue(episode: PreviewEpisode, duration: number) {
  const max = Math.min(30, episode.modelMaxDuration)
  const min = episode.modelMinDuration ?? 0
  if (duration > max) return `当前模型单次最多 ${max} 秒，请调整生成时长。`
  if (duration <= 0 || duration < min) return `当前模型的最短生成时长为 ${Math.max(1, min)} 秒。`
  if (episode.modelWholeSeconds && !Number.isInteger(duration)) return '当前模型需要整数秒，请调整生成时长。'
  return ''
}
async function generateCard(
  card: PreviewCard,
  projectId: string,
  episodeId: string,
  confirmedRetry = false,
  duration?: number,
  run?: VideoRun,
): Promise<VideoSubmission> {
  const voiceReplacement = pendingAudioEdits(projectId)
  if (voiceReplacement) {
    await voiceReplacement
    if (!alive || run?.controller.signal.aborted) return
  }
  const project = projects.value.find((item) => item.id === projectId)!
  const episode = project?.episodes.find((item) => item.id === episodeId)
  if (!project || !episode) return
  if (!episode.confirmed || !episode.outlineConfirmed) {
    if (episodeLock.owns(projectId, episodeId)) navigateStage('production')
    return
  }
  if (
    !episode.modelConfigId ||
    !episode.modelName ||
    episode.modelMaxDuration <= 0
  ) {
    reportVideoError(projectId, episodeId, '请先选择已配置的视频模型')
    return
  }
  const durationIssue = videoDurationIssue(episode, duration ?? card.duration)
  if (durationIssue) {
    reportVideoError(projectId, episodeId, durationIssue)
    return
  }
  let voiceCount: number
  try {
    voiceCount = buildScriptVideoDelivery(card, project.assets, deliveryOptions(project, episode)).voices.length
  } catch (error: any) {
    reportVideoError(projectId, episodeId, error.message)
    return
  }
  if (episode.modelMaxAudioReferences !== null && voiceCount > (episode.modelMaxAudioReferences || 0)) {
    reportVideoError(projectId, episodeId, episode.modelMaxAudioReferences
      ? `当前模型最多支持 ${episode.modelMaxAudioReferences} 段角色声音参考，请调整片段或模型`
      : '当前模型不支持角色声音参考，请选择支持音频参考的视频模型')
    return
  }
  if (card.manuallyAdded) {
    if (!hasScriptVideoPromptBody(card.prompt, deliveryOptions(project, episode).stylePreset)) {
      reportVideoError(projectId, episodeId, '请先输入本段视频提示词')
      return
    }
  } else {
    const preflight = validatePreviewCards([card], project.assets, deliveryOptions(project, episode))
    if (!preflight.ok) {
      reportVideoError(projectId, episodeId,
        preflight.issues.find((issue) => issue.level === 'ERROR')?.message ||
          '分镜需要调整',
      )
      return
    }
  }
  try {
    await saveProjectNow(project.id)
    if (!alive || run?.controller.signal.aborted) return
    const saved = projects.value.find(item => item.id === projectId)
    const current = saved?.episodes.find(item => item.id === episodeId)
    const latest = current?.cards.find(item => item.id === card.id)
    if (!saved || !current || !latest) return
    const savedDurationIssue = videoDurationIssue(current, duration ?? latest.duration)
    if (savedDurationIssue) {
      reportVideoError(projectId, episodeId, savedDurationIssue)
      return
    }
    const voiceWarning = missingVideoVoiceMessage(getScriptVideoMissingVoices(latest, saved.assets, deliveryOptions(saved, current)))
    if (voiceWarning) {
      reportVideoError(projectId, episodeId, voiceWarning)
      return
    }
    const path = `/projects/${project.id}/episodes/${episode.id}/cards/${card.id}/video`
    const payload = {
      expectedCardVersion: latest.version,
      configId: current.modelConfigId,
      model: current.modelName,
      aspectRatio: current.aspectRatio,
      resolution: current.resolution,
      ...(run && { requestId: run.id }),
      ...(duration === undefined ? {} : { duration }),
      ...(confirmedRetry ? { confirmRetryAfterUnknown: true } : {}),
    }
    run?.waitingToSubmit.delete(card.id)
    const result = await scriptVideoRequest<{ taskId: number }>(path, 'POST', payload)
    await refreshVideoEpisodeAfterTaskUpdate(project.id, episodeId)
    return result.taskId
  } catch (error: any) {
    if (run?.controller.signal.aborted || error instanceof ScriptVideoRequestError && error.code === 'CANCELED') return
    if (
      error instanceof ScriptVideoRequestError &&
      (error.code === 'SUBMISSION_UNKNOWN' || error.code === 'DELIVERY_FAILED')
    ) {
      try {
        await refreshProject(project.id, episodeId)
        if (error.status === 409 && retryJobs({ projectId, episodeId, cardIds: [card.id] }).size) return 'needs-approval'
      } catch {
        reportVideoError(projectId, episodeId, '任务列表更新失败，刷新项目可重新读取')
      }
    }
    reportVideoError(projectId, episodeId, videoTaskError({ code: error.code, error: error.message }) || '视频提交失败')
  }
}
function episodeLightingPlan(project: PreviewProject, episode: PreviewEpisode): ReturnType<typeof buildScriptVideoEpisodeLightingPlan> {
  return episode.cards.some(card => card.shots?.length)
    ? buildScriptVideoEpisodeLightingPlan(project, episode.id)
    : {}
}
function deliveryOptions(project: PreviewProject, episode: PreviewEpisode, continuation?: ScriptVideoContinuation, lightingRanges?: ScriptVideoLightingRange[]) {
  return {
    model: episode.modelName, provider: episode.modelProvider,
    stylePreset: episode.production?.stylePreset || project.settings?.stylePreset,
    cast: episode.production?.characters,
    continuation, lightingRanges,
  }
}
async function deliveryContinuations(project: PreviewProject, episode: PreviewEpisode, cards: PreviewCard[]) {
  if (cards.some(card => card.id === episode.cards[0]?.id)) await loadPreviousVideoEpisode(project.id, episode.id)
  project = projects.value.find(item => item.id === project.id) || project
  episode = project.episodes.find(item => item.id === episode.id) || episode
  const plan = episodeLightingPlan(project, episode)
  const cardIds = cards.filter(card => {
    const previous = previousScriptVideoCard(project, episode.id, card.id)?.card
    return card.referenceFrameSettings?.tail?.mode === 'manual' || Object.values(card.referenceFrameSettings?.lighting || {}).some(choice => choice.mode === 'manual') ||
      plan[card.id]?.length || previous && getScriptVideoContinuationScene(previous, card, project.assets)
  }).map(card => card.id)
  if (!cardIds.length) return { continuations: {}, lightingRanges: {} }
  await saveProjectNow(project.id)
  const prepared = await scriptVideoRequest<{
    continuations: Record<string, ScriptVideoContinuation>; lightingRanges?: Record<string, ScriptVideoLightingRange[]>
  }>(
    `/projects/${project.id}/episodes/${episode.id}/continuations`, 'POST', {
      cardIds, ...(episode.modelConfigId && episode.modelName && { configId: episode.modelConfigId, model: episode.modelName }),
    },
  )
  return { continuations: prepared.continuations, lightingRanges: prepared.lightingRanges ?? {} }
}
async function copyPromptPreview() {
  const preview = promptPreview.value
  if (!preview?.delivery) return
  let copied = false
  try {
    await navigator.clipboard.writeText(preview.delivery.prompt)
    copied = true
  } catch { /* The exact prompt remains selectable when clipboard access is denied. */ }
  if (promptPreview.value?.request === preview.request) preview.copied = copied
}
function draftFinalPrompt(project: PreviewProject, episode: PreviewEpisode, card: PreviewCard, duration: number | undefined, saveWarning: string): FinalPromptDelivery {
  const options = deliveryOptions(project, episode)
  if (!hasScriptVideoPromptBody(card.prompt, options.stylePreset)) throw new Error('本段还没有视频提示词')
  const delivery = buildScriptVideoDelivery(card, project.assets, { ...options, duration, preview: true })
  const { imageTag, audioTag } = scriptVideoDeliveryTags(options)
  const { prefix, style } = splitScriptVideoPromptStyle(delivery.prompt, options.stylePreset)
  function reference(index: number, tag: string, name: string, url: string): FinalPromptReference {
    const local = /^\/?static\/[^?#%\\\0]+$/u.test(url) && !url.split('/').some(part => part === '.' || part === '..')
    return { index, tag, name, url: local ? '/' + url.replace(/^\//u, '') : '' }
  }
  return {
    source: 'draft', prompt: delivery.prompt,
    ...(style && { style: { ...style, bodyStart: prefix.length } }),
    images: delivery.images.map((asset, i) => reference(i + 1, imageTag(i + 1), asset.name, asset.image)),
    audios: delivery.voices.map(({ asset, roles }, i) => reference(i + 1, audioTag(i + 1), roles.map(role => role.name).join('、'), asset.voiceAudio!.url)),
    missingVoices: delivery.missingVoices,
    warnings: [...new Set([saveWarning, ...(delivery.warnings || [])])],
    ...((episode.cards[0]?.id !== card.id || project.episodes.findIndex(item => item.id === episode.id) > 0) &&
      { pending: '本机草稿未核对上一段的续接尾帧及同场光线参考图，需同步后确认。' }),
  }
}
async function showFinalPrompt({ cardId, title, task, event }: {
  cardId: string; title: string; task?: Task; event?: MouseEvent
}) {
  const projectId = currentProject.value.id, episodeId = currentEpisode.value.id
  const request = ++promptPreviewRequest
  promptReturnFocus = (event?.currentTarget as HTMLElement | undefined) || null
  const context = task ? ['任务记录', task.modelLabel].filter(Boolean).join(' · ') : '当前设置预览'
  promptPreview.value = { request, title, context, delivery: null, pending: true, error: '', copied: null }
  dialog.value = 'prompt-preview'
  const active = () => alive && dialog.value === 'prompt-preview' && promptPreview.value?.request === request &&
    currentProject.value.id === projectId && currentEpisode.value.id === episodeId
  try {
    let saveWarning: ScriptVideoRequestError | undefined
    if (!task) {
      const voiceReplacement = pendingAudioEdits(projectId)
      if (voiceReplacement) await voiceReplacement
      if (!active()) return
      try { await saveProjectNow(projectId) }
      catch (error) {
        if (!(error instanceof ScriptVideoRequestError && error.status === 409 && error.code === 'ASSET_REMOVED')) throw error
        saveWarning = error
      }
    }
    if (!active()) return
    const episode = currentEpisode.value
    const card = episode.cards.find(item => item.id === cardId)
    if (!task && !card) throw new Error('分镜已变更，请重新选择片段')
    const duration = episode.videoDurations?.[cardId]
    if (saveWarning && card) {
      const delivery = draftFinalPrompt(currentProject.value, episode, card, duration, saveWarning.message)
      Object.assign(promptPreview.value!, { delivery, context: '本机草稿 · 尚未同步', pending: false })
      return
    }
    const hasModel = episode.modelConfigId && episode.modelName
    const body = task ? { cardId, jobId: task.id } : {
      cardId, cardVersion: card!.version,
      ...(hasModel && { configId: episode.modelConfigId, model: episode.modelName,
        aspectRatio: episode.aspectRatio, resolution: episode.resolution }),
      ...(duration !== undefined && { duration }),
    }
    const delivery = await scriptVideoRequest<FinalPromptDelivery>(
      `/projects/${projectId}/episodes/${episodeId}/final-prompt`, 'POST', body, requestController.signal,
    )
    if (!active()) return
    if (!delivery.prompt) throw new Error('本段还没有视频提示词')
    const modelLabel = hasModel ? episode.modelLabel || episode.modelName : '未选择视频模型'
    const deliveryContext = delivery.pending || delivery.missingVoices.length || delivery.warnings?.length ? '待补齐素材' : context
    Object.assign(promptPreview.value!, { delivery, context: task ? context : `${deliveryContext} · ${modelLabel}`, pending: false })
  } catch (error: unknown) {
    if (active()) Object.assign(promptPreview.value!, { pending: false, error: error instanceof Error ? error.message : '提示词准备失败' })
  }
}
function checkForAction(list: PreviewCard[]) {
  const result = validatePreviewCards(list, assets.value, {
    ...deliveryOptions(currentProject.value, currentEpisode.value),
    script: confirmedScript.value, production: currentEpisode.value.production,
    scope: list.length === cards.value.length ? 'episode' : 'card',
  })
  if (result.ok) return true
  validation.value = result
  validationScope.value = `${projectTitle.value} · 第 ${currentEpisode.value.number} 集`
  dialog.value = 'validation'
  toast.error('发现需要调整的片段，请查看提示')
  return false
}
async function exportCards(list: PreviewCard[]) {
  if (!list.length || exporting.value || !checkForAction(list)) return
  const projectId = currentProject.value.id, episodeId = currentEpisode.value.id
  const requestedIds = new Set(list.map(card => card.id))
  exporting.value = true
  try {
    await saveProjectNow(projectId)
    const project = projects.value.find(item => item.id === projectId)!
    const episode = project.episodes.find(item => item.id === episodeId)!
    const exportAssets = JSON.parse(JSON.stringify(project.assets)) as PreviewAsset[]
    const episodeCards = JSON.parse(JSON.stringify(episode.cards)) as PreviewCard[]
    const exportList = episodeCards.filter(card => requestedIds.has(card.id))
    if (!exportList.length || exportList.length !== requestedIds.size) throw new Error('分镜已变更，请重新选择要导出的片段')
    const { continuations, lightingRanges } = await deliveryContinuations(project, episode, exportList)
    const exportContext = JSON.parse(JSON.stringify({
      production: episode.production, episodeCards, delivery: deliveryOptions(project, episode), continuations, lightingRanges,
    }))
    const name = `${project.title}-第${episode.number}集`
    const validated = await scriptVideoRequest<{ referenceImages?: Record<string, string> }>(
      `/projects/${projectId}/episodes/${episodeId}/validate`, 'POST', {
        expectedRevision: project.revision,
        prepareReferenceImages: true,
        ...(exportList.length === episodeCards.length ? {} : { cardIds: [...requestedIds] }),
      },
    )
    exportContext.referenceImages = validated.referenceImages
    await exportPreviewPackage(exportList, exportAssets, `${name}-视频交付.zip`, exportContext)
    toast.success('交付文件已导出')
  } catch (error: any) {
    toast.error(error.message || '导出失败，请重试')
  } finally {
    exporting.value = false
  }
}
function sourceChapterCount(chapters: NonNullable<ImportedEpisode['sourceChapters']>) {
  return new Set(chapters.map(chapter => chapter.sourcePath || chapter.title)).size
}
async function importScript(event: Event) {
  const input = event.target as HTMLInputElement
  const selectedFiles = Array.from(input.files || [])
  if (!selectedFiles.length || episodeNavigationBusy.value) {
    input.value = ''
    return
  }
  const files: File[] = []
  const projectId = currentProject.value.id
  let firstImportedId = ''
  importing.value = true
  const imported: ImportedEpisode[] = []
  const errors: string[] = []
  try {
    for (const file of selectedFiles) {
      if (/\.zip$/iu.test(file.name)) {
        try {
          const unpacked = await readScriptVideoZip(file)
          files.push(...unpacked.files)
          errors.push(...unpacked.errors)
        } catch (error: any) {
          errors.push(`${file.name}: ${error.message}`)
        }
      } else files.push(file)
    }
    for (const file of files) {
      try {
        if (file.size > 5 * 1024 * 1024) {
          errors.push(`${file.name} 超过 5MB，未导入`)
          continue
        }
        const episode = await readEpisodeFile(file)
        if (episode) imported.push({ ...episode, sourcePath: file.webkitRelativePath || file.name })
        else errors.push(`${file.name} 内容为空，未导入`)
      } catch (error) {
        errors.push(
          `${file.name}：${error instanceof Error ? error.message : '读取失败'}`,
        )
      }
    }
    const project = projects.value.find(item => item.id === projectId)
    if (!project || !alive) return
    const grouped = groupImportedEpisodes(imported)
    const rows = grouped.episodes
    const notes = grouped.errors
    if (!rows.length) {
      episodeReports.value[project.id] = {
        title: '分集导入结果',
        summary: '没有导入剧本',
        details: notes,
        errors,
      }
      toast.info('文件中没有可导入的剧本')
      return
    }
    const only = project.episodes.length === 1 ? project.episodes[0] : undefined
    const blank = only && episodeLock.owns(projectId, only.id) && !only.script.trim() && !only.confirmedScript?.trim()
      && !only.cards.length && !only.confirmed && !only.outlineConfirmed && !only.production && !only.busy ? only : undefined
    const used = new Set(project.episodes.filter(episode => episode !== blank).map(episode => episode.number))
    const reserved = new Set(
      rows
        .map((item) => item.number)
        .filter((number): number is number => Boolean(number && number > 0)),
    )
    let next = Math.max(...used, ...reserved, 0) + 1
    const details: string[] = [...notes]
    const added = rows.map((item, index) => {
      let number =
        item.number && item.number > 0 && !used.has(item.number)
          ? item.number
          : next
      while (
        used.has(number) ||
        (number !== item.number && reserved.has(number))
      )
        number++
      used.add(number)
      next = Math.max(next, number + 1)
      const sources = [...new Set(item.sourceChapters?.map(chapter => chapter.title) || [])]
      details.push(
        `${sources.length ? sources.join('、') : item.title} → 第 ${number} 集${item.expectedDuration != null ? ` · 原文标注 ${item.expectedDuration} 秒（仅供查阅）` : ''}${item.number && item.number !== number ? `（原第 ${item.number} 集已存在，另建分集）` : ''}`,
      )
      const title =
        item.title
          .replace(/^#{1,6}\s*/u, '')
          .replace(
            /^(?:[【\[]\s*)?(?:第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*集|(?:episode|ep)\.?\s*[0-9]+)\s*[】\]]?\s*[:：\-—|]?\s*/iu,
            '',
          )
          .trim() || (sources.length ? sources.join('、') : item.title)
      const episode = index === 0 && blank ? blank : makeEpisode(title, number)
      return Object.assign(episode, {
        number, title, script: item.script,
        sourceChapters: item.sourceChapters,
        sceneEstimates: item.sceneEstimates,
        expectedDuration: item.expectedDuration,
      })
    })
    project.episodes.push(...added.filter(episode => episode !== blank))
    project.episodes.sort((a, b) => a.number - b.number)
    await saveProjectNow(projectId)
    firstImportedId = added[0].id
    episodeReports.value[project.id] = {
      title: '分集导入结果',
      summary: [
        `${grouped.sourceCount} 份来源剧本${grouped.sceneGrouped ? '按场次归为' : '导入为'} ${added.length} 集`,
        ...(notes.length ? [`${notes.length} 条来源备注`] : []),
        ...(errors.length ? [`${errors.length} 条文件读取提示`] : []),
      ].join(' · '),
      details,
      errors,
    }
    toast.success(`已向《${project.title}》导入 ${added.length} 集剧本`)
  } catch (error: any) {
    toast.error(error.message || '分集导入失败')
  } finally {
    input.value = ''
    importing.value = false
  }
  if (firstImportedId && currentProject.value.id === projectId) await selectEpisode(firstImportedId)
}
function uniqueName(name: string, except?: string, collection = assets.value) {
  let next = name,
    suffix = 2
  while (collection.some((a) => a.id !== except && a.name === next))
    next = `${name}-${suffix++}`
  return next
}
function promptAudioName(name: string) {
  const label = name.replaceAll('@', ' ').trim() || '自定义音频'
  return /^(?:音频|图片)\s*\d/u.test(label.normalize('NFKC')) ? `素材-${label}` : label
}
function validReferenceAudio(file: File) {
  if (/\.(?:mp3|wav)$/iu.test(file.name) && file.size > 0 && file.size <= 15 * 1024 * 1024) return true
  toast.error('请选择不超过 15 MB 的 MP3 或 WAV 音频')
  return false
}
async function uploadReferenceAudio(file: File) {
  const { url } = await uploadAPI.audio(file)
  return {
    url, name: file.name,
    mimeType: file.type.startsWith('audio/') ? file.type : undefined,
  }
}
const uploadingPromptMedia = ref(new Map<string, 'image' | 'audio'>())
async function uploadPromptMedia(file: File, kind: 'image' | 'audio') {
  const projectId = currentProject.value.id
  const episodeId = currentEpisode.value.id
  const cardId = selectedCard.value?.id
  if (!cardId || uploadingPromptMedia.value.has(projectId) || !requireSharedProjectEdit()) return
  if (kind === 'audio') {
    if (!validReferenceAudio(file)) return
  } else if (!file.size || !/\.(?:png|jpe?g|webp)$/iu.test(file.name) ||
    file.type && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    toast.error('请选择 PNG、JPEG 或 WebP 图片')
    return
  }
  const label = kind === 'audio' ? '音频' : '图片'
  uploadingPromptMedia.value.set(projectId, kind)
  try {
    const media = kind === 'audio'
      ? { kind: 'audio' as const, image: '', voiceAudio: await uploadReferenceAudio(file) }
      : { kind: 'prop' as const, image: (await uploadAPI.image(file)).url }
    const project = projects.value.find(item => item.id === projectId)
    if (!alive || !project) return
    const stem = file.name.replace(/\.[^.]+$/u, '').trim()
    const name = uniqueName(kind === 'audio' ? promptAudioName(stem) : stem || '自定义图片', undefined, project.assets)
    const asset: PreviewAsset = { id: previewId('asset'), name, sourcePath: file.name, ...media }
    project.assets.push(asset)
    const episode = project.episodes.find(item => item.id === episodeId)
    const card = episode?.cards.find(item => item.id === cardId)
    if (episode && card) updateCard({ ...card, assetIds: [...card.assetIds, asset.id] }, episode)
    await saveProjectNow(projectId)
    toast.success(card ? `已加入本段参考素材，输入 @${name} 引用` : `${label}已保存到项目资产，输入 @${name} 引用`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : `${label}上传失败`)
  } finally {
    uploadingPromptMedia.value.delete(projectId)
  }
}
async function importAssetFiles(
  files?: FileList | File[] | null,
  project = currentProject.value,
) {
  if (!files?.length || assetImporting.value || !requireSharedProjectEdit()) return
  if (!alive || !projects.value.some((item) => item.id === project.id)) return
  assetImporting.value = true
  try {
    const result = await importPreviewAssets(Array.from(files))
    if (!alive || !projects.value.some((item) => item.id === project.id)) {
      result.assets.forEach(releaseAssetImage)
      return
    }
    const rows = resolvePreviewAssetNames(
      result.assets,
      project.assets.map((asset) => asset.name),
    )
    const uploaded: PreviewAsset[] = []
    let uploadCursor = 0
    await Promise.all(
      Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (uploadCursor < rows.length) {
          const asset = rows[uploadCursor++]!
          try {
            const blob = await (await fetch(asset.image)).blob()
            const extension = blob.type.includes('jpeg')
              ? 'jpg'
              : blob.type.includes('webp')
                ? 'webp'
                : 'png'
            const result = await uploadAPI.image(
              new File([blob], `${asset.name}.${extension}`, {
                type: blob.type,
              }),
            )
            uploaded.push({
              ...asset,
              id: previewId('asset'),
              image: result.url,
            })
          } catch (error: any) {
            result.errors.push(
              `${asset.sourcePath}: ${error.message || '上传失败'}`,
            )
          } finally {
            releaseAssetImage(asset)
          }
        }
      }),
    )
    if (!alive || !requireSharedProjectEdit()) return
    project.assets.push(...uploaded)
    await saveProjectNow(project.id)
    const counts = uploaded.reduce<Record<string, number>>((sum, asset) => {
      const label = kindLabel(asset.kind)
      sum[label] = (sum[label] || 0) + 1
      return sum
    }, {})
    const summary = `导入 ${uploaded.length} 张 · ${Object.entries(counts)
      .map(([kind, count]) => `${kind} ${count}`)
      .join(
        ' / ',
      )}${result.skipped.length ? ` · 跳过 ${result.skipped.length} 个非图片或隐藏文件` : ''}`
    assetReports.value[project.id] = {
      title: '资产包导入结果',
      summary,
      details: [
        ...uploaded.map(
          (asset) =>
            `${kindLabel(asset.kind)} · ${asset.sourcePath} → @${asset.name}`,
        ),
        ...result.skipped.map((path) => `已跳过：${path}`),
      ],
      errors: result.errors,
    }
    if (uploaded.length)
      toast.success(`已向《${project.title}》导入 ${uploaded.length} 张资产图`)
    else toast.info('没有可导入的图片，请查看导入结果')
    if (result.errors.length)
      toast.error(`${result.errors.length} 项读取失败，展开导入结果查看`)
  } catch (error) {
    const message = error instanceof Error ? error.message : '资产包读取失败'
    assetReports.value[project.id] = {
      title: '资产包导入结果',
      summary: '导入未完成',
      details: [],
      errors: [message],
    }
    toast.error(message)
  } finally {
    assetImporting.value = false
  }
}
async function importAssets(event: Event) {
  const input = event.target as HTMLInputElement
  try {
    await importAssetFiles(input.files)
  } finally {
    input.value = ''
  }
}
async function dropAssets(event: DragEvent) {
  const project = currentProject.value
  if (assetImporting.value) return
  // Capture entry handles synchronously before the browser clears the drag data store.
  const entries = Array.from(event.dataTransfer?.items || [])
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean) as FileSystemEntry[]
  const fallback = Array.from(event.dataTransfer?.files || [])
  if (!entries.length) return importAssetFiles(fallback)
  const files: File[] = []
  async function walk(entry: FileSystemEntry, parent = ''): Promise<void> {
    const path = `${parent}${entry.name}`
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      )
      Object.defineProperty(file, 'webkitRelativePath', { value: path })
      files.push(file)
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      while (true) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        )
        if (!batch.length) break
        for (const child of batch) await walk(child, `${path}/`)
      }
    }
  }
  assetImporting.value = true
  try {
    for (const entry of entries) await walk(entry)
    assetImporting.value = false
    await importAssetFiles(files, project)
  } catch {
    toast.error('文件夹读取失败，请使用“导入文件夹”选择素材目录')
  } finally {
    assetImporting.value = false
  }
}
const replacingImages = ref(new Set<string>())
async function replaceAssetImage(id: string, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || replacingImages.value.has(id) || !requireSharedProjectEdit()) return
  const project = currentProject.value
  replacingImages.value.add(id)
  try {
    const uploaded = await uploadAPI.image(file)
    const asset = project.assets.find(item => item.id === id)
    if (!asset) throw new Error('素材已移除')
    asset.image = uploaded.url
    await saveProjectNow(project.id)
    toast.success('素材图片已替换')
  } catch (error) { toast.error(error instanceof Error ? error.message : '图片替换失败') }
  finally { replacingImages.value.delete(id) }
}
function releaseAssetImage(asset: { image: string }) {
  if (asset.image.startsWith('blob:')) URL.revokeObjectURL(asset.image)
}
function saveAudioEdit(projectId: string, assetId: string, operation: 'upload' | 'save',
  edit: () => Promise<void>, failureMessage: string,
) {
  const completion = Promise.resolve().then(edit).catch((error: unknown) => {
    toast.error(error instanceof Error ? error.message : failureMessage)
  }).finally(() => { voiceEdits.value.delete(assetId) })
  voiceEdits.value.set(assetId, { projectId, operation, completion })
  return completion
}
function replacePromptAudio(assetId: string, event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || voiceEdits.value.has(assetId) || !requireSharedProjectEdit() || !validReferenceAudio(file)) return
  const projectId = currentProject.value.id
  return saveAudioEdit(projectId, assetId, 'upload', async () => {
    const voiceAudio = await uploadReferenceAudio(file)
    const project = projects.value.find(item => item.id === projectId)
    const asset = project?.assets.find(item => item.id === assetId && item.kind === 'audio')
    if (!alive || !project || !asset) return
    asset.voiceAudio = voiceAudio
    await saveProjectNow(projectId)
    toast.success('素材音频已替换')
  }, '音频替换失败')
}
function changeAssetKind(asset: PreviewAsset, kind: string) {
  if (!['character', 'scene', 'prop', 'creature'].includes(kind) || !requireSharedProjectEdit()) return
  asset.kind = kind as PreviewAsset['kind']
  if (asset.kind !== 'character') {
    delete asset.voiceAudio
    delete asset.voiceMode
  }
}
function saveCharacterVoiceAudio(
  assetId: string, next: () => NonNullable<PreviewAsset['voiceAudio']> | null | Promise<NonNullable<PreviewAsset['voiceAudio']> | null>,
  operation: 'upload' | 'save' = 'save',
) {
  const project = currentProject.value
  const asset = project.assets.find(item => item.id === assetId)
  if (!episodeOpen.value || !asset || asset.kind !== 'character' || voiceEdits.value.has(assetId)) return
  return saveAudioEdit(project.id, assetId, operation, async () => {
    const value = await next()
    if (!alive) return
    const current = project.assets.find(item => item.id === assetId)
    if (current?.kind !== 'character') throw new Error('角色已移除')
    if (value === null) delete current.voiceAudio
    else current.voiceAudio = value
    await saveProjectNow(project.id)
    toast.success(value ? `${current.name}的声音参考已保存` : '已移除角色声音参考')
  }, '角色声音保存失败')
}
function setCharacterModelVoice(assetId: string, enabled: boolean) {
  if (!episodeOpen.value || voiceEdits.value.has(assetId)) return
  const asset = currentProject.value.assets.find(item => item.id === assetId)
  if (asset?.kind === 'character') asset.voiceMode = enabled ? 'model' : 'reference'
}
function uploadCharacterVoice(assetId: string, file: File) {
  if (validReferenceAudio(file)) return saveCharacterVoiceAudio(assetId, () => uploadReferenceAudio(file), 'upload')
}
function removeCharacterVoice(assetId: string) {
  return saveCharacterVoiceAudio(assetId, () => null)
}
function renameAsset(asset: PreviewAsset, value: string) {
  if (!requireSharedProjectEdit()) return asset.name
  if (!value.trim()) {
    toast.error('资产名称不能为空')
    return asset.name
  }
  const nextName = uniqueName(value, asset.id)
  if (nextName === asset.name) return asset.name
  asset.originalName ||= asset.name
  asset.name = nextName
  void saveProjectNow(currentProject.value.id).catch(error => {
    toast.error(error instanceof Error ? error.message : '资产名称保存失败')
  })
  return nextName
}
const assetDeleteDialog = ref<HTMLDialogElement>()
const assetDeleteTitleId = useId()
const assetDeleteMessageId = useId()
const pendingAssetDeletion = ref<{ projectId: string; id: string; name: string }>()
async function requestAssetDeletion(asset: PreviewAsset) {
  const confirmation = assetDeleteDialog.value
  if (!confirmation || confirmation.open || !requireSharedProjectEdit()) return
  pendingAssetDeletion.value = { projectId: currentProject.value.id, id: asset.id, name: asset.name }
  await nextTick()
  if (confirmation.isConnected && !confirmation.open) confirmation.showModal()
}
async function confirmAssetDeletion() {
  const pending = pendingAssetDeletion.value
  const project = currentProject.value
  if (!pending || pending.projectId !== project.id || !requireSharedProjectEdit()) return
  assetDeleteDialog.value?.close()
  const asset = project.assets.find(item => item.id === pending.id)
  if (!asset) return
  releaseAssetImage(asset)
  project.assets = project.assets.filter(item => item.id !== asset.id)
  try {
    await saveProjectNow(project.id)
    toast.success(`已从项目资产移除 ${asset.name}`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '资产删除失败')
  }
}
const sharedActivity = ref<{ scope: string; activeCardIds: string[]; queuedCardIds: string[] }>({ scope: '', activeCardIds: [], queuedCardIds: [] })
const referenceSourceActivity = ref<{ scope: string; episodeId: string; queuedCardIds: string[] }>({ scope: '', episodeId: '', queuedCardIds: [] })
const activeCardIds = computed(() => sharedActivity.value.scope === episodeKey.value ? sharedActivity.value.activeCardIds : [])
const queuedCardIds = computed(() => sharedActivity.value.scope === episodeKey.value ? sharedActivity.value.queuedCardIds : [])
const frameEditor = useScriptVideoReferenceFrames(
  () => episodeOpen.value && stage.value === 'production' && selectedCard.value
    ? { projectId: currentProject.value.id, episodeId: currentEpisode.value.id, card: selectedCard.value } : undefined,
  () => {
    const card = selectedCard.value, episode = currentEpisode.value, project = currentProject.value
    if (!episodeOpen.value || stage.value !== 'production' || !card) return ''
    const predecessor = previousScriptVideoCard(project, episode.id, card.id)
    const previous = predecessor?.card
    if (!previous) return ''
    const sourceEpisode = predecessor!.episode
    const queued = sourceEpisode.id === episode.id ? queuedCardIds.value :
      referenceSourceActivity.value.scope === episodeKey.value && referenceSourceActivity.value.episodeId === sourceEpisode.id
        ? referenceSourceActivity.value.queuedCardIds : []
    return JSON.stringify([sourceEpisode.id, previous.id, previous.version, officialScriptVideoUrl(previous), previous.videoVersions,
      sourceEpisode.tasks.filter(task => task.cardId === previous.id).map(task => [task.id, task.status, task.videoUrl]),
      queued.includes(previous.id)])
  },
  saveProjectNow, async (path, body, signal) => {
    if (selectedCard.value?.id === currentEpisode.value.cards[0]?.id)
      await loadPreviousVideoEpisode(currentProject.value.id, currentEpisode.value.id, signal)
    return scriptVideoRequest(path, 'POST', body, signal)
  },
)
const pageVisible = ref(false)
function refreshVisibleStyles() {
  if (document.visibilityState === 'visible') void loadStylePresets()
}
function updatePageVisibility() {
  pageVisible.value = document.visibilityState === 'visible'
  if (pageVisible.value) void loadStylePresets()
}
onMounted(() => {
  updatePageVisibility()
  document.addEventListener('visibilitychange', updatePageVisibility)
  window.addEventListener('focus', refreshVisibleStyles)
})
let requestActivityRefresh: (() => void) | undefined
watch(() => pageVisible.value && episodeOpen.value ? episodeKey.value : '', (scope, _, onCleanup) => {
  if (!scope) return
  const projectId = currentProject.value.id, episodeId = currentEpisode.value.id
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let polling = false
  type Activity = { revision: number; episodeRevision: number; tasks: Task[]; jobs: ScriptVideoClientJob[]; activeCardIds: string[]; queuedCardIds: string[] }
  async function poll() {
    if (polling || ctrl.signal.aborted) return
    polling = true
    clearTimeout(timer)
    try {
      const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(8000)])
      const status = await scriptVideoRequest<Activity>(`/projects/${projectId}/episodes/${episodeId}/activity`, 'GET', undefined, signal)
      if (ctrl.signal.aborted || episodeKey.value !== scope) return
      sharedActivity.value = { scope, activeCardIds: status.activeCardIds, queuedCardIds: status.queuedCardIds || [] }
      const episode = currentEpisode.value
      const bodyChanged = status.episodeRevision > (episode._episodeRevision ?? -1)
      const sharedChanged = status.revision > (sharedLoaded.get(projectId) ?? -1)
      if (bodyChanged || sharedChanged) await refreshProject(projectId, bodyChanged ? episodeId : undefined, signal, sharedChanged)
      if (ctrl.signal.aborted || episodeKey.value !== scope) return
      if (stage.value === 'production' && selectedCard.value?.id === currentEpisode.value.cards[0]?.id) {
        const project = currentProject.value
        const previous = project.episodes[project.episodes.findIndex(item => item.id === episodeId) - 1]
        if (previous) {
          const source = await scriptVideoRequest<Activity>(`/projects/${projectId}/episodes/${previous.id}/activity`, 'GET', undefined, signal)
          if (ctrl.signal.aborted || episodeKey.value !== scope) return
          referenceSourceActivity.value = { scope, episodeId: previous.id, queuedCardIds: source.queuedCardIds || [] }
          if (previous._loaded === false || source.episodeRevision > (previous._episodeRevision ?? -1))
            await refreshProject(projectId, previous.id, signal, false)
          if (ctrl.signal.aborted || episodeKey.value !== scope) return
        }
      }
      const active = status.jobs.find(job => job.action !== 'video' && ['queued','running'].includes(job.status))
      if (active && !textRuns.value[scope]) void restoreEpisodeAIJobs(projectId, episodeId)
    } catch { /* The editor and the local draft stay available while the status service is unreachable. */ }
    finally {
      polling = false
      if (!ctrl.signal.aborted) timer = setTimeout(() => { void poll() }, 2500)
    }
  }
  requestActivityRefresh = () => { void poll() }
  void poll()
  onCleanup(() => { ctrl.abort(); clearTimeout(timer); requestActivityRefresh = undefined })
})
watch(() => pageVisible.value && (dialog.value === 'project' || dialog.value === 'style'), (open, _, onCleanup) => {
  if (!open) return
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  async function refresh() {
    await loadStylePresets()
    if (active) timer = setTimeout(() => { void refresh() }, 5000)
  }
  void refresh()
  onCleanup(() => { active = false; clearTimeout(timer) })
})
onBeforeRouteLeave(async () => {
  if (episodeNavigationBusy.value) return false
  keepViewPosition(true)
  try {
    await persistBeforeNavigation()
  } catch (error: any) {
    toast.error(error.message)
    return false
  }
})
onBeforeUnmount(() => {
  alive = false
  for (const run of activeVideoRequests.value.values()) run.controller.abort()
  window.removeEventListener('pagehide', saveViewOnPageHide, true)
  window.removeEventListener('online', reconnect)
  window.removeEventListener('focus', refreshVisibleStyles)
  for (const timer of timersForRetry.values()) clearTimeout(timer)
  document.removeEventListener('visibilitychange', updatePageVisibility)
  projects.value.forEach((project) => project.assets.forEach(releaseAssetImage))
  requestController.abort()
  for (const timer of saveTimers.values()) clearTimeout(timer)
})
</script>

<style scoped>
.vp-binding-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  max-height: 420px;
  overflow: auto;
}
.vp-import-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.vp-validation-status {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--error, #e86b68);
  padding: 15px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-input);
}
.vp-validation-status.passed {
  color: var(--success, #63b38b);
}
.vp-validation-status p {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-3);
}
.vp-validation-issues {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}
.vp-validation-issues li {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
}
.vp-validation-issues li > span {
  color: var(--text-3);
  font-size: 10px;
}
.vp-validation-issues li.error > span {
  color: var(--error, #e86b68);
}
.vp-validation-issues p {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.7;
}
.vp-skill-path {
  font-family: monospace;
  overflow-wrap: anywhere;
}
.vp-task-model {
  display: block;
  margin-top: 5px;
  font-size: 9px;
  line-height: 1.5;
  color: var(--accent-text);
  overflow-wrap: anywhere;
}
.vp-task .vp-task-stale {
  color: var(--warning);
  line-height: 1.5;
}
.vp-video-voice-warning,
.vp-task .vp-video-voice-warning {
  margin: 6px 0;
  color: var(--warning, #b77429);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.vp-editing-warnings {
  margin: 0 0 5px;
  padding: 7px 16px;
  border: 1px solid color-mix(in srgb, var(--warning, #b77429) 35%, transparent);
  border-radius: 8px;
  color: var(--warning, #b77429);
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.vp-editing-warnings summary { cursor: pointer; }
.vp-editing-warnings p { margin: 8px 0; }
.vp-editing-warnings ul { margin: 0; padding-left: 20px; }
.vp-task .vp-tail-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.vp-tail-link img {
  width: 42px;
  height: 25px;
  border-radius: 4px;
  object-fit: cover;
}
.vp-tail-wait {
  margin: 0 0 6px;
}
.vp-script-lock {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--accent-text);
  font-size: 12px;
}
.vp-confirmed-script {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 50dvh;
  overflow-y: auto;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-input);
  color: var(--text-1);
  font: 12px/2 var(--font-body);
  margin: 0;
}
.vp-project-form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 17px 26px;
  border-top: 1px solid var(--border);
}
.video-preview-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  padding: 14px 28px 20px;
  gap: 5px;
  color: var(--text-0);
  overflow: hidden;
}
.video-preview-page:has(> .vp-production) {
  overflow-y: auto;
}
.vp-heading,
.vp-title,
.vp-title-line,
.vp-heading-actions,
.vp-section-header,
.vp-workflow,
.vp-material-footer,
.vp-rail-head,
.vp-rail-head > div,
.vp-editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.vp-heading {
  flex-shrink: 0;
}
.vp-title {
  justify-content: flex-start;
  gap: 13px;
}
.vp-title-icon {
  display: grid;
  place-items: center;
  width: 45px;
  height: 45px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  color: var(--accent-text);
  background: var(--accent-bg);
}
.vp-title-line {
  justify-content: flex-start;
}
.vp-title h1 {
  margin: 0;
  font-size: 25px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.vp-title p {
  margin: 5px 0 0;
  color: var(--text-3);
  font-size: 11px;
}
.vp-preview-label {
  display: inline-flex;
  padding: 4px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  font-size: 10px;
  color: var(--accent-text);
  white-space: nowrap;
}
.vp-workflow {
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--surface-raised);
  flex-shrink: 0;
}
.vp-workflow nav {
  display: flex;
  gap: 8px;
}
.vp-workflow nav button {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 14px;
  border: 0;
  border-radius: 8px;
  color: var(--text-3);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
.vp-workflow nav button.active {
  color: var(--text-0);
  background: var(--accent-bg);
}
.vp-workflow nav button > span {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  font-size: 10px;
}
.vp-workflow nav button.active > span {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
}
.vp-workflow nav button > svg {
  margin-left: 12px;
  color: var(--text-3);
}
.vp-output-switch {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.vp-episode-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 5px;
  color: var(--text-2);
  font-size: 11px;
  white-space: nowrap;
}
.vp-episode-status :deep(.base-select-trigger) {
  min-width: 106px;
  min-height: 33px;
  padding: 0 8px;
  font-size: 11px;
}
.vp-output-switch button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  border-radius: 7px;
  font-size: 11px;
  white-space: nowrap;
}
.vp-output-switch .vp-workflow-assets {
  margin-right: 5px;
  border: 1px solid var(--border);
  color: var(--text-1);
}
.vp-output-switch .vp-workflow-assets:hover {
  border-color: var(--accent);
}
.vp-output-switch button.active {
  background: var(--button-bg);
  color: var(--text-0);
}
.vp-preview-notice {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10px;
  color: var(--text-3);
  padding: 0 3px;
  flex-shrink: 0;
}
.vp-preview-notice svg {
  color: var(--accent-text);
  flex-shrink: 0;
}
.vp-preview-notice [role='status'] {
  min-width: 0;
  overflow-wrap: anywhere;
}
.vp-preview-notice button {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--accent-text);
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
}
.vp-panel {
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface-raised);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.vp-production {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 590px;
  gap: 14px;
}
.vp-workbench {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 235px;
  gap: 14px;
  flex: 1;
  min-height: 0;
}
.vp-inspector {
  padding: 17px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  overflow-y: auto;
}
.vp-section-header {
  flex-shrink: 0;
}
.vp-section-header h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}
.vp-section-header p {
  margin: 7px 0 0;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}
.vp-search {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px;
  background: var(--surface-input);
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text-3);
}
.vp-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: none;
  color: var(--text-1);
  font-size: 11px;
}
.vp-library-asset {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  text-align: left;
  border-radius: 8px;
  cursor: pointer;
}
.vp-library-asset.used {
  border-color: var(--border-strong);
  background: var(--accent-bg);
}
.vp-library-image {
  width: 43px;
  height: 42px;
  overflow: hidden;
  flex-shrink: 0;
  border-radius: 5px;
}
.vp-library-copy {
  flex: 1;
  min-width: 0;
}
.vp-library-copy strong {
  display: block;
  font-size: 11px;
  color: var(--text-1);
  font-weight: 500;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.vp-library-copy small {
  display: block;
  margin-top: 5px;
  font-size: 9px;
  color: var(--text-3);
}
.vp-library-asset > svg {
  flex-shrink: 0;
  color: var(--accent-text);
}
.vp-wide {
  width: 100%;
  flex-shrink: 0;
}
.vp-editor-panel {
  min-width: 0;
  min-height: 0;
}
.vp-field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  font-size: 11px;
  color: var(--text-2);
}
.vp-field .input {
  min-width: 0;
  font-size: 11px;
  padding: 9px;
  width: 100%;
}
.vp-two-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.vp-live-dot {
  width: 6px;
  height: 6px;
  background: var(--accent);
  border-radius: 50%;
  box-shadow: 0 0 9px var(--accent-glow);
}
.vp-duration-hint {
  margin: 0;
  color: var(--text-2);
  font-size: 10px;
  line-height: 1.5;
}
.vp-duration-warning {
  color: var(--warning);
}
.vp-inspector-divider {
  height: 1px;
  background: var(--border);
  flex-shrink: 0;
}
.vp-link {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  color: var(--accent-text);
  border: 0;
  padding: 0;
  font-size: 10px;
  cursor: pointer;
}
.vp-skill-summary {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vp-mini-icon {
  width: 29px;
  height: 29px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--accent-text);
  flex-shrink: 0;
}
.vp-skill-summary > div {
  flex: 1;
}
.vp-skill-summary strong {
  display: block;
  font-size: 11px;
  font-weight: 500;
}
.vp-skill-summary small {
  display: block;
  font-size: 9px;
  color: var(--text-3);
  margin-top: 5px;
}
.vp-skill-summary > svg {
  color: var(--accent-text);
}
.vp-combat-switch {
  cursor: pointer;
}
.vp-combat-switch input,
.vp-config-rule-grid input,
.vp-check-label input {
  accent-color: var(--accent);
  width: 14px;
  height: 14px;
}
.vp-tasks {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
  min-height: 65px;
  overflow-y: auto;
}
.vp-task {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vp-task > svg {
  color: var(--accent-text);
  flex-shrink: 0;
}
.vp-task > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.vp-task strong {
  display: block;
  font-weight: 500;
  font-size: 11px;
}
.vp-task small {
  display: block;
  font-size: 9px;
  color: var(--text-3);
  margin-top: 4px;
}
.vp-no-tasks {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 9px;
  color: var(--text-3);
  font-size: 10px;
  min-height: 80px;
}
.vp-muted {
  color: var(--warning, #b77429);
  font-size: 10px;
}
.vp-rail {
  padding: 5px 16px;
  flex-shrink: 0;
}
.vp-rail-head {
  margin-bottom: 5px;
}
.vp-rail-head strong {
  font-size: 12px;
  font-weight: 600;
}
.vp-rail-head span {
  font-size: 10px;
  color: var(--text-3);
}
.vp-rail-head .vp-rail-ready {
  color: var(--accent-text);
}
.vp-segment-export {
  flex-shrink: 0;
  padding: 6px 10px;
  font-size: 11px;
}
.vp-card-track {
  display: flex;
  gap: 11px;
  overflow-x: auto;
  padding: 2px 2px 4px;
}
.vp-segment-item {
  position: relative;
  flex: 0 0 170px;
}
.vp-segment-card {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  background: var(--surface-input);
  color: var(--text-0);
  border: 1px solid var(--border);
  border-radius: 9px;
  text-align: left;
  overflow: hidden;
  cursor: pointer;
}
.vp-segment-delete {
  position: absolute;
  z-index: 2;
  display: grid;
  place-items: center;
  top: 7px;
  right: 7px;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid #ffffff40;
  border-radius: 5px;
  background: #06121cd4;
  color: #fff;
  cursor: pointer;
}
.vp-segment-delete:hover:not(:disabled),
.vp-segment-delete:focus-visible {
  background: var(--color-danger, #b94c52);
}
.vp-segment-delete:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.vp-segment-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.vp-segment-art {
  height: 77px;
  position: relative;
  background: var(--bg-2);
}
.vp-segment-art:after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(0deg, #06121ca0, transparent);
}
.vp-segment-art :deep(.preview-sprite) {
  opacity: 0.72;
}
.vp-segment-loading {
  position: absolute;
  z-index: 1;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: #06121c99;
  color: #e2fffb;
  font-size: 12px;
  font-weight: 600;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .vp-segment-loading .animate-spin { animation: none; }
}
.vp-segment-number,
.vp-segment-duration,
.vp-segment-combat,
.vp-segment-play {
  position: absolute;
  z-index: 1;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: #fff;
  background: #06121caa;
  font-size: 9px;
}
.vp-segment-number {
  top: 7px;
  left: 7px;
  padding: 3px 5px;
}
.vp-segment-duration {
  right: 7px;
  bottom: 7px;
  padding: 3px 6px;
}
.vp-segment-combat {
  right: 37px;
  top: 7px;
  padding: 4px;
}
.vp-segment-play {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  width: 31px;
  height: 31px;
}
.vp-segment-loading + .vp-segment-play {
  top: auto;
  bottom: 7px;
  left: 7px;
  transform: none;
  width: 21px;
  height: 21px;
}
.vp-segment-loading + .vp-segment-play svg {
  width: 12px;
  height: 12px;
}
.vp-segment-copy {
  padding: 9px 10px;
}
.vp-segment-copy strong {
  font-weight: 500;
  font-size: 11px;
}
.vp-segment-copy small {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 7px;
  font-size: 9px;
  color: var(--text-3);
}
.vp-segment-copy small > span {
  margin-left: auto;
}
.vp-segment-copy i {
  width: 4px;
  height: 4px;
  background: var(--text-3);
  border-radius: 50%;
}
.vp-segment-copy i.ready {
  background: var(--accent);
}
.vp-segment-copy i.generating,
.vp-segment-copy i.queued,
.vp-segment-copy i.previous {
  background: var(--warning);
}
.vp-segment-copy i.failed {
  background: var(--error, #e67579);
}
.vp-add-segment {
  flex: 0 0 100px;
  border: 1px dashed var(--border-strong);
  border-radius: 9px;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 10px;
}
.vp-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
}
.vp-empty h2 {
  font-size: 16px;
}
.vp-materials {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  grid-template-rows: minmax(0, 1fr) auto;
}
.vp-script-editor,
.vp-material-assets {
  min-height: 0;
  overflow: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.vp-script-editor {
  border-right: 1px solid var(--border);
}
.vp-project-title {
  font-size: 14px;
  font-weight: 600;
}
.vp-script-textarea {
  flex: 1;
  resize: none;
  min-height: 230px;
  line-height: 2;
  font-size: 12px;
  padding: 18px;
}
.vp-editor-foot {
  font-size: 10px;
  color: var(--text-3);
}
.vp-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  background: var(--accent-bg);
  padding: 23px;
  color: var(--accent-text);
}
.vp-dropzone strong {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-1);
}
.vp-dropzone > span {
  font-size: 10px;
  color: var(--text-3);
}
.vp-material-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 15px;
}
.vp-material-grid button {
  border: 0;
  padding: 0;
  background: none;
  text-align: left;
  color: var(--text-1);
  cursor: pointer;
  min-width: 0;
}
.vp-material-grid button > span {
  display: block;
  height: 85px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.vp-material-grid strong {
  display: block;
  font-size: 11px;
  font-weight: 500;
  margin-top: 7px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vp-material-grid small {
  display: block;
  font-size: 9px;
  color: var(--text-3);
  margin-top: 4px;
}
.vp-material-footer {
  grid-column: 1/-1;
  padding: 15px 24px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}
.vp-material-footer > span {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text-3);
}
.vp-outline {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.vp-outline > .vp-section-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
}
.vp-outline > .vp-section-header h2 {
  font-size: 17px;
}
.vp-outline-index {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 7px;
  overflow-x: auto;
  padding: 10px 24px;
  border-bottom: 1px solid var(--border);
}
.vp-outline-index > button {
  flex: 0 0 auto;
  gap: 7px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.vp-outline-index > button span {
  color: var(--text-2);
}
.vp-outline-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 24px;
  scroll-padding-top: 16px;
}
.vp-outline-card {
  border: 1px solid var(--border);
  background: var(--surface-input);
  border-radius: 12px;
  max-width: 1080px;
  margin: 0 auto 14px;
}
.vp-outline-card:focus-visible {
  outline: 1px solid var(--accent-text);
  outline-offset: -1px;
}
.vp-outline-heading,
.vp-outline-footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
}
.vp-outline-heading h3 {
  margin: 5px 0 0;
  color: var(--text-0);
  font-size: 16px;
  font-weight: 650;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.vp-outline-heading > button {
  flex-shrink: 0;
}
.vp-outline-time {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  color: var(--accent-text);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.vp-outline-body,
.vp-outline-form {
  padding: 0 18px 15px;
}
.vp-outline-section-labeled {
  display: grid;
  grid-template-columns: minmax(95px, 110px) minmax(0, 1fr);
  gap: 12px;
}
.vp-outline-section + .vp-outline-section {
  margin-top: 8px;
}
.vp-outline-section h4,
.vp-outline-section p,
.vp-outline-empty {
  margin: 0;
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.vp-outline-section p {
  color: var(--text-1);
}
.vp-outline-section h4 {
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 600;
  line-height: 24.5px;
}
.vp-outline-empty {
  color: var(--text-3);
}
.vp-outline-fields {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 92px;
  gap: 12px;
  margin-bottom: 10px;
}
.vp-outline-fields label {
  display: grid;
  min-width: 0;
  gap: 5px;
  color: var(--text-1);
  font-size: 11px;
}
.vp-outline-fields input,
.vp-outline-form textarea {
  width: 100%;
  min-width: 0;
}
.vp-outline-form textarea {
  display: block;
  min-height: 180px;
  resize: vertical;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text-1);
  font: inherit;
  font-size: 14px;
  line-height: 1.75;
}
.vp-combat {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--warning);
  font-size: 10px;
}
.vp-outline-footer {
  align-items: center;
  border-top: 1px solid var(--border);
  padding-block: 10px;
}
.vp-outline-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.vp-outline-tags span {
  padding: 4px 7px;
  border-radius: 4px;
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 10px;
  overflow-wrap: anywhere;
}
.vp-outline-tools {
  display: flex;
  flex-shrink: 0;
  gap: 5px;
}
.vp-add-outline {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  max-width: 1080px;
  margin-inline: auto;
  border: 1px dashed var(--border-strong);
  border-radius: 8px;
  padding: 13px;
  color: var(--text-2);
  background: none;
  font-size: 11px;
  cursor: pointer;
}
.vp-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 180;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--scrim);
  backdrop-filter: blur(7px);
  padding: 22px;
}
.vp-modal {
  display: flex;
  flex-direction: column;
  max-height: 88dvh;
  width: min(740px, 100%);
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: 18px;
  box-shadow: var(--shadow-elevated);
  overflow: hidden;
  color: var(--text-0);
}
.vp-assets-modal {
  width: min(1080px, 100%);
  height: min(800px, 88dvh);
}
.vp-final-prompt-modal {
  width: min(930px, 100%);
}
.vp-assets-modal > header,
.vp-assets-modal > footer,
.vp-final-prompt-modal > header,
.vp-final-prompt-modal > footer {
  flex-shrink: 0;
}
.vp-modal > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 26px;
  border-bottom: 1px solid var(--border);
}
.vp-modal h2 {
  margin: 6px 0 0;
  font-size: 20px;
  font-weight: 600;
}
.vp-modal-eyebrow {
  font-size: 9px;
  letter-spacing: 0.13em;
  color: var(--accent-text);
}
.vp-modal-body {
  padding: 24px 26px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 17px;
}
.vp-export-clips {
  display: grid;
  gap: 6px;
}
.vp-export-clip {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) max-content max-content;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.vp-export-clip:has(input:disabled) {
  color: var(--text-3);
  cursor: default;
}
.vp-export-clip strong {
  font-size: 12px;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.vp-export-number {
  color: var(--accent-text);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
@media (prefers-reduced-motion: reduce) {
  .vp-export-submit .animate-spin { animation: none; }
}
.vp-confirm-delete {
  border-color: var(--error, #c75d63);
  color: var(--error, #e67579);
}
.vp-assets-body {
  flex: 1;
  min-height: 0;
  padding: 0;
  gap: 0;
  overflow: hidden;
}
.vp-assets-toolbar {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 26px 0;
  flex-shrink: 0;
}
.vp-assets-import-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.vp-assets-import-bar .vp-modal-description {
  max-width: 440px;
  font-size: 12px;
}
.vp-assets-import-bar .vp-import-actions {
  flex-shrink: 0;
  justify-content: flex-end;
}
.vp-asset-manage-tabs {
  display: flex;
  gap: 22px;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
}
.vp-asset-manage-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  padding: 0 0 13px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.vp-asset-manage-tabs button span {
  min-width: 22px;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--surface-input);
  color: var(--text-2);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.vp-asset-manage-tabs button:hover,
.vp-asset-manage-tabs button.active {
  color: var(--accent-text);
}
.vp-asset-manage-tabs button.active {
  border-bottom-color: var(--accent);
}
.vp-asset-manage-tabs button.active span {
  color: var(--accent-text);
  background: var(--accent-bg);
}
.vp-asset-manage-tabs button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.vp-managed-assets {
  min-height: 0;
  flex: 1;
  padding: 18px 26px 24px;
  overflow: auto;
  scrollbar-gutter: stable;
}
.vp-managed-assets:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -4px;
}
.vp-assets-import-report {
  margin-bottom: 16px;
}
.vp-asset-edit-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 12px;
}
.vp-assets-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 220px;
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
}
.vp-assets-empty strong {
  color: var(--text-1);
  font-size: 14px;
  font-weight: 500;
}
.vp-modal > footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 17px 26px;
  border-top: 1px solid var(--border);
}
.vp-modal-script {
  height: 320px;
  resize: vertical;
  font-size: 12px;
  line-height: 1.9;
  padding: 15px;
}
.vp-modal-description {
  font-size: 11px;
  line-height: 1.9;
  color: var(--text-3);
  margin: 0;
}
.vp-ai-error-detail {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.7;
  color: var(--text-1);
}
.vp-final-prompt-meta {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 13px;
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
}
.vp-final-prompt-meta strong {
  color: var(--text-1);
}
.vp-final-prompt-count {
  margin-inline-start: auto;
}
.vp-final-prompt-warning {
  margin: 0;
  color: var(--warning);
  font-size: 12px;
  line-height: 1.6;
}
.vp-final-prompt-modal > footer > button {
  flex-shrink: 0;
}
.vp-asset-edit-row {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: 10px 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-input);
  transition: border-color 0.18s;
}
.vp-asset-edit-row:hover {
  border-color: var(--border-strong);
}
.vp-asset-edit-image {
  display: block;
  width: 68px;
  height: 76px;
  overflow: hidden;
  border-radius: 7px;
  border: 1px solid var(--border);
}
.vp-asset-edit-row.focused {
  border-color: var(--accent);
}
.vp-asset-edit-fields {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
}
.vp-asset-edit-row .input {
  width: 100%;
  min-width: 0;
  height: 36px;
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 7px;
  background: var(--surface-raised);
}
.vp-asset-edit-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.vp-asset-kind-select {
  width: 88px;
  flex-shrink: 0;
}
.vp-asset-kind-select :deep(.base-select-trigger) {
  min-height: 28px;
  padding: 0 9px;
  border-radius: 6px;
  border-color: var(--border);
  background: var(--surface-raised);
  box-shadow: none;
  font-size: 11px;
  font-weight: 500;
}
.vp-asset-kind-select :deep(.base-select-trigger:hover),
.vp-asset-kind-select :deep(.base-select-trigger.open),
.vp-asset-kind-select :deep(.base-select-trigger:focus-visible) {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.vp-asset-source {
  overflow: hidden;
  color: var(--text-3);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vp-asset-edit-actions {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}
.vp-asset-edit-actions > .btn {
  min-height: 30px;
  white-space: nowrap;
}
.vp-asset-replace {
  position: relative;
  cursor: pointer;
}
.vp-asset-replace:focus-within {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.vp-asset-replace:has(input:disabled) {
  opacity: .45;
  cursor: not-allowed;
}
.vp-replace-file {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
  cursor: inherit;
}
.vp-asset-delete {
  width: 30px;
  min-width: 30px;
  height: 30px;
  margin-inline-start: auto;
  padding: 0;
  border-color: transparent;
  background: transparent;
  box-shadow: none;
  color: var(--text-3);
}
.vp-asset-delete:hover:not(:disabled) {
  color: var(--error);
  border-color: var(--error);
  background: var(--error-bg);
}
.vp-asset-delete-dialog {
  width: min(420px, calc(100% - 32px));
  margin: auto;
  padding: 24px;
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  background: var(--surface-raised);
  color: var(--text-0);
  box-shadow: var(--shadow-elevated);
}
.vp-asset-delete-dialog::backdrop {
  background: var(--scrim);
}
.vp-asset-delete-dialog h2 {
  margin: 0;
  font-size: 17px;
}
.vp-asset-delete-dialog p {
  margin: 8px 0 16px;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.vp-asset-delete-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.vp-asset-edit-row .vp-asset-voice {
  grid-column: 1 / -1;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.vp-agent-identity {
  display: flex;
  align-items: center;
  gap: 12px;
}
.vp-agent-identity > span:first-child {
  display: grid;
  place-items: center;
  width: 49px;
  height: 49px;
  background: var(--accent-bg);
  color: var(--accent-text);
  border-radius: 13px;
  flex-shrink: 0;
}
.vp-agent-identity h3 {
  font-size: 15px;
  margin: 0;
}
.vp-agent-identity p {
  font-size: 10px;
  color: var(--text-3);
  line-height: 1.8;
  margin: 6px 0 0;
}
.vp-agent-identity .vp-preview-label {
  margin-left: auto;
}
.vp-config-tabs {
  display: flex;
  gap: 20px;
  border-bottom: 1px solid var(--border);
}
.vp-config-tabs button {
  border: 0;
  background: none;
  color: var(--text-3);
  font-size: 12px;
  padding: 12px 0;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.vp-config-tabs button.active {
  color: var(--accent-text);
  border-color: var(--accent);
}
.vp-config-tabs button span {
  margin-left: 5px;
  font-size: 10px;
}
.vp-agent-prompt {
  padding: 14px;
  font-size: 12px;
  line-height: 1.9;
  min-height: 150px;
}
.vp-config-rule-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
  font-size: 11px;
  color: var(--text-2);
}
.vp-config-rule-grid label {
  display: flex;
  align-items: center;
  gap: 7px;
}
.vp-config-skill {
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-input);
}
.vp-config-skill > div:first-child {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--accent-text);
}
.vp-config-skill strong {
  color: var(--text-0);
  font-size: 13px;
  font-weight: 600;
}
.vp-config-skill .tag {
  margin-left: auto;
  font-size: 9px;
}
.vp-config-skill p,
.vp-config-skill li {
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.9;
}
.vp-config-skill ul {
  margin-bottom: 0;
  padding-left: 18px;
}
.vp-check-label {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
}
.vp-config-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.vp-config-tags span {
  padding: 5px 8px;
  border-radius: 5px;
  font-size: 10px;
  color: var(--text-3);
  background: var(--bg-2);
}
@media (max-height: 850px) and (min-width: 851px) {
  .video-preview-page {
    overflow-y: auto;
  }
  .vp-production {
    flex: none;
  }
  .vp-workbench {
    height: 550px;
    flex: none;
  }
  .vp-materials {
    min-height: 600px;
  }
}
@media (max-height: 850px), (max-width: 850px) {
  .vp-outline {
    flex: none;
    overflow: clip;
  }
  .vp-outline-index {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-1);
  }
  .vp-outline-list {
    flex: none;
    overflow: visible;
  }
  .vp-outline-card {
    scroll-margin-top: 84px;
  }
}
@media (min-width: 1600px) {
  .video-preview-page {
    padding-left: 40px;
    padding-right: 40px;
  }
  .vp-workbench {
    grid-template-columns: minmax(0, 1fr) 270px;
  }
  .vp-segment-item {
    flex-basis: 200px;
  }
  .vp-segment-art {
    height: 90px;
  }
}
@media (max-width: 1100px) {
  .video-preview-page {
    padding: 18px;
    gap: 12px;
  }
  .vp-workbench {
    grid-template-columns: minmax(0, 1fr) 200px;
    gap: 10px;
  }
  .vp-inspector {
    padding: 14px 11px;
    gap: 12px;
  }
  .vp-title h1 {
    font-size: 22px;
  }
  .vp-heading-actions .btn {
    padding: 0 11px;
    font-size: 11px;
  }
  .vp-workflow nav {
    gap: 2px;
  }
  .vp-workflow nav button {
    padding: 8px;
    gap: 7px;
  }
  .vp-workflow nav button > svg {
    margin-left: 4px;
  }
  .vp-preview-notice {
    font-size: 9px;
  }
  .vp-library-image {
    width: 33px;
    height: 36px;
  }
}
@media (max-width: 850px) {
  .video-preview-page {
    height: auto;
    min-height: 100%;
    overflow: visible;
  }
  .vp-workbench {
    grid-template-columns: minmax(0, 1fr);
    min-height: 600px;
  }
  .vp-inspector {
    grid-column: 1/-1;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    overflow: visible;
  }
  .vp-inspector .vp-tasks {
    min-height: 50px;
  }
  .vp-inspector .vp-inspector-divider {
    display: none;
  }
  .vp-production {
    overflow: visible;
  }
  .vp-workflow {
    flex-wrap: wrap;
  }
  .vp-workflow nav {
    flex: 1;
  }
  .vp-materials {
    min-height: 800px;
  }
  .vp-material-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .vp-material-footer {
    padding: 15px;
  }
  .vp-material-footer > span {
    max-width: 45%;
  }
  .vp-title p {
    display: none;
  }
}
@media (max-width: 760px) {
  .vp-asset-edit-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .vp-assets-import-bar {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
}
@media (max-width: 600px) {
  .video-preview-page {
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    padding: 12px;
  }
  .vp-heading {
    align-items: flex-start;
  }
  .vp-heading-actions {
    flex-direction: column;
    gap: 6px;
  }
  .vp-title-icon {
    display: none;
  }
  .vp-title-line {
    flex-wrap: wrap;
    gap: 6px;
  }
  .vp-title h1 {
    font-size: 20px;
  }
  .vp-heading-actions .btn {
    min-height: 30px;
  }
  .vp-production,
  .vp-workbench {
    flex: none;
  }
  .vp-workbench {
    display: flex;
    flex-direction: column;
  }
  .vp-editor-panel {
    min-height: 620px;
  }
  .vp-inspector {
    display: flex;
  }
  .vp-workflow nav button {
    padding: 5px;
    font-size: 10px;
    gap: 5px;
  }
  .vp-workflow nav button > svg {
    display: none;
  }
  .vp-preview-notice {
    line-height: 1.7;
    align-items: flex-start;
  }
  .vp-materials {
    display: flex;
    flex-direction: column;
  }
  .vp-script-editor {
    border-right: 0;
    min-height: 460px;
  }
  .vp-material-assets {
    overflow: visible;
  }
  .vp-material-grid {
    grid-template-columns: repeat(3, 1fr);
  }
  .vp-material-footer {
    flex-wrap: wrap;
  }
  .vp-outline > .vp-section-header,
  .vp-outline-index,
  .vp-outline-list {
    padding-inline: 12px;
  }
  .vp-outline-heading,
  .vp-outline-footer,
  .vp-outline-body,
  .vp-outline-form {
    padding-inline: 12px;
  }
  .vp-outline-section-labeled {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .vp-outline-footer {
    flex-wrap: wrap;
  }
  .vp-combat {
    display: none;
  }
  .vp-modal-overlay {
    padding: 10px;
  }
  .vp-modal > header,
  .vp-modal-body,
  .vp-modal > footer {
    padding: 17px;
  }
  .vp-assets-body {
    padding: 0;
  }
  .vp-assets-toolbar {
    padding: 16px 17px 0;
    gap: 14px;
  }
  .vp-managed-assets {
    padding: 14px 17px 17px;
  }
  .vp-asset-manage-tabs {
    gap: 16px;
  }
  .vp-asset-edit-row {
    grid-template-columns: 56px minmax(0, 1fr);
    gap: 10px;
    padding: 10px;
  }
  .vp-asset-edit-image {
    width: 56px;
    height: 72px;
  }
  .vp-asset-edit-row .input {
    font-size: 12px;
  }
  .vp-rail-head {
    flex-wrap: wrap;
  }
}
</style>
