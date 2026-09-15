/**
 * application層: 審査基準（プレイブック）の一覧・取得・保存・削除・テンプレートからの作成（docs/23 §6）。
 *
 * - 0 件のときは既定テンプレートを**保存せずに**返す（仕訳の科目マスタと同じ規律。開いただけでデータを作らない）。
 * - ワークスペースで既定は 1 つ。`isDefault: true` の保存は他の既定を同じトランザクションで外す。
 */
import { ContractDomainError, ContractPlaybookNotFoundError } from '../../domain/contract/errors';
import { createPlaybook, toPlaybookSummary, type ClauseTopic, type ExtractionSettings, type Playbook, type PlaybookCriterion, type PlaybookSummary } from '../../domain/contract/playbook';
import { DEFAULT_TEMPLATE_ID, findPlaybookTemplate, PLAYBOOK_TEMPLATES, playbookFromTemplate } from '../../domain/contract/playbook-templates';
import type { ContractPlaybookRepository } from '../../domain/contract/repositories';
import type { LegalSettings } from '../../domain/contract/legal-checks';
import type { StampDutySettings } from '../../domain/contract/stamp-duty';
import type { OurRole } from '../../domain/contract/vocabulary';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import { randomId, systemClock, type Clock, type IdGenerator } from './support';

/** 未保存の既定テンプレートを返すときの id（保存すると新しい id が振られる）。 */
export const UNSAVED_DEFAULT_PLAYBOOK_ID = 'template-default';

function unsavedDefault(scope: TenantScope, now: string): Playbook {
  return playbookFromTemplate(findPlaybookTemplate(DEFAULT_TEMPLATE_ID)!, { tenant: scope, id: UNSAVED_DEFAULT_PLAYBOOK_ID, isDefault: true, now });
}

/**
 * 使う審査基準を決める。id 指定があればそれ（無ければ 404）、無ければ既定 → 最初の 1 件 → 未保存の既定テンプレート。
 * 組込みツール・レビュー・締結登録が同じ規則を使う。
 */
export class ContractPlaybookResolver {
  constructor(private readonly playbooks: ContractPlaybookRepository, private readonly clock: Clock = systemClock) {}

  async resolve(scope: TenantScope, playbookId?: string): Promise<{ readonly playbook: Playbook; readonly unsaved: boolean }> {
    if (playbookId !== undefined && playbookId !== UNSAVED_DEFAULT_PLAYBOOK_ID) {
      const found = await this.playbooks.findById(scope, playbookId);
      if (found === null) throw new ContractPlaybookNotFoundError(`contract playbook not found: ${playbookId}`);
      return { playbook: found, unsaved: false };
    }
    const all = await this.playbooks.list(scope);
    const chosen = all.find((playbook) => playbook.isDefault) ?? all[0];
    return chosen === undefined ? { playbook: unsavedDefault(scope, this.clock().toISOString()), unsaved: true } : { playbook: chosen, unsaved: false };
  }
}

export class ListContractPlaybooksUseCase {
  constructor(private readonly playbooks: ContractPlaybookRepository, private readonly clock: Clock = systemClock) {}

  async execute(scope: TenantScope): Promise<{ readonly playbooks: readonly PlaybookSummary[]; readonly unsaved: boolean }> {
    const all = await this.playbooks.list(scope);
    if (all.length === 0) return { playbooks: [toPlaybookSummary(unsavedDefault(scope, this.clock().toISOString()))], unsaved: true };
    return { playbooks: all.map(toPlaybookSummary), unsaved: false };
  }
}

export class GetContractPlaybookUseCase {
  constructor(private readonly resolver: ContractPlaybookResolver) {}

  async execute(scope: TenantScope, id: string): Promise<{ readonly playbook: Playbook; readonly unsaved: boolean }> {
    return this.resolver.resolve(scope, id);
  }
}

export interface SavePlaybookInput {
  readonly scope: TenantScope;
  /** 省略（または未保存の既定テンプレートの id）で新規。 */
  readonly id?: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly ourRole: OurRole;
  readonly ourCompanyNames: readonly string[];
  readonly topics: readonly ClauseTopic[];
  readonly criteria: readonly PlaybookCriterion[];
  readonly legal: LegalSettings;
  readonly stampDuty: StampDutySettings;
  readonly extraction: ExtractionSettings;
  readonly templateId?: string;
}

/** 既定の付け替え。保存したものが既定なら他を外し、既定が 1 つも無くなるなら保存したものを既定にする。 */
async function saveWithDefault(playbooks: ContractPlaybookRepository, unitOfWork: UnitOfWorkPort, playbook: Playbook, now: string): Promise<Playbook> {
  return unitOfWork.withTransaction(async () => {
    const others = (await playbooks.list(playbook.tenant)).filter((entry) => entry.id !== playbook.id);
    const saved = !playbook.isDefault && !others.some((entry) => entry.isDefault) ? createPlaybook({ ...playbook, isDefault: true }) : playbook;
    if (saved.isDefault) {
      for (const other of others.filter((entry) => entry.isDefault)) await playbooks.save(createPlaybook({ ...other, isDefault: false, updatedAt: now }));
    }
    await playbooks.save(saved);
    return saved;
  });
}

export class SaveContractPlaybookUseCase {
  constructor(
    private readonly playbooks: ContractPlaybookRepository,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = randomId,
  ) {}

  async execute(input: SavePlaybookInput): Promise<Playbook> {
    const now = this.clock().toISOString();
    const existing = input.id === undefined || input.id === UNSAVED_DEFAULT_PLAYBOOK_ID ? null : await this.playbooks.findById(input.scope, input.id);
    if (input.id !== undefined && input.id !== UNSAVED_DEFAULT_PLAYBOOK_ID && existing === null) throw new ContractPlaybookNotFoundError(`contract playbook not found: ${input.id}`);
    const playbook = createPlaybook({
      tenant: input.scope,
      id: existing?.id ?? this.ids(),
      name: input.name, isDefault: input.isDefault, ourRole: input.ourRole, ourCompanyNames: input.ourCompanyNames,
      topics: input.topics, criteria: input.criteria, legal: input.legal, stampDuty: input.stampDuty, extraction: input.extraction,
      ...((input.templateId ?? existing?.templateId) === undefined ? {} : { templateId: (input.templateId ?? existing?.templateId)! }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return saveWithDefault(this.playbooks, this.unitOfWork, playbook, now);
  }
}

export class DeleteContractPlaybookUseCase {
  constructor(private readonly playbooks: ContractPlaybookRepository) {}

  /** レビューは判定時の写しを持つので、基準を消しても過去のレビューは壊れない。 */
  async execute(scope: TenantScope, id: string): Promise<void> {
    if (!await this.playbooks.delete(scope, id)) throw new ContractPlaybookNotFoundError(`contract playbook not found: ${id}`);
  }
}

export interface PlaybookTemplateSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly ourRole: OurRole;
  readonly topicCount: number;
  readonly criterionCount: number;
}

export class ListPlaybookTemplatesUseCase {
  execute(): readonly PlaybookTemplateSummary[] {
    return PLAYBOOK_TEMPLATES.map((template) => ({ id: template.id, name: template.name, description: template.description, ourRole: template.ourRole, topicCount: template.topics.length, criterionCount: template.criteria.length }));
  }
}

export class CreatePlaybookFromTemplateUseCase {
  constructor(
    private readonly playbooks: ContractPlaybookRepository,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = randomId,
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly templateId: string; readonly name?: string; readonly isDefault?: boolean; readonly ourCompanyNames?: readonly string[] }): Promise<Playbook> {
    const template = findPlaybookTemplate(input.templateId);
    if (template === undefined) throw new ContractDomainError(`unknown playbook template: ${input.templateId} (available: ${PLAYBOOK_TEMPLATES.map((entry) => entry.id).join(', ')})`);
    const now = this.clock().toISOString();
    const playbook = playbookFromTemplate(template, {
      tenant: input.scope, id: this.ids(), isDefault: input.isDefault ?? false, now,
      ...(input.name === undefined || input.name.trim() === '' ? {} : { name: input.name }),
      ...(input.ourCompanyNames === undefined ? {} : { ourCompanyNames: input.ourCompanyNames }),
    });
    return saveWithDefault(this.playbooks, this.unitOfWork, playbook, now);
  }
}
