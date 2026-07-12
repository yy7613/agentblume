import { createApp } from './composition/root';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
}

const experimentId = argument('--experiment');
if (experimentId === undefined || experimentId.trim().length === 0) {
  process.stderr.write('Usage: npm run llmops:gate -- --experiment <id> [--db <path>] [--tenant <id>] [--workspace <id>]\n');
  process.exitCode = 2;
} else {
  const dbPath = argument('--db');
  const app = createApp({ profile: 'local', ...(dbPath !== undefined ? { dbPath } : {}) });
  try {
    const scope = { tenantId: argument('--tenant') ?? process.env['AGENTCONTEXT_TENANT_ID'] ?? 'local', workspaceId: argument('--workspace') ?? process.env['AGENTCONTEXT_WORKSPACE_ID'] ?? 'default' };
    const exitCode = await app.qualityGateExitCode.execute(scope, experimentId);
    process.stdout.write(`${JSON.stringify({ experimentId, result: exitCode === 0 ? 'pass' : exitCode === 1 ? 'fail' : 'invalid', exitCode })}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'quality gate failed'}\n`);
    process.exitCode = 2;
  } finally {
    app.close();
  }
}
