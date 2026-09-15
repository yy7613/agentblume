import { useEffect, useRef, useState } from 'react';
import { expenseInputApi } from '../../api/expense-input-api';
import type { ExpenseFareRouteDto, ExpenseFareTableDto, ExpenseStationAliasDto } from '../../api/expense-input-types';
import type { ExpenseFareTypeDto } from '../../api/expense-types';
import { InlineFeedback } from '../../components/InlineFeedback';
import { useI18n } from '../../i18n';
import { decodeCsvText, triggerDownload } from '../../journal/journal-model';
import type { ExpenseLedgerSlotProps } from '../expense-slots';
import { messageOf } from '../expense-shared';
import { readFileBytes, rowOf } from './input-shared';
import './input.css';

interface RouteRow {
  readonly key: number;
  readonly id: string;
  readonly stationsText: string;
  readonly fareType: ExpenseFareTypeDto;
  readonly fareText: string;
  readonly bidirectional: boolean;
  readonly validFrom: string;
  readonly validTo: string;
  readonly note: string;
}

interface AliasRow { readonly key: number; readonly name: string; readonly aliasesText: string }

const STATION_SEPARATOR = ' > ';

export function splitStations(value: string): string[] {
  return value.split('>').map((station) => station.trim()).filter((station) => station !== '');
}

export function splitAliases(value: string): string[] {
  return value.split(/[,、，]/).map((alias) => alias.trim()).filter((alias) => alias !== '');
}

let rowSeq = 0;
const nextKey = () => { rowSeq += 1; return rowSeq; };

function toRouteRow(route: ExpenseFareRouteDto): RouteRow {
  return {
    key: nextKey(), id: route.id, stationsText: route.stations.join(STATION_SEPARATOR), fareType: route.fareType, fareText: String(route.fare),
    bidirectional: route.bidirectional, validFrom: route.validFrom ?? '', validTo: route.validTo ?? '', note: route.note ?? '',
  };
}

function toRouteDto(row: RouteRow): ExpenseFareRouteDto {
  const fare = row.fareText.trim() === '' ? Number.NaN : Number(row.fareText.replace(/[,，¥円\s]/g, ''));
  return {
    id: row.id, stations: splitStations(row.stationsText), fareType: row.fareType, fare, bidirectional: row.bidirectional,
    ...(row.validFrom === '' ? {} : { validFrom: row.validFrom }), ...(row.validTo === '' ? {} : { validTo: row.validTo }),
    ...(row.note.trim() === '' ? {} : { note: row.note.trim() }),
  };
}

function newRouteId(rows: readonly RouteRow[]): string {
  const used = new Set(rows.map((row) => row.id));
  let index = rows.length + 1;
  while (used.has(`route-${index}`)) index += 1;
  return `route-${index}`;
}

/** 台帳「運賃マスタ」。経路の表・駅名の別名・CSV 取込 / 出力（§20.10.1, §20.2.10）。 */
export function FaresLedger(props: ExpenseLedgerSlotProps) {
  const { text } = useI18n();
  const api = expenseInputApi(props.transport);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [loaded, setLoaded] = useState<{ readonly saved: boolean; readonly updatedAt: string }>();
  const [routes, setRoutes] = useState<readonly RouteRow[]>([]);
  const [aliases, setAliases] = useState<readonly AliasRow[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<{ readonly message: string; readonly row?: number }>();
  const [feedback, setFeedback] = useState<string>();
  const [exported, setExported] = useState<{ readonly fileName: string; readonly content: string }>();

  const apply = (table: ExpenseFareTableDto, saved: boolean) => {
    setRoutes(table.routes.map(toRouteRow));
    setAliases(table.stationAliases.map((alias) => ({ key: nextKey(), name: alias.name, aliasesText: alias.aliases.join(', ') })));
    setLoaded({ saved, updatedAt: table.updatedAt });
    setDirty(false);
  };

  const load = async () => {
    setLoadError(undefined);
    try {
      const result = await api.getFares(props.scope);
      apply(result.table, result.saved);
    } catch (cause: unknown) {
      setLoadError(messageOf(cause));
    }
  };

  useEffect(() => { void load(); }, [props.transport, props.scope]);

  useEffect(() => {
    if (props.focus?.section !== 'fares') return;
    headingRef.current?.scrollIntoView?.({ block: 'start' });
    headingRef.current?.focus();
  }, [props.focus?.seq, loaded === undefined]);

  const edit = () => { setDirty(true); setFeedback(undefined); };
  const updateRoute = (key: number, change: Partial<RouteRow>) => { setRoutes((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row))); edit(); };
  const updateAlias = (key: number, change: Partial<AliasRow>) => { setAliases((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row))); edit(); };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const stationAliases: ExpenseStationAliasDto[] = aliases
        .filter((alias) => alias.name.trim() !== '' || alias.aliasesText.trim() !== '')
        .map((alias) => ({ name: alias.name.trim(), aliases: splitAliases(alias.aliasesText) }));
      const table = await api.saveFares(props.scope, { routes: routes.map(toRouteDto), stationAliases });
      apply(table, true);
      setFeedback(text('Saved the fare table. Check the claims again to apply it.', '運賃マスタを保存しました。反映するには申請をもう一度チェックしてください。'));
    } catch (cause: unknown) {
      setError({ message: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    setError(undefined);
    setExported(undefined);
    try {
      const file = await api.exportFaresCsv(props.scope);
      if (!triggerDownload(file.fileName, file.content)) setExported(file);
    } catch (cause: unknown) {
      setError({ message: messageOf(cause) });
    }
  };

  const importCsv = async (file: File | undefined) => {
    if (file === undefined) return;
    setBusy(true);
    setError(undefined);
    setFeedback(undefined);
    try {
      const { content } = decodeCsvText(await readFileBytes(file));
      const table = await api.importFaresCsv(props.scope, content);
      apply(table, true);
      setFeedback(text(`Imported the routes from "${file.name}". Station aliases were kept.`, `「${file.name}」から経路を取り込みました。駅名の別名はそのままです。`));
    } catch (cause: unknown) {
      const row = rowOf(cause);
      setError({ message: messageOf(cause), ...(row === undefined ? {} : { row }) });
    } finally {
      setBusy(false);
    }
  };

  return <section className="workspace-card" aria-labelledby="expense-ledger-faresledger-heading">
    <div className="expense-row-between">
      <h2 id="expense-ledger-faresledger-heading" ref={headingRef} tabIndex={-1}>{text('Fare table', '運賃マスタ')}</h2>
      <div className="expense-actions">
        <button type="button" className="secondary" disabled={busy || loaded === undefined} onClick={() => void exportCsv()}>{text('Export fares CSV', '運賃 CSV を出力')}</button>
        <label className="secondary">{text('Import fares CSV', '運賃 CSV を取込')}
          <input type="file" accept=".csv,text/csv" disabled={busy || loaded === undefined} onChange={(event) => { void importCsv(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
      </div>
    </div>
    <p className="expense-input-limit">{text(
      'Fares are checked only when a route is registered here or the claimant has a commuter pass. Without a route map, overlaps through transfer routes that are not written in the station list (for example pass A > B > C and item A > D > C) cannot be detected.',
      '照合は、ここに経路があるか申請者に通勤定期があるときだけ動きます。路線図を持たないので、駅の並びに書かれていない乗換経路の重なり（定期 A > B > C と明細 A > D > C など）は検出できません。',
    )}</p>
    <p className="expense-input-hint">{text('CSV columns: id, stations (separated by " > "), fare_type, fare, bidirectional, valid_from, valid_to, note. Importing replaces the routes and keeps the aliases.', 'CSV の列: id, stations（「 > 」区切り）, fare_type, fare, bidirectional, valid_from, valid_to, note。取込は経路を置き換え、別名は残します。')}</p>

    {loadError !== undefined && <div className="notice-card" role="alert">
      <strong>{text('Could not load the fare table', '運賃マスタを読み込めませんでした')}</strong>
      <p>{loadError}</p>
      <div className="run-failure-actions"><button type="button" className="secondary" onClick={() => void load()}>{text('Retry', '再試行')}</button></div>
    </div>}
    {loaded === undefined && loadError === undefined && <p className="empty-state" role="status">{text('Loading the fare table…', '運賃マスタを読み込み中…')}</p>}
    {feedback !== undefined && <InlineFeedback kind="success">{feedback}</InlineFeedback>}
    {error !== undefined && <div className="api-error" role="alert">
      <p>{error.message}</p>
      {error.row !== undefined && <p>{text(`Fix row ${error.row} of the CSV and import it again.`, `CSV の ${error.row} 行目を直して、もう一度取り込んでください。`)}</p>}
    </div>}
    {exported !== undefined && <label>{text('The download did not start. Copy the CSV below.', 'ダウンロードを開始できませんでした。下の CSV をコピーしてください。')}
      <textarea className="expense-textarea" readOnly aria-label={text('Fares CSV', '運賃 CSV')} value={exported.content} />
    </label>}

    {loaded !== undefined && <>
      {dirty && <p className="notice-card" role="note">{text('You have unsaved changes to the fare table.', '運賃マスタに保存していない変更があります。')}</p>}
      <div className="expense-row-between">
        <h3>{text('Routes', '経路')}</h3>
        <div className="expense-actions">
          <button type="button" className="secondary" onClick={() => { setRoutes((current) => [...current, { key: nextKey(), id: newRouteId(current), stationsText: '', fareType: 'ic', fareText: '', bidirectional: true, validFrom: '', validTo: '', note: '' }]); edit(); }}>{text('Add a route', '経路を追加')}</button>
          <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? text('Saving…', '保存中…') : text('Save', '保存')}</button>
        </div>
      </div>
      {routes.length === 0
        ? <p className="empty-state">{text('No routes yet. Register the routes you often use to check transport fares.', '経路がありません。よく使う区間を登録すると交通費を照合できます')}</p>
        : <div className="table-wrap"><table className="expense-input-table">
          <thead><tr>
            <th>{text('Stations (from > via > to)', '駅の並び（出発 > 経由 > 到着）')}</th><th>{text('Fare type', '券種')}</th><th>{text('One-way fare (yen)', '片道運賃（円）')}</th>
            <th>{text('Both ways', '双方向')}</th><th>{text('Valid from', '有効期間（から）')}</th><th>{text('Valid to', '有効期間（まで）')}</th><th>{text('Note', 'メモ')}</th><th />
          </tr></thead>
          <tbody>{routes.map((row, index) => {
            const name = row.stationsText.trim() === '' ? text(`route ${index + 1}`, `経路 ${index + 1}`) : row.stationsText;
            const stationCount = splitStations(row.stationsText).length;
            return <tr key={row.key}>
              <td className="expense-input-stations">
                <input aria-label={text(`Stations of route ${index + 1}`, `経路 ${index + 1} の駅の並び`)} placeholder={text('Nakano > Shinjuku > Kasumigaseki', '中野 > 新宿 > 霞ケ関')} value={row.stationsText} onChange={(event) => updateRoute(row.key, { stationsText: event.target.value })} />
                {stationCount < 2 && <small className="expense-input-warn">{text('Enter at least 2 stations separated by " > ".', '「 > 」で区切って 2 駅以上を入力します。')}</small>}
              </td>
              <td><select aria-label={text(`Fare type of ${name}`, `${name} の券種`)} value={row.fareType} onChange={(event) => updateRoute(row.key, { fareType: event.target.value as ExpenseFareTypeDto })}>
                <option value="ic">IC</option><option value="ticket">{text('Ticket', '切符')}</option>
              </select></td>
              <td><input inputMode="numeric" aria-label={text(`Fare of ${name}`, `${name} の片道運賃`)} value={row.fareText} onChange={(event) => updateRoute(row.key, { fareText: event.target.value })} /></td>
              <td><input type="checkbox" aria-label={text(`${name} both ways`, `${name} は双方向`)} checked={row.bidirectional} onChange={(event) => updateRoute(row.key, { bidirectional: event.target.checked })} /></td>
              <td><input type="date" aria-label={text(`Valid from of ${name}`, `${name} の有効期間の開始`)} value={row.validFrom} onChange={(event) => updateRoute(row.key, { validFrom: event.target.value })} /></td>
              <td><input type="date" aria-label={text(`Valid to of ${name}`, `${name} の有効期間の終了`)} value={row.validTo} onChange={(event) => updateRoute(row.key, { validTo: event.target.value })} /></td>
              <td><input aria-label={text(`Note of ${name}`, `${name} のメモ`)} value={row.note} onChange={(event) => updateRoute(row.key, { note: event.target.value })} /></td>
              <td><button type="button" className="secondary danger" aria-label={text(`Remove ${name}`, `${name} を削除`)} onClick={() => { setRoutes((current) => current.filter((candidate) => candidate.key !== row.key)); edit(); }}>{text('Remove', '削除')}</button></td>
            </tr>;
          })}</tbody>
        </table></div>}

      <div className="expense-row-between">
        <h3>{text('Station aliases', '駅名の別名')}</h3>
        <button type="button" className="secondary" onClick={() => { setAliases((current) => [...current, { key: nextKey(), name: '', aliasesText: '' }]); edit(); }}>{text('Add an alias', '別名を追加')}</button>
      </div>
      <p className="expense-input-hint">{text('Absorb spelling variations such as "Kasumigaseki" and "Kasumigaseki Sta." by listing aliases under one representative name.', '「霞ケ関」「霞が関」のような表記揺れは、代表名に別名を足して吸収します。')}</p>
      {aliases.length === 0
        ? <p className="empty-state">{text('No station aliases.', '駅名の別名はありません。')}</p>
        : <div className="table-wrap"><table className="expense-input-table">
          <thead><tr><th>{text('Representative name', '代表名')}</th><th>{text('Aliases (comma separated)', '別名（カンマ区切り）')}</th><th /></tr></thead>
          <tbody>{aliases.map((row, index) => <tr key={row.key}>
            <td><input aria-label={text(`Representative name ${index + 1}`, `代表名 ${index + 1}`)} value={row.name} onChange={(event) => updateAlias(row.key, { name: event.target.value })} /></td>
            <td><input aria-label={text(`Aliases ${index + 1}`, `別名 ${index + 1}`)} value={row.aliasesText} onChange={(event) => updateAlias(row.key, { aliasesText: event.target.value })} /></td>
            <td><button type="button" className="secondary danger" aria-label={text(`Remove alias ${index + 1}`, `別名 ${index + 1} を削除`)} onClick={() => { setAliases((current) => current.filter((candidate) => candidate.key !== row.key)); edit(); }}>{text('Remove', '削除')}</button></td>
          </tr>)}</tbody>
        </table></div>}
    </>}
  </section>;
}
