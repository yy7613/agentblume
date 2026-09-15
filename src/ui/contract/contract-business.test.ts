import { describe, expect, it } from 'vitest';
import { contractBusiness } from './contract-business';

describe('contractBusiness', () => {
  it('正常: 画面が使える状態なので一覧に並べ、ヘルプに手順と設計書を載せる', () => {
    expect(contractBusiness).toMatchObject({ id: 'contract', screen: 'Contract', listed: true, card: { order: 40 }, help: { doc: 'docs/23-contract.md' } });
    expect(contractBusiness.help.steps.length).toBeGreaterThanOrEqual(5);
    // 法的助言ではないことをヘルプの説明にも書く。
    expect(contractBusiness.help.summary.ja).toContain('法的な判断ではありません');
    expect(contractBusiness.help.summary.en).toContain('not legal advice');
  });

  it('正常: 画面は動的 import で読み込む', async () => {
    const page = await contractBusiness.loadPage();
    expect(page.name).toBe('ContractPage');
  });
});
