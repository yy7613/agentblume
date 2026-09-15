/**
 * 業務テンプレートの登録表（ADR-0039）。App・業務テンプレート一覧・ヘルプはここから業務を引く。
 */
import { contractBusiness } from '../contract/contract-business';
import { expenseBusiness } from '../expense/expense-business';
import { journalBusiness } from '../journal/journal-business';
import { receivablesBusiness } from '../receivables/receivables-business';
import { BUSINESS_SCREENS } from './screen-ids';
import type { BusinessDescriptor } from './types';

export const BUSINESSES: readonly BusinessDescriptor[] = [journalBusiness, expenseBusiness, receivablesBusiness, contractBusiness];

/** 画面の業務。業務の画面でなければ undefined。 */
export function businessOf(screen: string, businesses: readonly BusinessDescriptor[] = BUSINESSES): BusinessDescriptor | undefined {
  return businesses.find((business) => business.screen === screen);
}

/**
 * 登録の食い違い（id・画面・並び順の重複、画面ID表と記述子の過不足）を文で返す。空なら整合している。
 * 画面ID表と記述子は別ファイルなので、片方だけ足すと「開けない画面」や「ヘルプの無い画面」になる。
 */
export function businessRegistryProblems(businesses: readonly BusinessDescriptor[] = BUSINESSES, screens: readonly string[] = BUSINESS_SCREENS): readonly string[] {
  const problems: string[] = [];
  const duplicates = (values: readonly (string | number)[]) => values.filter((value, index) => values.indexOf(value) !== index);
  for (const id of duplicates(businesses.map((business) => business.id))) problems.push(`duplicate business id: ${id}`);
  for (const screen of duplicates(businesses.map((business) => business.screen))) problems.push(`duplicate business screen: ${screen}`);
  for (const order of duplicates(businesses.map((business) => business.card.order))) problems.push(`duplicate card order: ${order}`);
  for (const screen of screens) if (!businesses.some((business) => business.screen === screen)) problems.push(`screen has no business: ${screen}`);
  for (const business of businesses) if (!screens.includes(business.screen)) problems.push(`business screen is not listed in BUSINESS_SCREENS: ${business.screen}`);
  return problems;
}
