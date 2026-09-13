/**
 * ドメイン: 仕訳（journal）BC の識別子（ADR-0034 の Flavor パターン）。
 *
 * 文書 / ルール / 仕訳 / ヒアリングの id は素の string から代入できるが、互いの取り違えは
 * コンパイル時に検出される。実行時表現は素の文字列のまま。
 */
import type { Flavor } from '../shared/brand';

/** 取込んだ 1 証憑（JournalDocument）の識別子。 */
export type JournalDocumentId = Flavor<string, 'JournalDocumentId'>;
/** 自動仕訳ルール（JournalRule）の識別子。 */
export type JournalRuleId = Flavor<string, 'JournalRuleId'>;
/** 仕訳（JournalEntry）の識別子。 */
export type JournalEntryId = Flavor<string, 'JournalEntryId'>;
/** ヒアリングセッション（HearingSession）の識別子。 */
export type JournalHearingId = Flavor<string, 'JournalHearingId'>;
