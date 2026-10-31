import { describe, expect, it } from 'vitest';
import type { Tool } from '../../domain/tool/tool';
import { AgentRunError, ToolArgumentsError } from '../agent/errors';
import { graphWithArguments } from './tool-execution';

const schema = { columns: [{ name: 'predict_x', type: 'number' as const, nullable: true }] };
const tool = { inputSchema: schema, graph: { nodes: [
  { id: 'args', type: 'agent-input', config: { schema, sample: { predict_x: 0 } } },
  { id: 'model', type: 'linear-model', config: { x: 'x', y: 'y', predictAt: 0, predictionBinding: { source: 'agent-input', field: 'predict_x' } } },
], edges: [] } } as unknown as Tool;
const configOf = (row: Record<string, number|string|null>) => graphWithArguments(tool, row).nodes.find(node => node.id === 'model')?.config;
describe('linear-model prediction argument binding', () => {
  it('binds a numeric target including zero without changing the stored graph', () => {
    expect(configOf({ predict_x: 10 })).toMatchObject({ predictAt: 10 });
    expect(configOf({ predict_x: 0 })).toMatchObject({ predictAt: 0 });
    expect(tool.graph.nodes[1]?.config).toMatchObject({ predictAt: 0 });
  });
  it('omission of an optional target disables prediction instead of using the design sample', () => expect(configOf({ predict_x: null })).toMatchObject({ predictAt: null }));
  it('rejects unavailable or mistyped prediction inputs', () => {
    expect(() => configOf({})).toThrow(AgentRunError);
    expect(() => configOf({ predict_x: '10' })).toThrow(ToolArgumentsError);
  });
});


describe('observation argument binding',()=>{
 const observationTool={...tool,inputSchema:{columns:[{name:'obs',type:'number' as const,nullable:true}]},graph:{nodes:[{id:'args',type:'agent-input',config:{schema:{columns:[{name:'obs',type:'number',nullable:true}]},sample:{obs:1}}},{id:'model',type:'linear-model',config:{x:'x',y:'y',observationBinding:{source:'agent-input',field:'obs'}}}],edges:[]}} as unknown as Tool;
 it('binds and omits a row ordinal without changing the stored tool',()=>{expect(graphWithArguments(observationTool,{obs:1}).nodes[1]?.config).toMatchObject({observationIndex:1});expect(graphWithArguments(observationTool,{obs:null}).nodes[1]?.config).toMatchObject({observationIndex:null});expect(observationTool.graph.nodes[1]?.config).not.toHaveProperty('observationIndex');});
 it.each([0,-1,1.5,'1'])('rejects invalid observation %s',obs=>expect(()=>graphWithArguments(observationTool,{obs})).toThrow(ToolArgumentsError));
});
