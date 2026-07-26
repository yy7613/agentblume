/**
 * ドメイン: モデル設定の直列化。
 *
 * 永続化アダプタはこの Serialized 型をJSON化して1列に保存する。
 * 復元は必ず createModelSettings を通し、保存済みデータにも同じ不変条件を課す。
 * apiKey は封緘済み（SealedSecret）のまま往復する。**平文はこの経路に存在しない**。
 */
import { z } from 'zod';
import { ModelSettingsValidationError } from './errors';
import { createModelSettings, type ModelSettings, type ModelSlotSettings } from './model-settings';
import { SECRET_HINT_LENGTH, type SealedSecret } from './sealed-secret';

export interface SerializedModelSlotSettings {
  readonly source: 'registry' | 'openai-compatible';
  readonly baseUrl?: string;
  readonly model: string;
  readonly apiKey?: SealedSecret;
}

export interface SerializedModelSettings {
  readonly scope: { readonly tenantId: string; readonly workspaceId: string };
  readonly main?: SerializedModelSlotSettings;
  readonly judge?: SerializedModelSlotSettings;
  readonly updatedAt: string;
}

const sealedSecretSchema = z.object({
  v: z.literal(1),
  alg: z.literal('aes-256-gcm'),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
  hint: z.string().max(SECRET_HINT_LENGTH),
});

const slotSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('registry'), model: z.string(), apiKey: sealedSecretSchema.optional() }),
  z.object({ source: z.literal('openai-compatible'), baseUrl: z.string(), model: z.string(), apiKey: sealedSecretSchema.optional() }),
]);

const schema = z.object({
  scope: z.object({ tenantId: z.string(), workspaceId: z.string() }),
  main: slotSchema.optional(),
  judge: slotSchema.optional(),
  updatedAt: z.string(),
});

function serializeSlot(slot: ModelSlotSettings): SerializedModelSlotSettings {
  const apiKey = slot.apiKey === undefined ? {} : { apiKey: { ...slot.apiKey } };
  return slot.source === 'registry'
    ? { source: 'registry', model: slot.model, ...apiKey }
    : { source: 'openai-compatible', baseUrl: slot.baseUrl, model: slot.model, ...apiKey };
}

export function serializeModelSettings(settings: ModelSettings): SerializedModelSettings {
  return {
    scope: { tenantId: settings.scope.tenantId, workspaceId: settings.scope.workspaceId },
    ...(settings.main === undefined ? {} : { main: serializeSlot(settings.main) }),
    ...(settings.judge === undefined ? {} : { judge: serializeSlot(settings.judge) }),
    updatedAt: settings.updatedAt,
  };
}

export function deserializeModelSettings(value: unknown): ModelSettings {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new ModelSettingsValidationError(`deserializeModelSettings: invalid SerializedModelSettings: ${issues}`);
  }
  return createModelSettings(parsed.data);
}
