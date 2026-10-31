import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { DataProfile } from './profile-data-sources';

const isAreaUnit = (unit: string): boolean => /^(?:ha|a|m[²2]|km[²2]|平方メートル|平方キロメートル)$/iu.test(unit.normalize('NFKC').trim());
const isDensityUnit = (unit: string): boolean => /\/(?:km[²2]|m[²2]|ha)$/iu.test(unit.normalize('NFKC').trim());

/** Reject only a contradiction proven by descriptive units; unknown metadata never becomes a guessed meaning. */
export function describeMetricSourceViolations(plan: FactoryPlan, profiles: readonly DataProfile[]): string[] {
  const issues: string[] = [];
  for (const tool of plan.tools) {
    if (tool.reuse || !(tool.computations?.length)) continue;
    const text = `${tool.purpose} ${tool.computations.map(c => `${c.outputColumn} ${c.intent}`).join(' ')}`;
    if (!/人口密度|population[\s_-]*density|(?:人|people|persons?)\s*\/\s*km[²2]/iu.test(text)) continue;
    const ids = new Set([tool.dataSourceId, ...(tool.additionalDataSourceIds ?? [])]);
    const selected = profiles.filter(p => ids.has(p.dataSourceId));
    const numeric = selected.flatMap(p => p.columns.filter(c => c.type === 'number'));
    if (!numeric.length || numeric.some(c => !c.unit?.trim())) continue;
    if (numeric.some(c => isAreaUnit(c.unit!) || isDensityUnit(c.unit!) || /^(?:m|km|cm|mm|メートル)$/iu.test(c.unit!.normalize('NFKC').trim()))) continue;
    const intents = tool.computations.map(c => c.intent).join(' ');
    if (/\d+(?:\.\d+)?\s*(?:ha|km[²2]|m[²2]|平方|square\s)/iu.test(intents)) continue;
    // A single quantity divided by an explicit area constant is not a contradiction we can prove here.
    const referenced = numeric.filter(c => intents.includes(`[${c.name}]`) || intents.split(/[^A-Za-z0-9_]+/u).includes(c.name));
    if (referenced.length < 2) continue;
    const available = profiles.flatMap(p => p.columns.filter(c => c.unit && isAreaUnit(c.unit)).map(c => `${p.dataSourceId}.${c.name} (${c.label ?? c.name}, ${c.unit})`));
    issues.push(`Tool '${tool.key}' claims population density but all selected numeric columns have known non-area units: ${numeric.map(c => `${c.name}=${c.label ?? c.name} [${c.unit}]`).join(', ')}. Select the area source/column and include its dataSourceId in the plan; never infer an opaque code's meaning. Available area columns: ${available.join(', ') || 'none; the requested density cannot be computed from the supplied metadata'}`);
  }
  return issues;
}
