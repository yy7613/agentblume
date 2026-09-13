/**
 * ドメイン: Stage 1 判定（純関数。docs/20 §3）。
 *
 * 1. 種別が見積 / 納品なら `skipped`。
 * 2. 有効ルールを scope（種別・収支・口座）と conditions（AND）で照合する。
 * 3. 一致を auto / suggest に分ける。auto が 0 件なら `no-rule`（suggest だけあれば `rule-suggest-mode`）。
 * 4. auto の勝者を priority → 特異度 → createdAt で決める。同点なら `multiple-rules`。
 * 5. requiredFacts の欠落 → `missing-fact`。askIf の該当 → `ask-if`。
 * 6. 仕訳草案を組み立てる（`entry-builder.ts`）。組み立てられなければその理由（`unknown-account` / `unbalanced`）。
 *
 * どの分岐でも `candidates` に一致した全ルール（auto / suggest）を残し、UI が「どのルールが競合したか」を出せるようにする。
 */
import type { ChartOfAccounts } from './chart-of-accounts';
import { evaluateConditions, hasFact } from './conditions';
import { NON_JUDGEABLE_KINDS, type JournalDocument, type RuleMatch, type UndecidedReason } from './document';
import { buildEntryFromRule } from './entry-builder';
import type { JournalEntryDraft } from './entry';
import { compareRulePrecedence, ruleSpecificity, type JournalRule } from './rule';

export type Judgment =
  | { readonly stage: 'decided'; readonly ruleId: string; readonly entry: JournalEntryDraft; readonly specificity: number; readonly candidates: readonly RuleMatch[] }
  | { readonly stage: 'undecided'; readonly reasons: readonly UndecidedReason[]; readonly candidates: readonly RuleMatch[] }
  | { readonly stage: 'skipped'; readonly reason: 'document-kind' };

export interface JudgeDocumentInput {
  readonly document: Pick<JournalDocument, 'kind' | 'facts'>;
  readonly rules: readonly JournalRule[];
  readonly chart: ChartOfAccounts;
  /** 判定時刻。取引日の無い文書のインボイス区分の基準日になる。 */
  readonly now: Date;
}

/** ルールの scope が文書に当てはまるか（空の scope は共通）。 */
export function ruleScopeMatches(rule: JournalRule, document: Pick<JournalDocument, 'kind' | 'facts'>): boolean {
  const { scope } = rule;
  if (scope.documentKinds !== undefined && scope.documentKinds.length > 0 && !scope.documentKinds.includes(document.kind)) return false;
  if (scope.direction !== undefined && document.facts.direction !== scope.direction) return false;
  if (scope.accountHints !== undefined && scope.accountHints.length > 0) {
    const hint = document.facts.accountHint?.normalize('NFKC').trim().toLowerCase();
    if (hint === undefined || !scope.accountHints.some((candidate) => candidate.normalize('NFKC').trim().toLowerCase() === hint)) return false;
  }
  return true;
}

/** ルールが文書に一致するか（有効性は見ない。scope + conditions）。 */
export function ruleMatches(rule: JournalRule, document: Pick<JournalDocument, 'kind' | 'facts'>): boolean {
  return ruleScopeMatches(rule, document) && evaluateConditions(document.facts, rule.conditions);
}

function toMatch(rule: JournalRule): RuleMatch {
  return { ruleId: rule.id, ruleName: rule.name, mode: rule.mode, priority: rule.priority, specificity: ruleSpecificity(rule) };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Stage 1 判定。副作用なし。 */
export function judgeDocument(input: JudgeDocumentInput): Judgment {
  const { document, rules, chart } = input;
  if (NON_JUDGEABLE_KINDS.has(document.kind)) return { stage: 'skipped', reason: 'document-kind' };

  const matched = rules.filter((rule) => rule.enabled && ruleMatches(rule, document)).sort(compareRulePrecedence);
  const candidates = matched.map(toMatch);
  const auto = matched.filter((rule) => rule.mode === 'auto');
  const suggest = matched.filter((rule) => rule.mode === 'suggest');

  if (auto.length === 0) {
    const reasons: UndecidedReason[] = suggest.length > 0
      ? [{ code: 'rule-suggest-mode', ruleIds: suggest.map((rule) => rule.id) }]
      : [{ code: 'no-rule' }];
    return { stage: 'undecided', reasons, candidates };
  }

  const winner = auto[0]!;
  const winnerSpecificity = ruleSpecificity(winner);
  const tied = auto.filter((rule) => rule.priority === winner.priority && ruleSpecificity(rule) === winnerSpecificity && rule.createdAt === winner.createdAt);
  if (tied.length > 1) return { stage: 'undecided', reasons: [{ code: 'multiple-rules', ruleIds: tied.map((rule) => rule.id) }], candidates };

  const missing = winner.requiredFacts.filter((path) => !hasFact(document.facts, path));
  if (missing.length > 0) return { stage: 'undecided', reasons: [{ code: 'missing-fact', ruleId: winner.id, facts: missing }], candidates };

  const ask = winner.askIf.find((entry) => evaluateConditions(document.facts, entry.conditions));
  if (ask !== undefined) return { stage: 'undecided', reasons: [{ code: 'ask-if', ruleId: winner.id, questionId: ask.questionId, prompt: ask.prompt }], candidates };

  const built = buildEntryFromRule({ rule: winner, facts: document.facts, kind: document.kind, chart, today: isoDate(input.now) });
  if (!built.ok) return { stage: 'undecided', reasons: [built.reason], candidates };
  return { stage: 'decided', ruleId: winner.id, entry: built.entry, specificity: winnerSpecificity, candidates };
}
