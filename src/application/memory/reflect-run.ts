/**
 * application層: Run 相当の対話から記憶提案を抽出する（v21 実装契約 §3 / ADR-0016 M2）
 *
 * 成功した対話（input/output）を LLM に振り返らせ、(a) 再利用可能な宣言的知識の
 * Wiki ノート、(b) 対象 Skill があれば手続き的知識の instructions 改訂、を draft 提案として作る。
 * 承認は別ユースケース（ReviewProposal）。ここでは書き込まず提案のみ生成する。
 */
import { randomUUID } from 'node:crypto';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { WikiPageId, WikiSpaceId } from '../../domain/memory/ids';
import type { RunId } from '../../domain/run/ids';
import type { SkillId } from '../../domain/skill/ids';
import { MemoryDomainError } from '../../domain/memory/errors';
import { createMemoryProposal, type MemoryProposal } from '../../domain/memory/memory-proposal';
import type { MemoryProposalRepository } from '../../domain/memory/memory-proposal-repository';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import type { WikiPage } from '../../domain/memory/wiki-page';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { Skill } from '../../domain/skill/skill';
import type { JsonSchemaObject, ModelMessage, ModelProviderPort } from '../model/model-provider';
import { DEFAULT_WIKI_ID } from '../../domain/memory/wiki-space';

export interface ReflectRunInput {
  readonly scope: TenantScope;
  readonly input: string;
  readonly output: string;
  readonly sourceRunId?: RunId;
  /** 指定時、その Skill の現行 instructions を改訂対象にできる。 */
  readonly targetSkillId?: SkillId;
  /** 指定時、その既存 Wiki ページの改訂案にする（未指定は新規ページ案）。 */
  readonly existingWikiPageId?: WikiPageId;
  readonly targetWikiId?: WikiSpaceId;
}

/** 反省の構造化出力（flat・required 全部・additionalProperties:false）。 */
export const REFLECTION_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    wikiShouldPropose: { type: 'boolean', description: 'true to propose a reusable knowledge wiki note.' },
    wikiTitle: { type: 'string', description: 'Short title of the wiki note.' },
    wikiTags: { type: 'string', description: 'Comma-separated tags (e.g. "sql, cohort").' },
    wikiBody: { type: 'string', description: 'The reusable knowledge, concise and self-contained.' },
    wikiSummary: { type: 'string', description: 'One line describing what this note captures / changes.' },
    skillShouldPropose: { type: 'boolean', description: 'true to propose an improved skill instructions revision.' },
    skillInstructions: { type: 'string', description: 'Full revised instructions for the target skill.' },
    skillSummary: { type: 'string', description: 'One line describing the instructions change.' },
  },
  required: ['wikiShouldPropose', 'wikiTitle', 'wikiTags', 'wikiBody', 'wikiSummary', 'skillShouldPropose', 'skillInstructions', 'skillSummary'],
  additionalProperties: false,
};

interface Reflection {
  readonly wikiShouldPropose: boolean;
  readonly wikiTitle: string;
  readonly wikiTags: string;
  readonly wikiBody: string;
  readonly wikiSummary: string;
  readonly skillShouldPropose: boolean;
  readonly skillInstructions: string;
  readonly skillSummary: string;
}

function parseReflection(content: string | null): Reflection | null {
  if (content === null) return null;
  let value: unknown;
  try { value = JSON.parse(content); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const str = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const bool = (k: string): boolean | null => (typeof r[k] === 'boolean' ? (r[k] as boolean) : null);
  const wikiShouldPropose = bool('wikiShouldPropose');
  const skillShouldPropose = bool('skillShouldPropose');
  const wikiTitle = str('wikiTitle'); const wikiTags = str('wikiTags'); const wikiBody = str('wikiBody'); const wikiSummary = str('wikiSummary');
  const skillInstructions = str('skillInstructions'); const skillSummary = str('skillSummary');
  if (wikiShouldPropose === null || skillShouldPropose === null || wikiTitle === null || wikiTags === null || wikiBody === null || wikiSummary === null || skillInstructions === null || skillSummary === null) {
    return null;
  }
  return { wikiShouldPropose, wikiTitle, wikiTags, wikiBody, wikiSummary, skillShouldPropose, skillInstructions, skillSummary };
}

const splitTags = (raw: string): readonly string[] => raw.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0);
const filled = (value: string): boolean => value.trim().length > 0;

export class ReflectRunUseCase {
  constructor(
    private readonly model: ModelProviderPort,
    private readonly proposals: MemoryProposalRepository,
    private readonly wiki: WikiRepository,
    private readonly skills: SkillRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: ReflectRunInput, signal?: AbortSignal): Promise<MemoryProposal[]> {
    if (!filled(input.input)) throw new MemoryDomainError('ReflectRun: input must be non-empty');
    if (!filled(input.output)) throw new MemoryDomainError('ReflectRun: output must be non-empty');

    const existingWiki = input.existingWikiPageId !== undefined ? await this.wiki.find(input.scope, input.existingWikiPageId) : null;
    const targetWikiId = existingWiki?.wikiId ?? input.targetWikiId ?? DEFAULT_WIKI_ID;
    if (input.targetWikiId !== undefined && existingWiki !== null && (existingWiki.wikiId ?? DEFAULT_WIKI_ID) !== input.targetWikiId) throw new MemoryDomainError('ReflectRun: existing page does not belong to target wiki');
    if (input.targetWikiId !== undefined && await this.wiki.findSpace(input.scope, input.targetWikiId) === null) throw new MemoryDomainError(`ReflectRun: target wiki not found: ${input.targetWikiId}`);
    const skill = input.targetSkillId !== undefined ? await this.skills.findLatest(input.scope, input.targetSkillId) : null;

    const reflection = await this.reflect(input, existingWiki, skill, signal);
    const createdAt = this.now().toISOString();
    const sourceRun = input.sourceRunId;
    const result: MemoryProposal[] = [];

    if (reflection.wikiShouldPropose && filled(reflection.wikiTitle) && filled(reflection.wikiBody)) {
      result.push(createMemoryProposal({
        id: this.makeId(),
        tenant: input.scope,
        target: {
          kind: 'wiki',
          wikiId: targetWikiId,
          pageId: existingWiki?.id ?? this.makeId(),
          isNewPage: existingWiki === null,
          title: reflection.wikiTitle,
          tags: splitTags(reflection.wikiTags),
          body: reflection.wikiBody,
        },
        summary: filled(reflection.wikiSummary) ? reflection.wikiSummary : reflection.wikiTitle,
        ...(sourceRun !== undefined ? { sourceRun } : {}),
        createdAt,
      }));
    }

    if (reflection.skillShouldPropose && skill !== null && filled(reflection.skillInstructions)) {
      result.push(createMemoryProposal({
        id: this.makeId(),
        tenant: input.scope,
        target: { kind: 'skill', skillId: skill.metadata.internalId, instructions: reflection.skillInstructions },
        summary: filled(reflection.skillSummary) ? reflection.skillSummary : `Refine ${skill.metadata.displayName} instructions`,
        ...(sourceRun !== undefined ? { sourceRun } : {}),
        createdAt,
      }));
    }

    for (const proposal of result) await this.proposals.save(proposal);
    return result;
  }

  private async reflect(input: ReflectRunInput, existingWiki: WikiPage | null, skill: Skill | null, signal?: AbortSignal): Promise<Reflection> {
    const system = [
      'You curate an agent\'s long-term memory. Given one successful interaction, extract durable, reusable knowledge.',
      '- Propose a wiki note only for knowledge that generalizes beyond this single request. Set wikiShouldPropose=false otherwise.',
      skill !== null
        ? '- If the target skill\'s instructions could be improved by what this interaction revealed, propose a full revised instructions text; else skillShouldPropose=false.'
        : '- There is no target skill; set skillShouldPropose=false and leave skill fields empty.',
      'Do not fabricate. Be concise. Follow the JSON schema exactly.',
    ].join('\n');
    const context = [
      `User input:\n${input.input}`,
      `Agent output:\n${input.output}`,
      existingWiki !== null ? `Existing wiki page "${existingWiki.title}" (propose a revision of it):\n${existingWiki.body}` : '',
      skill !== null ? `Target skill "${skill.metadata.displayName}" current instructions:\n${skill.instructions}` : '',
    ].filter((part) => part.length > 0).join('\n\n');
    const messages: ModelMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: context },
    ];
    const request = { messages, responseFormat: { name: 'memory_reflection', strict: true, schema: REFLECTION_SCHEMA } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const completion = await this.model.complete(request, signal);
      const parsed = parseReflection(completion.message.content);
      if (parsed !== null) return parsed;
    }
    throw new MemoryDomainError('ReflectRun: model returned invalid reflection JSON twice');
  }
}
