/**
 * application層: 段階的ツール生成の小タスク群の公開 API（v42 実装契約 §4）。
 *
 * 呼び出し側（`staged-tool-generation.ts`）はこのバレルだけを見ればよい:
 * ランナー（`runRoleTask`）と 4 つのタスク定義、および入出力の型。
 */
export {
  buildRoleTaskPayload,
  buildRoleTaskRepairInstruction,
  buildRoleTaskSystemPrompt,
  roleTaskResponseName,
  runRoleTask,
  ROLE_TASK_STANDING_RULES,
  type RoleTask,
  type RoleTaskName,
  type RoleTaskOptions,
  type RoleTaskParseResult,
  type RoleTaskResult,
  type TemplateTaskName,
} from './role-task';

export {
  NO_TEMPLATE,
  TEMPLATE_CATEGORY_VALUE_SAMPLE,
  askedSlots,
  candidatesOf,
  fillSlotsTask,
  selectTemplateTask,
  slotMaterialOf,
  slotSchemaOf,
  templateChoices,
  type FillSlotsInput,
  type SelectTemplateInput,
  type SelectTemplateOutput,
} from './template-tasks';

export {
  CATEGORY_VALUE_SAMPLE,
  COMPILER_ADDED_COLUMNS,
  categoricalColumnsOf,
  decideComputationsTask,
  decideFiltersTask,
  decideJoinTask,
  decideOutputTask,
  granularitiesOf,
  joinCandidatesFor,
  joinKeyChoices,
  periodColumnsOf,
  type DecideComputationsInput,
  type DecideComputationsOutput,
  type DecideFiltersInput,
  type DecideFiltersOutput,
  type DecideJoinInput,
  type DecideOutputInput,
} from './tool-design-tasks';
