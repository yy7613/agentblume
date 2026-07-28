/**
 * ドメイン: main / judge の2スロットぶんのモデル設定。
 *
 * スロットが `undefined` のときは「env 既定を使う」という意味である（設定を保存していない状態）。
 * これにより、UIから一度も保存していない環境では従来どおり env（LM_STUDIO_* / JUDGE_LM_STUDIO_*）で動く。
 *
 * - `source: 'registry'` … Mastra のモデル登録簿に載っているプロバイダ。model は `'provider/model'` 形式。
 * - `source: 'openai-compatible'` … LM Studio / vLLM 等のOpenAI互換エンドポイント。baseUrl + モデル名。
 *
 * apiKey は封緘済み（SealedSecret）だけを持つ。平文はドメインに存在しない。
 */
import { classifyHost } from '../net/url-policy';
import type { TenantScope } from '../tool/ids';
import { ModelSettingsValidationError } from './errors';
import { createSealedSecret, type SealedSecret } from './sealed-secret';

/** 切り替え可能なモデルスロット。 */
export const MODEL_SLOT_NAMES = ['main', 'judge'] as const;
export type ModelSlotName = (typeof MODEL_SLOT_NAMES)[number];
export const MODEL_SETTINGS_SOURCES = ['registry', 'openai-compatible'] as const;
export type ModelSettingsSource = (typeof MODEL_SETTINGS_SOURCES)[number];

/** モデルID・ベースURLの上限（入口で異常な長さを断つ）。 */
export const MODEL_ID_MAX_LENGTH = 256;
export const MODEL_BASE_URL_MAX_LENGTH = 512;

export type ModelSlotSettings =
  | { readonly source: 'registry'; readonly model: string; readonly apiKey?: SealedSecret }
  | { readonly source: 'openai-compatible'; readonly baseUrl: string; readonly model: string; readonly apiKey?: SealedSecret };

export interface ModelSettings {
  readonly scope: TenantScope;
  readonly main?: ModelSlotSettings;
  readonly judge?: ModelSlotSettings;
  readonly updatedAt: string;
}

export interface CreateModelSettingsProps {
  readonly scope: TenantScope;
  readonly main?: ModelSlotSettings;
  readonly judge?: ModelSlotSettings;
  readonly updatedAt: string;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ModelSettingsValidationError(`createModelSettings: ${field} must be a non-empty string`);
  }
}

function bounded(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ModelSettingsValidationError(`createModelSettings: ${field} must be at most ${max} characters`);
  return trimmed;
}

/** 登録簿モデルは `'provider/model'`。最初の `/` で分割し、両側が非空であることだけを課す。 */
function registryModel(value: unknown, field: string): string {
  nonEmpty(value, field);
  const model = bounded(value, field, MODEL_ID_MAX_LENGTH);
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new ModelSettingsValidationError(`createModelSettings: ${field} must be in 'provider/model' form, but got '${model}'`);
  }
  return model;
}

/**
 * baseUrl のホストが**リンクローカル**（169.254.0.0/16・fe80::/10）か。
 *
 * `POST /model-catalog/openai-compatible-models` は保存済みキーを添えて `{baseUrl}/models` を
 * 取りに行くので、baseUrl はサーバーに代行させる外向きリクエストの宛先になる（SSRF）。
 * ただし MCP と違って**私設ネットワーク全体は塞げない** — 「LAN の別マシンで動かしている
 * LM Studio を使う」は本製品の正当かつ一般的な使い方で、既定で塞ぐと既存環境が黙って壊れる。
 * リンクローカルだけはクラウドのメタデータ窃取が目的の範囲で正当な用途が無いため、常に拒否する。
 */
function isLinkLocalHost(host: string): boolean {
  return classifyHost(host) === 'link-local';
}

/**
 * baseUrl として受け入れる形かどうか（api層の入口検証と共有する純関数）。
 *
 * userinfo 付き（`https://user:pass@host`）を弾くのは、baseUrl が**封緘対象外**で
 * DB・API応答・ログに平文のまま残るためである（URLへ秘密を書かせない）。
 */
export function isHttpBaseUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > MODEL_BASE_URL_MAX_LENGTH) return false;
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (isLinkLocalHost(parsed.hostname)) return false;
  return parsed.username === '' && parsed.password === '';
}

function httpUrl(value: unknown, field: string): string {
  nonEmpty(value, field);
  const raw = bounded(value, field, MODEL_BASE_URL_MAX_LENGTH);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new ModelSettingsValidationError(`createModelSettings: ${field} must be a valid URL: ${raw}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ModelSettingsValidationError(`createModelSettings: ${field} must use http(s): ${raw}`);
  }
  // 資格情報を含み得るのでメッセージにURLは載せない。
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ModelSettingsValidationError(`createModelSettings: ${field} must not embed credentials (user:password@host)`);
  }
  if (isLinkLocalHost(parsed.hostname)) {
    throw new ModelSettingsValidationError(`createModelSettings: ${field} must not target a link-local address (cloud metadata endpoints are never reachable from here)`);
  }
  return raw;
}

/**
 * 宛先の同一性判定に使う正規化（純関数）。
 *
 * 「小文字化した origin + 末尾スラッシュを除いた pathname」だけを見る。
 * query / fragment は宛先の同一性に寄与しないので落とす。URLとして解釈できない値は
 * 文字列としてだけ正規化する（判定は必ず「不一致寄り」に倒れる）。
 */
export function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return raw.toLowerCase().replace(/\/+$/, ''); }
  return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
}

/** 2つの baseUrl が同じ宛先を指すか。 */
export function sameBaseUrl(left: string, right: string): boolean {
  return normalizeBaseUrl(left) === normalizeBaseUrl(right);
}

/**
 * APIキーを流用してよいかを決める「宛先」。
 *
 * registry は provider 接頭辞（キーはプロバイダ単位で発行される）、
 * openai-compatible は正規化済み baseUrl（キーはエンドポイント単位）で同一性を見る。
 */
export type ModelDestination =
  | { readonly source: 'registry'; readonly provider: string }
  | { readonly source: 'openai-compatible'; readonly baseUrl: string };

export interface ModelDestinationInput {
  readonly source: ModelSettingsSource;
  readonly baseUrl?: string;
  readonly model: string;
}

export function modelDestination(input: ModelDestinationInput): ModelDestination {
  if (input.source === 'registry') {
    const slash = input.model.indexOf('/');
    return { source: 'registry', provider: (slash > 0 ? input.model.slice(0, slash) : input.model).trim().toLowerCase() };
  }
  return { source: 'openai-compatible', baseUrl: normalizeBaseUrl(input.baseUrl ?? '') };
}

/** 宛先が同じなら保存済みキーを流用してよい。 */
export function sameModelDestination(left: ModelDestinationInput, right: ModelDestinationInput): boolean {
  const a = modelDestination(left);
  const b = modelDestination(right);
  if (a.source !== b.source) return false;
  return a.source === 'registry' && b.source === 'registry' ? a.provider === b.provider : a.source === 'openai-compatible' && b.source === 'openai-compatible' && a.baseUrl === b.baseUrl;
}

/**
 * 1スロットぶんの設定を検証して複製する。
 * OpenAI互換のモデル名は `qwen/qwen3-4b` のように `/` を含み得るため形式は課さない（非空のみ）。
 */
export function createModelSlotSettings(value: unknown, field = 'slot'): ModelSlotSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelSettingsValidationError(`createModelSettings: ${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const apiKey = record['apiKey'] === undefined ? undefined : createSealedSecret(record['apiKey']);
  if (record['source'] === 'registry') {
    return { source: 'registry', model: registryModel(record['model'], `${field}.model`), ...(apiKey === undefined ? {} : { apiKey }) };
  }
  if (record['source'] === 'openai-compatible') {
    nonEmpty(record['model'], `${field}.model`);
    return {
      source: 'openai-compatible',
      baseUrl: httpUrl(record['baseUrl'], `${field}.baseUrl`),
      model: bounded(record['model'], `${field}.model`, MODEL_ID_MAX_LENGTH),
      ...(apiKey === undefined ? {} : { apiKey }),
    };
  }
  throw new ModelSettingsValidationError(`createModelSettings: ${field}.source must be one of ${MODEL_SETTINGS_SOURCES.join(' | ')}`);
}

/** 検証済みのモデル設定を生成する（入力は複製し、呼び出し側の変更から隔離する）。 */
export function createModelSettings(props: CreateModelSettingsProps): ModelSettings {
  if (props === null || typeof props !== 'object') throw new ModelSettingsValidationError('createModelSettings: props is required');
  nonEmpty(props.scope?.tenantId, 'scope.tenantId');
  nonEmpty(props.scope.workspaceId, 'scope.workspaceId');
  nonEmpty(props.updatedAt, 'updatedAt');
  return {
    scope: { tenantId: props.scope.tenantId, workspaceId: props.scope.workspaceId },
    ...(props.main === undefined ? {} : { main: createModelSlotSettings(props.main, 'main') }),
    ...(props.judge === undefined ? {} : { judge: createModelSlotSettings(props.judge, 'judge') }),
    updatedAt: props.updatedAt,
  };
}

/** スロット名で設定を引く（switchable provider / use case が共有する参照口）。 */
export function modelSlot(settings: ModelSettings | null, slot: ModelSlotName): ModelSlotSettings | undefined {
  return settings === null ? undefined : settings[slot];
}
