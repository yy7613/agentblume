/**
 * ドメイン: Agent Factory の生成資産参照（v33 実装契約 §1 / docs/16-agent-factory.md §6）— 型のみ。
 *
 * `factory-run.ts` と `improvement-proposal.ts` の双方が参照する共通型。両ファイル間の
 * 循環importを避けるため、単独のファイルに切り出す。
 */

/** Run内で生成された資産（Tool / Skill / Agent / Persona / Scenario）のSemVer固定参照。 */
export interface VersionRef {
  readonly internalId: string;
  readonly version: string;
}
