import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Table } from '../../data/types';
import { linearModelNode } from './linear-model';
import { summaryStatisticsNode } from './summary-statistics';

const table: Table = { schema: { columns: [{ name: 'x', type: 'number', nullable: true }, { name: 'y', type: 'number', nullable: true }, { name: 'group', type: 'string', nullable: false }] }, rows: [{ x: 1, y: 2, group: 'a' }, { x: 2, y: 4, group: 'a' }, { x: 3, y: 5, group: 'a' }] };
const config = (intercept: 'include' | 'zero' = 'include', groupBy: string[] = []) => linearModelNode.validateConfig({ x: 'x', y: 'y', intercept, groupBy });
describe('linear-model', () => {
  it('computes independent hand-derived OLS moments and residual diagnostics', () => {
    const row = linearModelNode.execute([table], config()).rows[0]!;
    expect(row).toMatchObject({ n: 3, missingPairs: 0, status: 'ok', df: 1, slope: 1.5, sampleVarianceX: 1, sampleCovariance: 1.5 });
    expect(row['intercept']).toBeCloseTo(2/3, 12);
    expect(row['sse']).toBeCloseTo(1/6, 12);
    expect(row['residualStddev']).toBeCloseTo(Math.sqrt(1/6), 12);
    expect(row['r2']).toBeCloseTo(27/28, 12);
    expect(row['uncenteredR2']).toBeCloseTo(269/270, 12);
    expect(row['correlation']).toBeCloseTo(Math.sqrt(27/28), 12);
  });
  it('keeps centered and uncentered R² separate for a through-origin model', () => {
    const row = linearModelNode.execute([table], config('zero')).rows[0]!;
    expect(row).toMatchObject({ intercept: 0, df: 2 });
    expect(row['slope']).toBeCloseTo(25/14, 12);
    expect(row['sse']).toBeCloseTo(5/14, 12);
    expect(row['r2']).toBeCloseTo(125/126, 12);
    expect(row['centeredR2']).toBeCloseTo(181/196, 12);
  });
  it('rejects unidentified intercept models but keeps their descriptive moments', () => {
    const constant = { ...table, rows: table.rows.map(row => ({ ...row, x: 8 })) };
    expect(linearModelNode.execute([constant], config()).rows[0]).toMatchObject({ status: 'not_identifiable', slope: null, intercept: null, sse: null, sampleVarianceX: 0, meanX: 8, correlation: null });
    expect(linearModelNode.execute([constant], config('zero')).rows[0]).toMatchObject({ status: 'ok', intercept: 0 });
  });
  it('excludes only incomplete pairs, preserves groups and handles empty observations', () => {
    const missing = { ...table, rows: [...table.rows, { x: null, y: 100, group: 'a' }, { x: 0, y: null, group: 'b' }] };
    const rows = linearModelNode.execute([missing], config('include', ['group'])).rows;
    expect(rows[0]).toMatchObject({ group: 'a', n: 3, missingPairs: 1, slope: 1.5 });
    expect(rows[1]).toMatchObject({ group: 'b', n: 0, missingPairs: 1, status: 'not_identifiable' });
    expect(linearModelNode.execute([{ ...table, rows: [] }], config()).rows[0]).toMatchObject({ n: 0, status: 'not_identifiable', df: 0 });
  });
  it('uses centered moments rather than subtracting large raw squares for an intercept model', () => {
    const shifted = { ...table, rows: table.rows.map(row => ({ ...row, x: Number(row['x']) + 1e9 })) };
    expect(linearModelNode.execute([shifted], config()).rows[0]?.['slope']).toBeCloseTo(1.5, 12);
  });
  it('validates numeric columns, duplicate groups and generated-name collisions', () => {
    expect(linearModelNode.inferSchema([table.schema], { ...config(), x: 'group' }).state).toBe('mismatch');
    expect(() => config('include', ['group','group'])).toThrow(/duplicate/);
    const collision = { ...table, schema: { columns: [...table.schema.columns, { name: 'slope', type: 'string' as const, nullable: false }] } };
    expect(linearModelNode.inferSchema([collision.schema], config('include', ['slope'])).state).toBe('mismatch');
    expect(() => linearModelNode.execute([collision], config('include', ['slope']))).toThrow(/conflicts/);
  });
});

describe('summary statistics extended definitions', () => {
  const summarize = (values: (number|null)[]) => summaryStatisticsNode.execute([{ schema: table.schema, rows: values.map(y => ({ x: 0, y, group: 'a' })) }], summaryStatisticsNode.validateConfig({ columns: ['y'], metrics: ['mean','variance','sample-stddev','population-stddev','lag1-autocorrelation'], variance: 'sample' })).rows[0]!;
  it('distinguishes n and n-1 and computes NIST lag1 without intermediate rounding', () => {
    const row = summarize([1,2,1]);
    expect(row['mean']).toBeCloseTo(4/3, 12);
    expect(row['variance']).toBeCloseTo(1/3, 12);
    expect(row['sample-stddev']).toBeCloseTo(Math.sqrt(1/3), 12);
    expect(row['population-stddev']).toBeCloseTo(Math.sqrt(2/9), 12);
    expect(row['lag1-autocorrelation']).toBeCloseTo(-2/3, 12);
  });
  it.each([[1,null,2], [1,1], [1], []].map(values => ({ values })))('does not manufacture autocorrelation for gaps, constants or insufficient data: %j', ({ values }) => expect(summarize(values)['lag1-autocorrelation']).toBeNull());
});


// Public NIST StRD observations only; certified answers remain in this test, outside every model prompt.
// https://www.itl.nist.gov/div898/strd/lls/data/LINKS/DATA/Norris.dat
// https://www.itl.nist.gov/div898/strd/lls/data/LINKS/DATA/NoInt1.dat
// https://www.itl.nist.gov/div898/strd/univ/data/Michelso.dat
const observations = JSON.parse(readFileSync(new URL('./__fixtures__/statistical-observations.json', import.meta.url), 'utf8')) as Record<string, Table['rows']>;
describe('NIST certified statistical anchors', () => {
  it.each([
    { name: 'Norris', mode: 'include' as const, slope: 1.00211681802045, intercept: -0.262323073774029, residualStddev: 0.884796396144373, r2: 0.999993745883712, sse: 26.6173985294224 },
    { name: 'NoInt1', mode: 'zero' as const, slope: 2.07438016528926, intercept: 0, residualStddev: 3.56753034006338, r2: 0.999365492298663, sse: 127.272727272727 },
  ])('matches certified least-squares statistics: $name', anchor => {
    const row = linearModelNode.execute([{ schema: table.schema, rows: observations[anchor.name]! }], config(anchor.mode)).rows[0]!;
    for (const key of ['slope','intercept','residualStddev','r2','sse'] as const) expect(row[key]).toBeCloseTo(anchor[key], 9);
  });
  it('matches the certified mean, sample standard deviation and lag1 of Michelso', () => {
    const row = summaryStatisticsNode.execute([{ schema: table.schema, rows: observations['Michelso']! }], summaryStatisticsNode.validateConfig({ columns: ['y'], metrics: ['mean','sample-stddev','lag1-autocorrelation'] })).rows[0]!;
    expect(row['mean']).toBeCloseTo(299.8524, 10);
    expect(row['sample-stddev']).toBeCloseTo(0.0790105478190518, 12);
    expect(row['lag1-autocorrelation']).toBeCloseTo(0.535199668621283, 12);
  });
});


describe('observation residuals after full-group fitting',()=>{
 it('selects an observed pair without refitting on the selected row',()=>{
  const base=linearModelNode.execute([table],config()).rows[0]!;
  const row=linearModelNode.execute([table],{...config(),observationIndex:1}).rows[0]!;
  expect(row).toMatchObject({n:3,observationIndex:1,observationX:1,observationY:2,observationStatus:'ok'});
  expect(row['slope']).toBe(base['slope']);expect(row['sse']).toBe(base['sse']);
  expect(row['fitted']).toBeCloseTo(13/6,12);expect(row['residual']).toBeCloseTo(-1/6,12);
 });
 it('keeps missing rows in ordinal numbering and distinguishes out-of-range observations',()=>{
  const rows={...table,rows:[{x:null,y:9,group:'a'},...table.rows]};
  expect(linearModelNode.execute([rows],{...config(),observationIndex:1}).rows[0]).toMatchObject({n:3,observationStatus:'missing',observationX:null,observationY:9,residual:null});
  expect(linearModelNode.execute([rows],{...config(),observationIndex:5}).rows[0]).toMatchObject({n:3,observationStatus:'not_found',residual:null});
 });
 it('rejects invalid ordinals and does not manufacture residuals for singular fits',()=>{
  for(const observationIndex of [0,-1,1.5])expect(()=>linearModelNode.validateConfig({...config(),observationIndex})).toThrow();
  const constant={...table,rows:table.rows.map(r=>({...r,x:1}))};
  expect(linearModelNode.execute([constant],{...config(),observationIndex:1}).rows[0]).toMatchObject({observationStatus:'not_identifiable',residual:null});
 });
});


describe('legacy linear model schemas',()=>{
 it('does not add observation columns until requested or bound',()=>{const row=linearModelNode.execute([table],config()).rows[0];expect(row).not.toHaveProperty('observationIndex');expect(row).not.toHaveProperty('observationStatus');expect(linearModelNode.inferSchema([table.schema],config()).schema.columns.map(c=>c.name)).not.toContain('residual');});
});
