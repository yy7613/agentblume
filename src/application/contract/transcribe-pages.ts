/**
 * application層: 契約書のページ画像を vision で文字起こしする（docs/23 §3.1。`contract-transcribe/v1`。**保存しない**）。
 *
 * 文字起こしと条項抽出を分けるのは、vision の遅さ（12B 級で 1 ページ 17〜19 秒）を**ページ数に比例する 1 回きりの費用**に
 * 閉じ込め、繰り返し走る抽出と再レビューを速いテキスト処理に寄せるため（ADR-0042 §1）。
 * 画面は 1 ページずつ呼び、結果をページ単位で溜める（中断しても読めたページは残る）。
 *
 * 応答は構造化出力にしない（本文をそのまま写させたいので素のテキストで受ける）。能力は vision だけを要る。
 */
import { ContractDomainError } from '../../domain/contract/errors';
import type { ModelRequestMessage } from '../model/model-provider';
import type { PromptCatalogPort, PromptSpec } from '../prompt/prompt-catalog-port';
import type { ContractModelGate } from './support';

/** プロンプトファイル（v48 / ADR-0052）。文面は `prompts/contract/transcribe.md`、版はそのファイルの frontmatter が正。 */
export const CONTRACT_TRANSCRIBE_PROMPT: PromptSpec = { id: 'contract/transcribe', sections: ['system'] };
export const TRANSCRIBE_MAX_IMAGES = 4;
export const TRANSCRIBE_IMAGE_MAX_CHARS = 4_200_000;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,/u;

export interface TranscribedPage {
  readonly index: number;
  readonly text: string;
  readonly warnings: readonly string[];
}

export interface TranscribeResult {
  readonly pages: readonly TranscribedPage[];
  readonly promptTemplateVersion: string;
  readonly model?: { readonly provider: string; readonly model: string };
}

/** モデルがコードブロックで囲んで返したときだけ外す（本文には触れない）。 */
function unfence(text: string): string {
  const match = /^```[a-z]*\n([\s\S]*?)\n```$/u.exec(text.trim());
  return match === null ? text.trim() : match[1]!;
}

export class TranscribeContractPagesUseCase {
  constructor(
    private readonly gate: ContractModelGate,
    private readonly promptCatalog: PromptCatalogPort,
  ) {}

  async execute(input: { readonly images: readonly string[]; readonly fileName?: string }, signal?: AbortSignal): Promise<TranscribeResult> {
    if (input.images.length === 0 || input.images.length > TRANSCRIBE_MAX_IMAGES) throw new ContractDomainError(`transcribe contract pages: send 1 to ${TRANSCRIBE_MAX_IMAGES} page images (received ${input.images.length})`);
    input.images.forEach((image, index) => {
      if (typeof image !== 'string' || !IMAGE_DATA_URL.test(image)) throw new ContractDomainError(`transcribe contract pages: images[${index}] must be a base64 data URL of image/png, image/jpeg, image/webp or image/gif`);
      if (image.length > TRANSCRIBE_IMAGE_MAX_CHARS) throw new ContractDomainError(`transcribe contract pages: images[${index}] must be at most ${TRANSCRIBE_IMAGE_MAX_CHARS} characters; shrink the page image before sending it`);
    });
    await this.gate.assertVision();
    const template = this.promptCatalog.get(CONTRACT_TRANSCRIBE_PROMPT.id);
    const pages: TranscribedPage[] = [];
    for (const [index, image] of input.images.entries()) {
      const messages: readonly ModelRequestMessage[] = [
        { role: 'system', content: template.render('system') },
        { role: 'user', content: [{ type: 'text', text: `文脈: ${JSON.stringify({ promptTemplateVersion: template.version, page: index + 1, ...(input.fileName === undefined ? {} : { fileName: input.fileName }) })}` }, { type: 'image_url', imageUrl: image }] },
      ];
      const completion = await this.gate.model.complete({ messages, temperature: 0 }, signal);
      const text = unfence(completion.message.content ?? '');
      const warnings: string[] = [];
      if (text === '') warnings.push('このページから文字を読み取れませんでした。画像が鮮明か確かめるか、テキストを貼り付けてください。');
      if (text.includes('〓')) warnings.push(`読めない文字が ${[...text].filter((char) => char === '〓').length} 文字あります（〓 の箇所）。原本を見て直してください。`);
      pages.push({ index, text, warnings });
    }
    const model = await this.gate.snapshot();
    return { pages, promptTemplateVersion: template.version, ...(model === undefined ? {} : { model }) };
  }
}
