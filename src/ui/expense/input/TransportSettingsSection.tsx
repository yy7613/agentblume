import { useEffect, useState } from 'react';
import type { ExpenseCategoryDto, ExpenseCategoryRouteDto, ExpenseFareTypeDto, ExpenseTransportSettingsDto } from '../../api/expense-types';
import { useI18n } from '../../i18n';
import type { ExpensePolicySectionSlotProps } from '../expense-slots';
import './input.css';

export const DEFAULT_TRANSPORT_SETTINGS: ExpenseTransportSettingsDto = { commuterPassDeduction: true, fareToleranceYen: 0, defaultFareType: 'ic' };
export const FARE_TOLERANCE_MAX = 10_000;

/** 費目の route を 1 項目だけ変える。3 つとも外れたら route を消す（区間を使わない費目）。 */
export function withRouteFlag(category: ExpenseCategoryDto, key: keyof ExpenseCategoryRouteDto, value: boolean): ExpenseCategoryDto {
  const current = category.route ?? { required: false, commuterPass: false, fareTable: false };
  const next = { ...current, [key]: value };
  const { route: _route, ...rest } = category;
  return next.required || next.commuterPass || next.fareTable ? { ...rest, route: next } : rest;
}

/** 規程の「交通費」節（`transport` の設定と費目の `route`。§20.10.1）。保存は規程タブの「規程を保存」。 */
export function TransportSettingsSection(props: ExpensePolicySectionSlotProps) {
  const { text } = useI18n();
  const { draft } = props;
  const transport = draft.transport ?? DEFAULT_TRANSPORT_SETTINGS;
  const [toleranceRaw, setToleranceRaw] = useState(String(transport.fareToleranceYen));
  useEffect(() => {
    if (Number(toleranceRaw) !== transport.fareToleranceYen) setToleranceRaw(String(transport.fareToleranceYen));
    // 打ちかけの値を引き戻さないよう、draft 側の値の変化だけで同期する。
  }, [transport.fareToleranceYen]);

  const toleranceValid = /^\d+$/.test(toleranceRaw.trim()) && Number(toleranceRaw) <= FARE_TOLERANCE_MAX;
  const setTransport = (change: Partial<ExpenseTransportSettingsDto>) => props.onChange({ ...draft, transport: { ...transport, ...change } });
  const setCategory = (index: number, key: keyof ExpenseCategoryRouteDto, value: boolean) =>
    props.onChange({ ...draft, transport, categories: draft.categories.map((category, at) => (at === index ? withRouteFlag(category, key, value) : category)) });

  return <section id="expense-policy-transport" className="workspace-card" aria-labelledby="expense-input-transport-heading">
    <div className="expense-row-between">
      <h2 id="expense-input-transport-heading">{text('Transport', '交通費')}</h2>
      <button type="button" className="secondary" onClick={() => props.onOpen({ internalId: '', section: 'fares' })}>{text('Open the fare table', '運賃マスタを開く')}</button>
    </div>
    <p className="expense-input-limit">{text(
      'Transport checks run only when the fare table has a route or the claimant has a commuter pass. Without a route map, overlaps through transfer routes that are not written in the station list (for example pass A > B > C and item A > D > C) cannot be detected.',
      '交通費の照合は、運賃マスタに経路があるか、申請者に通勤定期があるときだけ動きます。路線図を持たないので、駅の並びに書かれていない乗換経路の重なり（定期 A > B > C と明細 A > D > C など）は検出できません。',
    )}</p>
    <div className="expense-form">
      <label><span><input type="checkbox" checked={transport.commuterPassDeduction} onChange={(event) => setTransport({ commuterPassDeduction: event.target.checked })} /> {text('Deduct commuter pass sections', '通勤定期の区間を控除する')}</span></label>
      <label>{text(`Allowed fare excess (yen, 0–${FARE_TOLERANCE_MAX.toLocaleString('en-US')})`, `運賃超過の許容差（円、0〜${FARE_TOLERANCE_MAX.toLocaleString('ja-JP')}）`)}
        <input inputMode="numeric" aria-label={text('Allowed fare excess in yen', '運賃超過の許容差（円）')} value={toleranceRaw} onChange={(event) => {
          const raw = event.target.value;
          setToleranceRaw(raw);
          if (/^\d+$/.test(raw.trim()) && Number(raw) <= FARE_TOLERANCE_MAX) setTransport({ fareToleranceYen: Number(raw) });
        }} />
        {!toleranceValid && <small className="expense-input-warn">{text(`Enter a whole number from 0 to ${FARE_TOLERANCE_MAX}. The last valid value is kept.`, `0〜${FARE_TOLERANCE_MAX} の整数で入力してください。最後の正しい値のままです。`)}</small>}
      </label>
      <label>{text('Default fare type', '既定の券種')}
        <select value={transport.defaultFareType} onChange={(event) => setTransport({ defaultFareType: event.target.value as ExpenseFareTypeDto })}>
          <option value="ic">IC</option><option value="ticket">{text('Ticket', '切符')}</option>
        </select>
      </label>
    </div>
    <h3>{text('Categories that use a route', '区間を使う費目')}</h3>
    <p className="expense-input-hint">{text('Turn all three off for categories that have no route (the route field is then hidden).', '3 つとも外すと区間を使わない費目になります（明細フォームに区間欄が出ません）。')}</p>
    <div className="table-wrap"><table className="expense-input-table">
      <thead><tr><th>{text('Category', '費目')}</th><th>{text('Route required', '区間の記入を必須')}</th><th>{text('Check commuter pass', '通勤定期と照合')}</th><th>{text('Check fare table', '運賃マスタと照合')}</th></tr></thead>
      <tbody>{draft.categories.map((category, index) => {
        const name = category.name === '' ? category.id : category.name;
        const route = category.route;
        return <tr key={`${category.id}-${index}`}>
          <td>{name}{!category.enabled && <small className="expense-input-hint">{text('(disabled)', '（無効）')}</small>}</td>
          <td><input type="checkbox" aria-label={text(`${name}: route required`, `${name}: 区間の記入を必須`)} checked={route?.required === true} onChange={(event) => setCategory(index, 'required', event.target.checked)} /></td>
          <td><input type="checkbox" aria-label={text(`${name}: check commuter pass`, `${name}: 通勤定期と照合`)} checked={route?.commuterPass === true} onChange={(event) => setCategory(index, 'commuterPass', event.target.checked)} /></td>
          <td><input type="checkbox" aria-label={text(`${name}: check fare table`, `${name}: 運賃マスタと照合`)} checked={route?.fareTable === true} onChange={(event) => setCategory(index, 'fareTable', event.target.checked)} /></td>
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}
