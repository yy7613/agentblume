import { describe, expect, it } from 'vitest';
import { ContractExtractionSchemaError, ContractExtractionUnavailableError } from '../application/contract/errors';
import {
  ContractDocumentNotFoundError, ContractDomainError, ContractPlaybookNotFoundError, ContractReviewNotFoundError,
  ContractStateError, SignedContractNotFoundError,
} from '../domain/contract/errors';
import { contractHttpError } from './contract-error-mapping';

describe('contractHttpError', () => {
  it.each([
    [new ContractPlaybookNotFoundError('p'), 404, 'CONTRACT_PLAYBOOK_NOT_FOUND'],
    [new ContractDocumentNotFoundError('d'), 404, 'CONTRACT_DOCUMENT_NOT_FOUND'],
    [new ContractReviewNotFoundError('r'), 404, 'CONTRACT_REVIEW_NOT_FOUND'],
    [new SignedContractNotFoundError('s'), 404, 'CONTRACT_SIGNED_NOT_FOUND'],
    [new ContractDomainError('bad'), 400, 'CONTRACT_DOMAIN'],
    [new ContractStateError('signed'), 409, 'CONTRACT_STATE'],
    [new ContractExtractionUnavailableError('no model'), 409, 'CONTRACT_EXTRACTION_UNAVAILABLE'],
    [new ContractExtractionSchemaError('broken', ['a']), 502, 'CONTRACT_EXTRACTION_SCHEMA'],
  ] as const)('正常: %s → %i %s', (error, status, code) => {
    expect(contractHttpError(error)).toMatchObject({ status, body: { error: { code, message: error.message } } });
  });

  it('正常: 「直す場所」の項目（未判断のトピック・文書 / 契約 / レビューの id）を本文に載せる', () => {
    expect(contractHttpError(new ContractDomainError('undecided', { undecidedTopicIds: ['term'] }))?.body.error).toMatchObject({ undecidedTopicIds: ['term'] });
    expect(contractHttpError(new ContractStateError('signed', { documentId: 'd1', contractId: 'c1' }))?.body.error).toMatchObject({ documentId: 'd1', contractId: 'c1' });
  });

  it('例外: 契約のエラーでなければ undefined（他の業務・共通の写像へ回す）', () => {
    expect(contractHttpError(new Error('other'))).toBeUndefined();
    expect(contractHttpError('string')).toBeUndefined();
  });
});
