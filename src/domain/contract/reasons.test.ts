import { describe, expect, it } from 'vitest';
import { ContractDocumentNotFoundError, ContractDomainError, ContractPlaybookNotFoundError, ContractReviewNotFoundError, ContractStateError, SignedContractNotFoundError } from './errors';
import { isReasonCode, REASON_CODES, REASON_SEVERITY } from './reasons';
import { CONTRACT_NATURES, isOneOf } from './vocabulary';

describe('reasons: 理由コードと重大度', () => {
  it('正常: すべての理由コードに重大度があり、表に余分なキーが無い', () => {
    expect(Object.keys(REASON_SEVERITY).sort()).toEqual([...REASON_CODES].sort());
  });

  it.each([
    ['clause-missing', 'onFail'], ['criterion-failed', 'onFail'], ['quote-not-found', 'unresolved'], ['payment-basis-acceptance', 'warning'],
    ['deadline-mismatch', 'warning'], ['stamp-duty-candidate', 'info'], ['review-stale', 'warning'],
  ] as const)('正常: %s は %s（docs/23 §4.5）', (code, severity) => {
    expect(REASON_SEVERITY[code]).toBe(severity);
  });

  it.each([
    ['clause-missing', true], ['unknown-field', false], [1, false], [null, false],
  ])('境界: isReasonCode(%s) = %s', (value, expected) => {
    expect(isReasonCode(value)).toBe(expected);
  });
});

describe('vocabulary: isOneOf', () => {
  it.each([
    ['ukeoi', true], ['UKEOI', false], [0, false], [undefined, false],
  ])('境界: isOneOf(CONTRACT_NATURES, %s) = %s', (value, expected) => {
    expect(isOneOf(CONTRACT_NATURES, value)).toBe(expected);
  });
});

describe('errors: エラー型', () => {
  it('正常: ContractDomainError は code と details を持つ', () => {
    const error = new ContractDomainError('bad', { undecidedTopicIds: ['a'] });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'ContractDomainError', code: 'CONTRACT_DOMAIN', message: 'bad', details: { undecidedTopicIds: ['a'] } });
  });

  it('正常: ContractStateError は開く場所（target）を持つ', () => {
    expect(new ContractStateError('busy', { documentId: 'd1' })).toMatchObject({ name: 'ContractStateError', code: 'CONTRACT_STATE', target: { documentId: 'd1' } });
  });

  it.each([
    [ContractPlaybookNotFoundError, 'CONTRACT_PLAYBOOK_NOT_FOUND'],
    [ContractDocumentNotFoundError, 'CONTRACT_DOCUMENT_NOT_FOUND'],
    [ContractReviewNotFoundError, 'CONTRACT_REVIEW_NOT_FOUND'],
    [SignedContractNotFoundError, 'CONTRACT_SIGNED_NOT_FOUND'],
  ])('正常: %o の code は %s', (ErrorClass, code) => {
    const error = new ErrorClass('missing');
    expect(error.code).toBe(code);
    expect(error.name).toBe(ErrorClass.name);
    expect(error.message).toBe('missing');
  });
});
