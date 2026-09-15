/**
 * ドメイン: 判定に差し込む 3 系統の検査関数（docs/21 §20.3.1。骨格）。
 *
 * 並びは A → B → C だが、理由の並びは `check.ts` が評価順（`REASON_CODES`）へ安定ソートするので、この順は結果に影響しない。
 */
import type { ExpenseCheckContributor } from './check-extensions';
import { inputContributor } from './input/check-input';
import { moneyContributor } from './money/check-money';
import { peopleContributor } from './people/check-people';

export const EXPENSE_CHECK_CONTRIBUTORS: readonly ExpenseCheckContributor[] = [peopleContributor, moneyContributor, inputContributor];
