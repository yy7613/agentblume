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
import { assertHttpUrl, assertNonEmpty, type HttpUrl } from '../shared/assert';
import type { TenantScope } from '../tool/ids';
import { ModelSettingsValidationError } from './errors';
import { parseRegistryModelRef, registryProviderOf } from './registry-model-ref';
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
  | { readonly source: 'openai-compatible'; readonly baseUrl: HttpUrl; readonly model: string; readonly apiKey?: SealedSecret };

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
  assertNonEmpty(value, `createModelSettings: ${field}`, (m) => new ModelSettingsValidationError(m));
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
  if (parseRegistryModelRef(model) === null) {
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
 *
 * ## 限界（既知・意図的）
 *
 * 判定するのは**入力されたホストそのもの**だけで、名前が後からリンクローカルへ解決される場合は
 * 素通りする（MCP側の `assertResolvedHostAllowed` に相当する解決後の再検査を持たない）。
 * ここへ同じ仕組みを入れないのは、私設ネットワークを既定で許している以上、再検査で追加的に
 * 塞げるのはリンクローカルへ解決される名前だけであり、その1点のために全プロバイダー実装の
 * 接続経路へ非同期の検査を配線する割に合わないと判断したため。塞ぐ必要が出たら、
 * fetch の実行点（`adapters/model/*`）に `assertResolvedHostAllowed` と同型の検査を足すこと。
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

function httpUrl(value: unknown, field: string): HttpUrl {
  // 共通不変条件(http(s)・資格情報禁止・長さ上限)は shared へ委譲。リンクローカル拒否は
  // この BC 固有のポリシー(isLinkLocalHost のコメント参照)なのでここに残す。
  const raw = assertHttpUrl(value, `createModelSettings: ${field}`, (m) => new ModelSettingsValidationError(m), {
    maxLength: MODEL_BASE_URL_MAX_LENGTH,
  });
  if (isLinkLocalHost(new URL(raw).hostname)) {
    throw new ModelSettingsValidationError(`createModelSettings: ${field} must not target a link-local address (cloud metadata endpoints are never reachable from here)`);
  }
  return raw;
}

/**
 * 宛先の同一性判定に使う正規化（純関数）。
 *
 * origin は URL の規則どおり大小文字・既定ポートを正規化し、pathname は末尾スラッシュ
 * だけを除く。**pathname と query はそのまま比較する**。URL のパスは大文字小文字を
 * 区別し、query もルーティング先を変え得るため、ここを小文字化・破棄すると別の宛先へ
 * 保存済みAPIキーを流用してしまう。fragment はHTTPリクエストに送られないので落とす。
 * URLとして解釈できない値は文字列としてだけ正規化し、大小文字を維持して不一致寄りに倒す。
 */
export function normalizeBaseUrl(value: string): string {
  const raw = value.trim();
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return raw.replace(/\/+$/, ''); }
  return `${parsed.origin.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
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
    return { source: 'registry', provider: registryProviderOf(input.model) };
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
