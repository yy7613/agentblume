import { useEffect, useRef, useState } from 'react';
import { expenseInputApi } from '../../api/expense-input-api';
import type { ExpenseFareLookupResultDto } from '../../api/expense-input-types';
import type { ExpenseFareTypeDto, ExpenseReceiptRouteDto } from '../../api/expense-types';
import { isAbortError } from '../../api/tool-api';
import { useI18n } from '../../i18n';
import type { ExpenseItemRouteSlotProps } from '../expense-slots';
import { messageOf } from '../expense-shared';
import { formatYen, isIsoDateText } from './input-shared';
import './input.css';

export const LOOKUP_DEBOUNCE_MS = 400;
export const TRIPS_MAX = 40;

interface RouteDraft { readonly from: string; readonly via: readonly string[]; readonly to: string; readonly tripsText: string; readonly fareType: '' | ExpenseFareTypeDto }

function draftOf(route: ExpenseReceiptRouteDto | undefined): RouteDraft {
  const stations = route?.stations ?? [];
  return {
    from: stations[0] ?? '', via: stations.slice(1, -1), to: stations.length > 1 ? stations[stations.length - 1] ?? '' : '',
    tripsText: String(route?.trips ?? 1), fareType: route?.fareType ?? '',
  };
}

function parseTrips(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const trips = Number(value);
  return trips >= 1 && trips <= TRIPS_MAX ? trips : undefined;
}

/** 下書き → 区間。出発と到着が空なら undefined（区間を消す）。回数が範囲外なら null（送らない）。 */
export function routeOf(draft: RouteDraft): ExpenseReceiptRouteDto | undefined | null {
  if (draft.from.trim() === '' && draft.to.trim() === '') return undefined;
  const trips = parseTrips(draft.tripsText);
  if (trips === undefined) return null;
  const stations = [draft.from, ...draft.via, draft.to].map((station) => station.trim()).filter((station) => station !== '');
  return { stations, trips, ...(draft.fareType === '' ? {} : { fareType: draft.fareType }) };
}

const routeKey = (route: ExpenseReceiptRouteDto | undefined | null) => (route === undefined || route === null ? '' : JSON.stringify([route.stations, route.trips, route.fareType ?? '']));

/** 明細フォームの区間欄（駅の並び・回数・IC / 切符）と運賃マスタの候補・定期区間のヒント（§20.10.1）。 */
export function RouteFields(props: ExpenseItemRouteSlotProps) {
  const { text } = useI18n();
  const [draft, setDraft] = useState<RouteDraft>(() => draftOf(props.route));
  const [lookup, setLookup] = useState<{ readonly result?: ExpenseFareLookupResultDto; readonly error?: string; readonly loading: boolean }>({ loading: false });
  const emitted = useRef(routeKey(props.route));

  // 親から別の区間が来たら（読取の反映・別の明細）下書きを差し替える。自分が送った値なら触らない。
  useEffect(() => {
    const key = routeKey(props.route);
    if (key !== emitted.current) { emitted.current = key; setDraft(draftOf(props.route)); }
  }, [routeKey(props.route)]);

  const current = routeOf(draft);
  const from = draft.from.trim();
  const to = draft.to.trim();
  const ready = from !== '' && to !== '' && current !== null && current !== undefined;
  const employeeId = props.claim.claimant.employeeId;
  const date = isIsoDateText(props.transactionDate) ? props.transactionDate : undefined;
  const lookupKey = ready ? JSON.stringify([current.stations, current.fareType ?? '', date ?? '', current.trips, employeeId ?? '']) : '';

  useEffect(() => {
    if (props.category?.route === undefined || !ready) { setLookup({ loading: false }); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLookup({ loading: true });
      expenseInputApi(props.transport).lookupFare(props.scope, {
        stations: current.stations, ...(current.fareType === undefined ? {} : { fareType: current.fareType }), ...(date === undefined ? {} : { date }),
        trips: current.trips, ...(employeeId === undefined ? {} : { employeeId }),
      }, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setLookup({ result, loading: false }); })
        .catch((cause: unknown) => { if (!controller.signal.aborted && !isAbortError(cause)) setLookup({ error: messageOf(cause), loading: false }); });
    }, LOOKUP_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [lookupKey, props.category?.route === undefined]);

  if (props.category?.route === undefined) return null;

  const update = (change: Partial<RouteDraft>) => {
    const next = { ...draft, ...change };
    setDraft(next);
    const route = routeOf(next);
    if (route === null) return;
    emitted.current = routeKey(route);
    props.onChange(route);
  };

  const trips = parseTrips(draft.tripsText);
  const defaultFareType = props.transportSettings?.defaultFareType ?? 'ic';
  const fareTypeLabel = (type: ExpenseFareTypeDto) => (type === 'ic' ? 'IC' : text('Ticket', '切符'));
  const openFares = () => props.onOpen({ internalId: '', section: 'fares' });
  const result = lookup.result;

  return <fieldset className="expense-wide expense-input-route">
    <legend>{text('Route', '区間')}{props.category.route.required ? text(' (required)', '（必須）') : ''}</legend>
    <div className="expense-input-route-row">
      <label>{text('From', '出発駅')}
        <input id={props.inputId} value={draft.from} onChange={(event) => update({ from: event.target.value })} />
      </label>
      {draft.via.map((station, index) => <span key={index} className="expense-input-via">
        <label>{text(`Via ${index + 1}`, `経由 ${index + 1}`)}
          <input value={station} onChange={(event) => update({ via: draft.via.map((entry, at) => (at === index ? event.target.value : entry)) })} />
        </label>
        <button type="button" className="secondary" aria-label={text(`Move via ${index + 1} earlier`, `経由 ${index + 1} を前へ`)} disabled={index === 0}
          onClick={() => update({ via: draft.via.map((entry, at) => (at === index - 1 ? draft.via[index] ?? '' : at === index ? draft.via[index - 1] ?? '' : entry)) })}>↑</button>
        <button type="button" className="secondary" aria-label={text(`Remove via ${index + 1}`, `経由 ${index + 1} を削除`)} onClick={() => update({ via: draft.via.filter((_, at) => at !== index) })}>×</button>
      </span>)}
      <button type="button" className="secondary" onClick={() => update({ via: [...draft.via, ''] })}>{text('Add a via station', '経由駅を追加')}</button>
      <label>{text('To', '到着駅')}
        <input value={draft.to} onChange={(event) => update({ to: event.target.value })} />
      </label>
      <label>{text(`Trips (1–${TRIPS_MAX})`, `回数（1〜${TRIPS_MAX}）`)}
        <input inputMode="numeric" value={draft.tripsText} onChange={(event) => update({ tripsText: event.target.value })} />
      </label>
      <label>{text('Fare type', '券種')}
        <select value={draft.fareType} onChange={(event) => update({ fareType: event.target.value as RouteDraft['fareType'] })}>
          <option value="">{text(`Policy default (${fareTypeLabel(defaultFareType)})`, `規程の既定（${fareTypeLabel(defaultFareType)}）`)}</option>
          <option value="ic">IC</option><option value="ticket">{text('Ticket', '切符')}</option>
        </select>
      </label>
    </div>
    <small className="expense-input-hint">{text('A round trip is 2 trips.', '往復は回数 2 です。')}</small>
    {trips === undefined && <small className="expense-input-warn">{text(`Enter a whole number of trips from 1 to ${TRIPS_MAX}.`, `回数は 1〜${TRIPS_MAX} の整数で入力してください。`)}</small>}
    {from !== '' && to === '' && <small className="expense-input-hint">{text('Enter the arrival station to look up the fare.', '到着駅を入れると運賃を調べます。')}</small>}

    {lookup.loading && <p className="expense-input-lookup" role="status">{text('Looking up the fare table…', '運賃マスタを調べています…')}</p>}
    {lookup.error !== undefined && <p className="expense-input-lookup" role="note">{text(`Could not look up the fare (you can keep entering the item): ${lookup.error}`, `運賃を調べられませんでした（入力は続けられます）: ${lookup.error}`)}</p>}
    {result !== undefined && <div className="expense-input-lookup" aria-label={text('Fare table lookup', '運賃マスタの照合')}>
      {result.routeCount === 0
        ? <p>{text('Register routes in the fare table to check the fare.', '運賃マスタに登録すると照合できます')}{' '}
          <button type="button" className="screen-link" onClick={openFares}>{text('Open the fare table', '運賃マスタを開く')}</button></p>
        : result.candidates.length === 0
          ? <p>{text('No route in the fare table matches these stations.', 'この駅の並びに合う経路が運賃マスタにありません。')}{' '}
            <button type="button" className="screen-link" onClick={openFares}>{text('Open the fare table', '運賃マスタを開く')}</button></p>
          : <p>{text(
            `Fare table: ${result.candidates.length} candidate(s) (${fareTypeLabel(result.fareType)}), highest ${formatYen(result.maxFare)} × ${current?.trips ?? 1} = ${formatYen(result.maxFare === undefined ? undefined : result.maxFare * (current?.trips ?? 1))}`,
            `運賃マスタの候補 ${result.candidates.length} 件（${fareTypeLabel(result.fareType)}）: 最大 ${formatYen(result.maxFare)} × ${current?.trips ?? 1} 回 = ${formatYen(result.maxFare === undefined ? undefined : result.maxFare * (current?.trips ?? 1))}`,
          )}</p>}
      {result.candidates.length > 1 && <ul>{result.candidates.map((candidate) => <li key={candidate.id}>{candidate.stations.join(' > ')}: {formatYen(candidate.fare)}</li>)}</ul>}
      {result.commuterHint?.kind === 'full' && <p className="expense-input-lookup-pass">{text(
        `Within the commuter pass (${result.commuterHint.passRoute}${result.commuterHint.validTo === undefined ? '' : `, valid to ${result.commuterHint.validTo}`}). This cannot be reimbursed.`,
        `通勤定期（${result.commuterHint.passRoute}${result.commuterHint.validTo === undefined ? '' : `、${result.commuterHint.validTo} まで`}）の範囲内です。精算できません`,
      )}</p>}
      {result.commuterHint?.kind === 'partial' && <p className="expense-input-lookup-pass">
        {text(
          `Overlaps the commuter pass (${result.commuterHint.passRoute}) between ${result.commuterHint.overlapFrom} and ${result.commuterHint.overlapTo}.`,
          `通勤定期（${result.commuterHint.passRoute}）と ${result.commuterHint.overlapFrom}〜${result.commuterHint.overlapTo} が重なります。`,
        )}
        {result.commuterHint.restRoute !== undefined && <> {text(`Remaining section: ${result.commuterHint.restRoute}.`, `残りの区間: ${result.commuterHint.restRoute}。`)}</>}
        {result.commuterHint.suggestedAmount !== undefined && <> {text(`Amount candidate: ${formatYen(result.commuterHint.suggestedAmount)} (the amount is not changed automatically).`, `金額の候補: ${formatYen(result.commuterHint.suggestedAmount)}（金額は自動で直しません）。`)}</>}
      </p>}
    </div>}
  </fieldset>;
}
