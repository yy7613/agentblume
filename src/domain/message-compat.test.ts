/**
 * ゴールデンテスト: nonEmpty 委譲リファクタ前後のエラーメッセージ互換(ADR-0035)
 *
 * 各 BC の公開ファクトリが投げる検証メッセージは UI の日本語化(src/ui/api/error-messages.ts)と
 * 既存テストの契約であり、shared/assert への委譲でバイト単位に不変でなければならない。
 * ここでは「最初に検証されるフィールドを空文字にした最小の不正入力」で各ファクトリを呼び、
 * ^...$ の完全一致正規表現でメッセージを固定する(不正入力を作るため as unknown as キャストを使う)。
 *
 * 注: shared 配下は他 BC へ依存できない(depcruise の葉ルール)ため、このテストは src/domain 直下に置く。
 */
import { describe, expect, it } from 'vitest';
import { createAgent, type CreateAgentProps } from './agent/agent';
import { evaluationNonEmpty, validateEvaluationMetadata, type EvaluationAssetMetadata } from './evaluation/asset-metadata';
import { createExperiment, type Experiment } from './evaluation/experiment';
import { validateFactoryPlan, type FactoryPlan } from './factory/factory-plan';
import { createAgentHarness, type CreateAgentHarnessProps } from './harness/agent-harness';
import { createMcpServerConfig, type CreateMcpServerConfigProps } from './mcp/mcp-server';
import { createMemoryProposal, type CreateMemoryProposalProps } from './memory/memory-proposal';
import { createWikiPage, type CreateWikiPageProps } from './memory/wiki-page';
import { createWikiSpace } from './memory/wiki-space';
import { createModelSettings, createModelSlotSettings, type CreateModelSettingsProps } from './model-settings/model-settings';
import { createSkill, type CreateSkillProps } from './skill/skill';
import { SemVer } from './tool/semver';
import { createTool, type CreateToolProps } from './tool/tool';
import { nonEmpty, validateMetadata, type ValidationMetadata } from './validation/metadata';

describe('nonEmpty error message compatibility (golden)', () => {
  it.each<[string, () => unknown, RegExp]>([
    [
      'createTool',
      () => createTool({ metadata: { internalId: '' } } as unknown as CreateToolProps),
      /^createTool: metadata\.internalId must be a non-empty string$/,
    ],
    [
      'createAgent',
      () => createAgent({ metadata: { internalId: '' } } as unknown as CreateAgentProps),
      /^createAgent: metadata\.internalId must be a non-empty string$/,
    ],
    [
      'createAgentHarness',
      () => createAgentHarness({ metadata: { internalId: '' } } as unknown as CreateAgentHarnessProps),
      /^createAgentHarness: metadata\.internalId must be a non-empty string$/,
    ],
    [
      'createMcpServerConfig',
      () => createMcpServerConfig({ scope: { tenantId: '' } } as unknown as CreateMcpServerConfigProps),
      /^createMcpServerConfig: scope\.tenantId must be a non-empty string$/,
    ],
    [
      'createSkill',
      () => createSkill({ metadata: { internalId: '' } } as unknown as CreateSkillProps),
      /^createSkill: metadata\.internalId must be a non-empty string$/,
    ],
    [
      'createModelSettings',
      () => createModelSettings({ scope: { tenantId: '' } } as unknown as CreateModelSettingsProps),
      /^createModelSettings: scope\.tenantId must be a non-empty string$/,
    ],
    [
      'createWikiSpace',
      () => createWikiSpace({ id: '' } as unknown as Parameters<typeof createWikiSpace>[0]),
      /^WikiSpace: id must be a non-empty string$/,
    ],
    [
      'createWikiPage',
      () => createWikiPage({ id: '' } as unknown as CreateWikiPageProps),
      /^WikiPage: id must be a non-empty string$/,
    ],
    [
      'createMemoryProposal',
      () => createMemoryProposal({ id: '' } as unknown as CreateMemoryProposalProps),
      /^MemoryProposal: id must be a non-empty string$/,
    ],
    [
      'nonEmpty (validation/metadata)',
      () => {
        nonEmpty('', 'title');
      },
      /^title must be a non-empty string$/,
    ],
    [
      'evaluationNonEmpty (evaluation/asset-metadata)',
      () => {
        evaluationNonEmpty('', 'SaveDataset: metadata.internalId');
      },
      /^SaveDataset: metadata\.internalId must be a non-empty string$/,
    ],
    [
      'validateFactoryPlan',
      () => validateFactoryPlan({ agentBrief: { displayName: '' } } as unknown as FactoryPlan, { dataSourceIds: [] }),
      /^validateFactoryPlan: agentBrief\.displayName must be a non-empty string$/,
    ],
    [
      'createExperiment',
      () => createExperiment({ id: '' } as unknown as Experiment),
      /^Experiment: id must be a non-empty string$/,
    ],
  ])('%s keeps the exact message', (_name, call, pattern) => {
    expect(call).toThrow(pattern);
  });
});

describe('httpUrl / registryModel error message compatibility (golden)', () => {
  // shared/assert.ts assertHttpUrl への委譲(M2)前後でメッセージがバイト単位不変であることを固定する。
  const mcpProps = (url: string) => ({
    scope: { tenantId: 't1', workspaceId: 'w1' },
    name: 'srv',
    updatedAt: '2026-01-01T00:00:00.000Z',
    transport: { kind: 'http', url, headers: {} },
  });

  it.each<[string, () => unknown, RegExp]>([
    [
      'createMcpServerConfig: invalid URL',
      () => createMcpServerConfig(mcpProps('not a url') as unknown as CreateMcpServerConfigProps),
      /^createMcpServerConfig: transport\.url must be a valid URL: not a url$/,
    ],
    [
      'createMcpServerConfig: non-http protocol',
      () => createMcpServerConfig(mcpProps('ftp://example.com') as unknown as CreateMcpServerConfigProps),
      /^createMcpServerConfig: transport\.url must use http\(s\): ftp:\/\/example\.com$/,
    ],
    [
      'createMcpServerConfig: embedded credentials',
      () => createMcpServerConfig(mcpProps('https://user:pass@example.com') as unknown as CreateMcpServerConfigProps),
      /^createMcpServerConfig: transport\.url must not embed credentials \(user:password@host\)$/,
    ],
    [
      'createModelSlotSettings: non-http baseUrl',
      () => createModelSlotSettings({ source: 'openai-compatible', baseUrl: 'ftp://example.com', model: 'm' }),
      /^createModelSettings: slot\.baseUrl must use http\(s\): ftp:\/\/example\.com$/,
    ],
    [
      'createModelSlotSettings: baseUrl over max length',
      () =>
        createModelSlotSettings({
          source: 'openai-compatible',
          baseUrl: `https://example.com/${'a'.repeat(512)}`,
          model: 'm',
        }),
      /^createModelSettings: slot\.baseUrl must be at most 512 characters$/,
    ],
    [
      'createModelSlotSettings: link-local baseUrl (BC 固有検査の保存)',
      () => createModelSlotSettings({ source: 'openai-compatible', baseUrl: 'http://169.254.169.254/v1', model: 'm' }),
      /^createModelSettings: slot\.baseUrl must not target a link-local address \(cloud metadata endpoints are never reachable from here\)$/,
    ],
    [
      "createModelSlotSettings: registry model not in 'provider/model' form",
      () => createModelSlotSettings({ source: 'registry', model: 'no-slash' }),
      /^createModelSettings: slot\.model must be in 'provider\/model' form, but got 'no-slash'$/,
    ],
  ])('%s keeps the exact message', (_name, call, pattern) => {
    expect(call).toThrow(pattern);
  });
});

describe('metadata version/state error message compatibility (golden)', () => {
  // validatePublishableMetadata への統合(M3)前後でメッセージがバイト単位不変であることを固定する。
  const metadata = (patch: Record<string, unknown>) => ({
    internalId: 'id-1',
    workingName: 'work',
    displayName: 'Display',
    publishName: 'publish.name',
    version: SemVer.of(1, 0, 0),
    owner: 'alice',
    state: 'draft',
    tenant: { tenantId: 't1', workspaceId: 'w1' },
    ...patch,
  });
  const badVersion = { version: '1.0.0' };
  const badState = { state: 'live' };

  it.each<[string, () => unknown, RegExp]>([
    [
      'createTool: version',
      () => createTool({ metadata: metadata(badVersion) } as unknown as CreateToolProps),
      /^createTool: metadata\.version must be a SemVer instance$/,
    ],
    [
      'createTool: state',
      () => createTool({ metadata: metadata(badState) } as unknown as CreateToolProps),
      /^createTool: invalid state: live$/,
    ],
    [
      'createAgent: version',
      () => createAgent({ metadata: metadata(badVersion) } as unknown as CreateAgentProps),
      /^createAgent: metadata\.version must be a SemVer instance$/,
    ],
    [
      'createAgent: state',
      () => createAgent({ metadata: metadata(badState) } as unknown as CreateAgentProps),
      /^createAgent: invalid state: live$/,
    ],
    [
      'createAgentHarness: version',
      () => createAgentHarness({ metadata: metadata(badVersion) } as unknown as CreateAgentHarnessProps),
      /^createAgentHarness: metadata\.version must be a SemVer instance$/,
    ],
    [
      'createAgentHarness: state',
      () => createAgentHarness({ metadata: metadata(badState) } as unknown as CreateAgentHarnessProps),
      /^createAgentHarness: invalid state: live$/,
    ],
    [
      'createSkill: version',
      () => createSkill({ metadata: metadata(badVersion) } as unknown as CreateSkillProps),
      /^createSkill: metadata\.version must be a SemVer instance$/,
    ],
    [
      'createSkill: state',
      () => createSkill({ metadata: metadata(badState) } as unknown as CreateSkillProps),
      /^createSkill: invalid state: live$/,
    ],
    [
      'validateMetadata (validation): version',
      () => validateMetadata(metadata(badVersion) as unknown as ValidationMetadata, 'createPersona'),
      /^createPersona: metadata\.version must be a SemVer instance$/,
    ],
    [
      'validateMetadata (validation): state',
      () => validateMetadata(metadata(badState) as unknown as ValidationMetadata, 'createPersona'),
      /^createPersona: invalid state: live$/,
    ],
    [
      'validateEvaluationMetadata: version',
      () => validateEvaluationMetadata(metadata(badVersion) as unknown as EvaluationAssetMetadata, 'createGatePolicy'),
      /^createGatePolicy: metadata\.version must be a SemVer instance$/,
    ],
    [
      'validateEvaluationMetadata: state',
      () => validateEvaluationMetadata(metadata(badState) as unknown as EvaluationAssetMetadata, 'createGatePolicy'),
      /^createGatePolicy: invalid state: live$/,
    ],
  ])('%s keeps the exact message', (_name, call, pattern) => {
    expect(call).toThrow(pattern);
  });
});

describe('createTool (non-trim semantics)', () => {
  // 歴史的に createTool は trim しない(assert.ts の options.trim: false 相当)。
  // 空白のみの internalId が非空として通ることを、後続フィールドまで有効な最小入力で固定する。
  it("accepts a whitespace-only ' ' internalId without throwing", () => {
    const props: CreateToolProps = {
      metadata: {
        internalId: ' ',
        workingName: 'wname',
        displayName: 'Display Name',
        publishName: 'publish.name',
        version: SemVer.of(1, 0, 0),
        owner: 'alice',
        state: 'draft',
        tenant: { tenantId: 't1', workspaceId: 'w1' },
      },
      sideEffect: 'read-only',
      graph: { nodes: [{ id: 'n1', type: 'json-source', config: { rows: [{ a: 1 }] } }], edges: [] },
    };
    const tool = createTool(props);
    expect(tool.metadata.internalId).toBe(' ');
  });
});
