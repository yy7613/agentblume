/**
 * ドメイン: 証憑本体（ExpenseReceipt）集約（docs/21 §2.6）。
 *
 * 申請から分けるのは、画像の data URL を申請の一覧・判定・ツールで読み込まないため。
 * `sha256` は application が画像のバイト列から計算して渡す（同一画像の重複 `duplicate-receipt-image` に使う）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { TenantScope } from '../shared/tenant-scope';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { ExpenseDomainError } from './errors';
import type { ExpenseClaimId, ExpenseItemId, ExpenseReceiptId } from './ids';

/** 証憑本体 1 件の上限（仕訳の `DOCUMENT_PAYLOAD_MAX_BYTES` と同じ値を経費側の定数として持つ）。 */
export const RECEIPT_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const RECEIPT_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export interface ExpenseReceiptSource {
  readonly type: 'image' | 'pdf';
  readonly fileName?: string;
  readonly mime?: string;
  /** 画像（PDF はブラウザでページ画像化したもの）。 */
  readonly dataUrl: string;
  /** PDF のテキスト層。 */
  readonly text?: string;
}

export interface ExpenseReceipt {
  readonly tenant: TenantScope;
  readonly id: ExpenseReceiptId;
  readonly claimId: ExpenseClaimId;
  readonly itemId: ExpenseItemId;
  readonly source: ExpenseReceiptSource;
  readonly sha256: string;
  readonly createdAt: IsoDateTime;
}

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

export function createExpenseReceipt(props: ExpenseReceipt): ExpenseReceipt {
  if (props === null || typeof props !== 'object') throw fail('expense receipt: props are required');
  if (props.tenant === null || typeof props.tenant !== 'object') throw fail('expense receipt: tenant is required');
  assertNonEmpty(props.tenant.tenantId, 'expense receipt: tenant.tenantId', fail);
  assertNonEmpty(props.tenant.workspaceId, 'expense receipt: tenant.workspaceId', fail);
  assertNonEmpty(props.id, 'expense receipt: id', fail);
  assertNonEmpty(props.claimId, 'expense receipt: claimId', fail);
  assertNonEmpty(props.itemId, 'expense receipt: itemId', fail);
  const source = props.source as unknown as Record<string, unknown> | null;
  if (source === null || typeof source !== 'object') throw fail('expense receipt: source is required');
  if (source['type'] !== 'image' && source['type'] !== 'pdf') throw fail('expense receipt: source.type must be image or pdf');
  if (typeof source['dataUrl'] !== 'string' || source['dataUrl'].length > RECEIPT_PAYLOAD_MAX_BYTES || !RECEIPT_DATA_URL_PATTERN.test(source['dataUrl'])) {
    throw fail(`expense receipt: source.dataUrl must be a base64 data URL of image/png, image/jpeg, image/webp or image/gif of at most ${RECEIPT_PAYLOAD_MAX_BYTES} bytes`);
  }
  for (const key of ['fileName', 'mime', 'text'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'string') throw fail(`expense receipt: source.${key} must be a string`);
  }
  if (typeof source['text'] === 'string' && source['text'].length > RECEIPT_PAYLOAD_MAX_BYTES) throw fail(`expense receipt: source.text must be at most ${RECEIPT_PAYLOAD_MAX_BYTES} characters`);
  if (typeof props.sha256 !== 'string' || !SHA256_PATTERN.test(props.sha256)) throw fail('expense receipt: sha256 must be 64 lowercase hex characters');
  assertIsoDateTime(props.createdAt, 'expense receipt: createdAt', fail);
  return {
    tenant: { tenantId: props.tenant.tenantId, workspaceId: props.tenant.workspaceId },
    id: props.id,
    claimId: props.claimId,
    itemId: props.itemId,
    source: {
      type: source['type'],
      ...(typeof source['fileName'] === 'string' ? { fileName: source['fileName'] } : {}),
      ...(typeof source['mime'] === 'string' ? { mime: source['mime'] } : {}),
      dataUrl: source['dataUrl'],
      ...(typeof source['text'] === 'string' ? { text: source['text'] } : {}),
    },
    sha256: props.sha256,
    createdAt: props.createdAt,
  };
}
