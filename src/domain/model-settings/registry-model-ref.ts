/**
 * ドメイン: 登録簿モデル参照 `'provider/model'`(ADR-0034 Tier 2)
 *
 * `'provider/model'` 形式の分割知識の単一情報源。registryModel 検証と
 * modelDestination(APIキー流用判定)が別々に indexOf('/') していた実装をここへ集約する。
 * openai-compatible のモデル名(`qwen/qwen3-4b` のように `/` を任意個含み得る)には適用しない。
 */

export interface RegistryModelRef {
  readonly provider: string;
  readonly model: string;
}

/** 最初の `/` で分割する。入力は trim され、provider・model の両側が非空でなければ null。 */
export function parseRegistryModelRef(value: string): RegistryModelRef | null {
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

/** `'provider/model'` 形式へ整形する(parseRegistryModelRef の逆)。 */
export function formatRegistryModelRef(ref: RegistryModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/**
 * 宛先同一性(APIキー流用判定)のための緩い provider 抽出。
 * 不正形でも投げず、`/` が先頭または無い場合は全体を provider とみなして
 * 小文字化する(modelDestination の従来挙動を保存)。
 */
export function registryProviderOf(model: string): string {
  const slash = model.indexOf('/');
  return (slash > 0 ? model.slice(0, slash) : model).trim().toLowerCase();
}
