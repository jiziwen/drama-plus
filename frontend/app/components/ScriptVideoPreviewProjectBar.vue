<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { Check, ChevronDown, FolderPlus, Palette, Plus, Trash2, Upload } from "lucide-vue-next";
import BaseSelect from "~/components/BaseSelect.vue";
import type { ScriptVideoEpisodeProgress } from "~/utils/scriptVideoPreview";

type ProjectOption = { id: string; title: string };

const props = withDefaults(defineProps<{
  projects: ProjectOption[];
  projectId: string;
  styleName?: string;
  deletingProjectId?: string;
  episodes: {
    id: string;
    number: number;
    title: string;
    confirmed: boolean;
    progress?: ScriptVideoEpisodeProgress;
  }[];
  episodeId: string;
  occupiedEpisodeIds?: readonly string[];
  selectingEpisode?: boolean;
}>(), {
  occupiedEpisodeIds: () => [],
  selectingEpisode: false,
});

const emit = defineEmits<{
  project: [id: string];
  deleteProject: [id: string];
  episode: [id: string];
  inspectEpisodes: [];
  createProject: [];
  editStyle: [];
  addEpisode: [];
  importEpisodes: [];
}>();

const projectPicker = ref<HTMLElement>();
const projectTrigger = ref<HTMLButtonElement>();
const projectMenuOpen = ref(false);
const projectMenuId = useId();
const projectLabelId = useId();
const deleteDialog = ref<HTMLDialogElement>();
const deleteTitleId = useId();
const deleteMessageId = useId();
const pendingProject = ref<ProjectOption | null>(null);
const selectedProject = computed(() => props.projects.find(project => project.id === props.projectId));
const confirmedCount = computed(
  () => props.episodes.filter((episode) => episode.confirmed).length,
);
const occupiedEpisodes = computed(() => new Set(props.occupiedEpisodeIds));
const episodeProgressColors: Record<ScriptVideoEpisodeProgress, string> = {
  '制作中-大纲': 'tag-warning',
  '制作中-视频制作': 'tag-info',
  '已完成': 'tag-success',
};
const episodeOptions = computed(() => props.episodes.map(episode => {
  const occupied = occupiedEpisodes.value.has(episode.id);
  const caption = [
    `第${episode.number}集`,
    occupied ? '其他页面编辑中' : '',
    episode.title,
  ].filter(Boolean).join(' · ');
  return {
    value: episode.id,
    label: episode.progress ? episode.progress + ' · ' + caption : caption,
    caption,
    progress: episode.progress,
    disabled: false,
  };
}));
const episodeSelectionLabel = computed(() => {
  const selected = episodeOptions.value.find(episode => episode.value === props.episodeId);
  return selected ? '选择分集，' + selected.label : '选择分集';
});

function closeProjectMenu() {
  projectMenuOpen.value = false;
  projectTrigger.value?.focus();
}
function dismissProjectMenu(event: PointerEvent | FocusEvent) {
  if (!projectMenuOpen.value || deleteDialog.value?.open) return;
  const target = event instanceof FocusEvent ? event.relatedTarget : event.target;
  if (target instanceof Node && !projectPicker.value?.contains(target)) {
    projectMenuOpen.value = false;
  }
}
function escapeProjectMenu(event: KeyboardEvent) {
  if (!projectMenuOpen.value) return;
  event.stopPropagation();
  closeProjectMenu();
}
function selectProject(id: string) {
  closeProjectMenu();
  emit('project', id);
}
async function requestProjectDeletion(project: ProjectOption) {
  if (props.deletingProjectId) return;
  pendingProject.value = project;
  await nextTick();
  deleteDialog.value?.showModal();
}
function confirmProjectDeletion() {
  const project = pendingProject.value;
  if (!project || props.deletingProjectId) return;
  deleteDialog.value?.close();
  closeProjectMenu();
  emit('deleteProject', project.id);
}
function requestEpisode(requested: string | number) {
  if (typeof requested !== 'string' || !requested || props.selectingEpisode) return;
  emit('episode', requested);
}

onMounted(() => document.addEventListener('pointerdown', dismissProjectMenu));
onBeforeUnmount(() => document.removeEventListener('pointerdown', dismissProjectMenu));
</script>

<template>
  <section class="project-bar" aria-label="项目与分集">
    <div class="project-controls">
      <div
        ref="projectPicker"
        class="picker project-picker"
        @focusout="dismissProjectMenu"
        @keydown.esc="escapeProjectMenu"
      >
        <span>项目</span>
        <button
          ref="projectTrigger"
          class="project-trigger"
          type="button"
          aria-label="选择创作项目"
          :aria-describedby="projectLabelId"
          :aria-controls="projectMenuId"
          :aria-expanded="projectMenuOpen"
          :disabled="!projects.length"
          @click="projectMenuOpen = !projectMenuOpen"
        >
          <span :id="projectLabelId">{{ selectedProject?.title || '暂无项目' }}</span>
          <ChevronDown :size="13" aria-hidden="true" />
        </button>
        <ul v-show="projectMenuOpen" :id="projectMenuId" class="project-options" aria-label="创作项目">
          <li v-for="project in projects" :key="project.id" class="project-option">
            <button
              type="button"
              class="project-choice"
              :aria-current="project.id === projectId ? 'true' : undefined"
              :title="project.title"
              @click="selectProject(project.id)"
            >
              <span>{{ project.title }}</span>
              <Check v-if="project.id === projectId" :size="13" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="project-delete"
              :aria-label="`删除项目 ${project.title}`"
              :title="`删除项目 ${project.title}`"
              :disabled="!!deletingProjectId"
              @click="requestProjectDeletion(project)"
            >
              <Trash2 :size="14" aria-hidden="true" />
            </button>
          </li>
        </ul>
      </div>
      <button
        class="btn btn-sm new-project"
        type="button"
        aria-label="新建项目"
        title="新建项目"
        @click="emit('createProject')"
      >
        <FolderPlus :size="15" />新建项目
      </button>
      <div class="project-appearance">
        <button class="btn btn-sm project-style" type="button" aria-label="设置项目统一风格" :title="styleName || '设置项目统一风格'" :disabled="!selectedProject" @click="emit('editStyle')">
          <Palette :size="14" /><span>{{ styleName || '项目风格' }}</span>
        </button>
        <slot name="storyboard-mode" />
      </div>
    </div>
    <div class="picker episode-picker">
      <span>分集</span>
      <BaseSelect
        :model-value="episodeId"
        :options="episodeOptions"
        :placeholder="episodes.length ? '请选择分集' : '暂无分集'"
        :aria-label="episodeSelectionLabel"
        :searchable="false"
        :disabled="!selectedProject || !episodes.length || selectingEpisode"
        @open="emit('inspectEpisodes')"
        @update:model-value="requestEpisode"
      >
        <template #label="{ option }">
          <span class="episode-option-label" :title="option.label">
            <span v-if="option.progress" class="tag episode-progress" :class="episodeProgressColors[option.progress]">{{ option.progress }}</span>
            <span class="episode-option-caption">{{ option.caption }}</span>
          </span>
        </template>
      </BaseSelect>
    </div>
    <span class="episode-count"
      >共 {{ episodes.length }} 集 · 已确认 {{ confirmedCount }} 集</span
    >
    <div class="episode-actions">
      <button class="btn btn-sm" type="button" :disabled="!selectedProject" @click="emit('addEpisode')">
        <Plus :size="14" />新增分集
      </button>
      <button class="btn btn-sm" type="button" :disabled="!selectedProject" @click="emit('importEpisodes')">
        <Upload :size="14" />批量导入剧本
      </button>
    </div>
    <dialog
      ref="deleteDialog"
      class="project-delete-dialog"
      :aria-labelledby="deleteTitleId"
      :aria-describedby="deleteMessageId"
      @close="pendingProject = null"
    >
      <h2 :id="deleteTitleId">删除项目</h2>
      <p :id="deleteMessageId">确定删除「{{ pendingProject?.title }}」吗？此操作会一并移除该项目下的分集、资产和生成记录。</p>
      <div class="delete-actions">
        <button type="button" class="btn" autofocus @click="deleteDialog?.close()">取消</button>
        <button type="button" class="btn btn-danger" :disabled="!!deletingProjectId" @click="confirmProjectDeletion">确认删除</button>
      </div>
    </dialog>
  </section>
</template>

<style scoped>
.project-bar,
.project-controls,
.project-appearance,
.episode-actions,
.picker {
  display: flex;
  align-items: center;
  gap: 8px;
}
.project-bar {
  flex: none;
  gap: 14px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 13px;
  background: var(--surface-raised);
}
.project-style { min-width: 0; max-width: 170px; }
.project-style span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-appearance { min-width: 0; max-width: 100%; }
.project-controls,
.episode-picker {
  flex: 1 1 200px;
  max-width: 310px;
  min-width: 0;
}
.project-controls { flex-basis: 480px; max-width: 580px; }
.picker {
  flex-grow: 1;
  min-width: 0;
  position: relative;
}
.project-picker {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
}
.picker > span,
.episode-count {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
.project-trigger {
  appearance: none;
  flex: 1 1 0;
  min-width: 0;
  height: 33px;
  padding: 0 25px 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--button-bg);
  color: var(--text-0);
  font: inherit;
  font-size: 12px;
  text-overflow: ellipsis;
  cursor: pointer;
}
.project-trigger:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.project-trigger:focus-visible,
.project-option button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.project-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-right: 8px;
}
.project-trigger svg,
.project-choice svg {
  flex: none;
  color: var(--text-2);
}
.project-trigger span,
.project-choice span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.episode-picker :deep(.base-select-trigger) {
  min-height: 33px;
  height: 33px;
  padding: 0 8px 0 10px;
  border-color: var(--border-strong);
  border-radius: 7px;
}
.episode-option-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}
.episode-progress {
  flex: none;
  padding: 2px 5px;
  white-space: nowrap;
}
.episode-option-caption {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-options {
  position: absolute;
  z-index: 20;
  grid-column: 2 / 3;
  inset: calc(100% + 4px) 0 auto 0;
  min-width: 145px;
  max-height: min(280px, 38vh);
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg-2);
  box-shadow: var(--shadow-lg);
  list-style: none;
}
.project-option {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 4px;
  border-radius: 5px;
}
.project-option:hover,
.project-option:focus-within {
  background: var(--bg-hover);
}
.project-choice,
.project-delete {
  display: flex;
  align-items: center;
  border: 0;
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}
.project-choice {
  flex: 1;
  justify-content: space-between;
  gap: 5px;
  min-width: 0;
  min-height: 32px;
  padding: 0 6px;
  color: var(--text-0);
  font: inherit;
  font-size: 12px;
  text-align: left;
}
.project-choice[aria-current] {
  color: var(--accent-text);
}
.project-delete {
  flex: none;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--action-danger);
  opacity: 0;
  pointer-events: none;
}
.project-option:hover .project-delete,
.project-option:focus-within .project-delete {
  opacity: 1;
  pointer-events: auto;
}
.project-delete:hover,
.project-delete:focus-visible {
  background: var(--action-danger-bg);
}
.project-option .project-delete:disabled {
  color: var(--text-3);
  cursor: not-allowed;
}
.project-delete-dialog {
  width: min(420px, calc(100% - 32px));
  margin: auto;
  padding: 24px;
  border: 1px solid var(--border-strong);
  border-radius: 13px;
  background: var(--bg-2);
  color: var(--text-0);
  box-shadow: var(--shadow-lg);
}
.project-delete-dialog::backdrop {
  background: var(--scrim);
}
.project-delete-dialog h2 {
  font-size: 17px;
}
.project-delete-dialog p {
  margin: 8px 0 16px;
  color: var(--text-2);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.delete-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.new-project {
  padding: 0 8px;
}
.episode-actions {
  flex: none;
  margin-left: auto;
  white-space: nowrap;
}
@media (hover: none) {
  .project-delete {
    opacity: 1;
    pointer-events: auto;
  }
}
@media (max-width: 920px) {
  .project-bar {
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .project-controls,
  .episode-picker {
    max-width: none;
    flex-basis: calc(50% - 6px);
  }
  .project-controls { flex-basis: 100%; flex-wrap: wrap; }
  .project-picker { min-width: 132px; }
}
@media (max-width: 420px) {
  .project-controls,
  .episode-picker {
    flex-basis: 100%;
  }
  .project-bar {
    padding: 8px 10px;
  }
  .episode-actions {
    gap: 5px;
  }
}
</style>
