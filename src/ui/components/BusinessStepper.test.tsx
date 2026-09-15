// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessStepper, type BusinessStep } from './BusinessStepper';

afterEach(cleanup);

type Id = 'setup' | 'run' | 'export';
const steps: readonly BusinessStep<Id>[] = [
  { id: 'setup', label: 'Setup', caption: 'Decide the rules', badge: '3 rules' },
  { id: 'run', label: 'Run', caption: 'Apply them' },
  { id: 'export', label: 'Export', caption: 'Hand the result over' },
];

describe('BusinessStepper', () => {
  it('正常: 並べた順に番号つきのタブが並び、間にだけ矢印が入る（読み上げからは外す）', () => {
    const { container } = render(<BusinessStepper steps={steps} active="run" onSelect={vi.fn()} label="Business steps" />);
    expect(screen.getByRole('tablist', { name: 'Business steps' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['Setup', 'Run', 'Export']);
    expect(tabs.map((tab) => tab.querySelector('.business-step-no')?.textContent)).toEqual(['1', '2', '3']);
    const arrows = container.querySelectorAll('.business-step-arrow');
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) expect(arrow.getAttribute('aria-hidden')).toBe('true');
  });

  it('正常: 選択中のタブだけが aria-selected と active を持つ', () => {
    render(<BusinessStepper steps={steps} active="run" onSelect={vi.fn()} label="Business steps" />);
    expect(screen.getAllByRole('tab').map((tab) => [tab.getAttribute('aria-selected'), tab.classList.contains('active')])).toEqual([['false', false], ['true', true], ['false', false]]);
  });

  it('正常: タブを押すとその id で選択を要求する', async () => {
    const onSelect = vi.fn();
    render(<BusinessStepper steps={steps} active="setup" onSelect={onSelect} label="Business steps" />);
    await userEvent.click(screen.getByRole('tab', { name: 'Export' }));
    expect(onSelect).toHaveBeenCalledWith('export');
  });

  it('境界: 件数は渡したときだけ出し、説明は常に出す', () => {
    const { container } = render(<BusinessStepper steps={steps} active="setup" onSelect={vi.fn()} label="Business steps" />);
    expect([...container.querySelectorAll('.business-step-badge')].map((badge) => badge.textContent)).toEqual(['3 rules']);
    expect(screen.getByText('Hand the result over')).toBeTruthy();
  });

  it('境界: 1 段だけなら矢印は出ない', () => {
    const { container } = render(<BusinessStepper steps={[steps[0]!]} active="setup" onSelect={vi.fn()} label="Business steps" />);
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(container.querySelectorAll('.business-step-arrow')).toHaveLength(0);
  });

  it('例外: 選択中の id が手順に無くても描画でき、どれも選択中にならない', () => {
    render(<BusinessStepper<string> steps={steps} active="missing" onSelect={vi.fn()} label="Business steps" />);
    expect(screen.getAllByRole('tab').every((tab) => tab.getAttribute('aria-selected') === 'false')).toBe(true);
  });
});
