import { describe, expect, it } from 'vitest';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { DataProfile } from './profile-data-sources';
import { describeMetricSourceViolations } from './metric-source-validation';
const source=(id:string,columns:DataProfile['columns']):DataProfile=>({dataSourceId:id,name:id,kind:'file',columns,sampleRows:[],sampleRowCount:0,rowCount:0,periodColumns:[],categoricalColumns:[],joinCandidates:[]});
const people=source('people',[{name:'persons',type:'number',nullable:false,label:'Population',unit:'人'},{name:'births',type:'number',nullable:false,label:'Birth count',unit:'人'}]);
const area=source('land',[{name:'surface',type:'number',nullable:false,label:'Total area',unit:'ｈａ'}]);
const tool={key:'d',displayName:'density',purpose:'Compute population density',dataSourceId:'people',sideEffect:'read-only' as const,computations:[{outputColumn:'density',intent:'persons / births'}]};
const plan=(t:typeof tool):FactoryPlan=>({agentBrief:{displayName:'a',role:'r'},tools:[t],skills:[],personas:[],scenarios:[]});
describe('metric source units',()=>{
 it('rejects a known count denominator for density and points to the actual area source',()=>{const issues=describeMetricSourceViolations(plan(tool),[people,area]);expect(issues).toHaveLength(1);expect(issues[0]).toContain('births=Birth count');expect(issues[0]).toContain('land.surface');});
 it('accepts a selected area source',()=>expect(describeMetricSourceViolations(plan({...tool,additionalDataSourceIds:['land']} as typeof tool),[people,area])).toEqual([]));
 it('does not invent units when metadata is missing',()=>expect(describeMetricSourceViolations(plan(tool),[source('people',[{name:'opaque',type:'number',nullable:false}]),area])).toEqual([]));
 it('does not reject a raw lookup or another ratio',()=>{expect(describeMetricSourceViolations(plan({...tool,computations:[]}),[people,area])).toEqual([]);expect(describeMetricSourceViolations(plan({...tool,purpose:'births per person',computations:[{outputColumn:'rate',intent:'births/persons'}]}),[people,area])).toEqual([]);});
});


it('does not reject explicit area constants or length-derived areas',()=>{
 expect(describeMetricSourceViolations(plan({...tool,computations:[{outputColumn:'density',intent:'persons / 100 km2'}]}),[people,area])).toEqual([]);
 const radius=source('circle',[{name:'persons',type:'number',nullable:false,unit:'人'},{name:'radius',type:'number',nullable:false,unit:'m'}]);
 expect(describeMetricSourceViolations(plan({...tool,dataSourceId:'circle',computations:[{outputColumn:'density',intent:'persons / (pi * radius^2)'}]}),[radius])).toEqual([]);
});
