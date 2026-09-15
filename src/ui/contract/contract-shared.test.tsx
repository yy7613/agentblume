// @vitest-environment jsdom
/**
 * 契約画面の共通部品。守りたいのは「原因 → 次の一手 → その場所のボタン」が code ごとに正しく出ること。
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/tool-api';
import { consumePendingOpen } from '../navigation';
import { ApiFailure, Field, isAbort, LegalNotice, messageOf, ReasonCard, VerdictChip } from './contract-shared';

afterEach(() => { cleanup(); consumePendingOpen('Settings'); });

describe('messageOf / isAbort', () => {
  it('正常: Error はメッセージ、それ以外は文字列化する', () => {
    expect(messageOf(new Error('boom'))).toBe('boom');
    expect(messageOf(42)).toBe('42');
  });

  it('境界: name が AbortError の Error だけを中断とみなす', () => {
    expect(isAbort(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbort(new Error('x'))).toBe(false);
    expect(isAbort({ name: 'AbortError' })).toBe(false);
  });
});

describe('LegalNotice / VerdictChip / Field', () => {
  it('正常: 既定の固定文言か、サーバーの文言を出す', () => {
    const { rerender } = render(<LegalNotice />);
    expect(screen.getByRole('note').textContent).toContain('It is not legal advice');
    rerender(<LegalNotice notice="サーバーの注意書き" />);
    expect(screen.getByRole('note').textContent).toBe('サーバーの注意書き');
  });

  it('正常: 判定チップは判定ごとのクラスとラベルを持つ', () => {
    render(<VerdictChip verdict="negotiate" />);
    const chip = screen.getByText('Negotiate');
    expect(chip.className).toContain('contract-verdict-negotiate');
  });

  it('境界: Field は hint があるときだけ補足を出す', () => {
    const { rerender } = render(<Field label="L"><input /></Field>);
    expect(document.querySelector('small')).toBeNull();
    rerender(<Field label="L" hint="補足"><input /></Field>);
    expect(screen.getByText('補足')).toBeTruthy();
  });
});

describe('ReasonCard', () => {
  it('正常: 理由コードの原因・次の一手を出し、ボタンで行き先を親へ渡す', async () => {
    const onAction = vi.fn();
    render(<ReasonCard code="unknown-topic" criterionId="c-1" onAction={onAction} />);
    expect(screen.getByText(/A criterion refers to a clause type/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open the criterion' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'step', step: 'playbook', nodeId: 'c-1' }));
  });
});

describe('ApiFailure', () => {
  it('異常: ApiError でない失敗はメッセージだけでボタンを出さない', () => {
    render(<ApiFailure cause="ただの失敗" />);
    expect(screen.getByRole('alert').textContent).toBe('ただの失敗');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('異常: モデルが使えない 409 は設定への導線と、onStep があれば貼り付け取込への導線を出す', async () => {
    const onStep = vi.fn();
    const cause = new ApiError(409, 'CONTRACT_EXTRACTION_UNAVAILABLE', 'no structured output model');
    render(<ApiFailure cause={cause} onStep={onStep}><button type="button">追加</button></ApiFailure>);
    expect(screen.getByRole('button', { name: '追加' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Change the model in Settings' }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
    await userEvent.click(screen.getByRole('button', { name: 'Paste the text and import it' }));
    expect(onStep).toHaveBeenCalledWith('import');
  });

  it('境界: onStep が無ければ貼り付け取込のボタンは出さない（取込画面の中など行き先が無い場所）', () => {
    render(<ApiFailure cause={new ApiError(409, 'CONTRACT_EXTRACTION_UNAVAILABLE', '')} />);
    expect(screen.getByRole('button', { name: 'Change the model in Settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Paste the text and import it' })).toBeNull();
  });

  it('異常: 状態の衝突で contractId があれば「台帳で開く」でその契約を渡す', async () => {
    const onStep = vi.fn();
    render(<ApiFailure cause={new ApiError(409, 'CONTRACT_STATE', 'already signed', undefined, { details: { contractId: 'con-9' } })} onStep={onStep} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open it in the ledger' }));
    expect(onStep).toHaveBeenCalledWith('ledger', 'con-9');
  });

  it('境界: 状態の衝突でも contractId が文字列でなければ台帳ボタンを出さない', () => {
    render(<ApiFailure cause={new ApiError(409, 'CONTRACT_STATE', 'x', undefined, { details: { contractId: 1 } })} onStep={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open it in the ledger' })).toBeNull();
  });

  it('正常: サーバーの原文が表示文と違えば補足として出す', () => {
    const cause = new ApiError(500, 'INTERNAL', 'raw detail from server');
    render(<ApiFailure cause={cause} />);
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('strong')?.textContent).toBe(cause.message);
    // 表示文は見出し（原文の翻訳を含む）なので、原文と同一でない限り補足に原文を残す。
    expect(alert.querySelector('small')?.textContent ?? null).toBe(cause.message === cause.serverMessage ? null : 'raw detail from server');
  });

  it('境界: サーバーの原文が空なら補足を出さない', () => {
    render(<ApiFailure cause={new ApiError(500, 'INTERNAL', '')} />);
    expect(screen.getByRole('alert').querySelector('small')).toBeNull();
  });
});
