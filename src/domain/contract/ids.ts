/**
 * ドメイン: 契約書レビュー（contract）BC の識別子（ADR-0034 の Flavor パターン）。
 *
 * 審査基準 / 取込文書 / レビュー / 締結済み契約 / 期限の id は素の string から代入できるが、
 * 互いの取り違えはコンパイル時に検出される。実行時表現は素の文字列のまま。
 */
import type { Flavor } from '../shared/brand';

/** 審査基準（Playbook）の識別子。 */
export type PlaybookId = Flavor<string, 'ContractPlaybookId'>;
/** 取込んだ契約書 1 通（ContractDocument）の識別子。 */
export type ContractDocumentId = Flavor<string, 'ContractDocumentId'>;
/** レビュー（ContractReview）の識別子。 */
export type ContractReviewId = Flavor<string, 'ContractReviewId'>;
/** 締結済み契約（SignedContract）の識別子。 */
export type SignedContractId = Flavor<string, 'SignedContractId'>;
/** 期限（Deadline）の識別子。締結済み契約の中で一意。 */
export type DeadlineId = Flavor<string, 'ContractDeadlineId'>;
