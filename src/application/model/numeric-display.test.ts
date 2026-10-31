import { describe, expect, it } from 'vitest';
import { requestedDecimalPlaces, withNumericDisplay } from './numeric-display';
describe('requested numeric display', () => {
  it.each(['小数は小数第6位まで。','小数点以下６桁で','Round to 6 decimal places.'])('recognizes %s', content => expect(requestedDecimalPlaces([{role:'user',content}])).toBe(6));
  it.each(['Explain six figures','小数第16位','4 decimal places and 6 decimal places','小数第2位と小数第3位'])('does not guess or combine incompatible requests: %s', content => expect(requestedDecimalPlaces([{role:'user',content}])).toBeUndefined());
  it('uses only the latest user request', () => expect(requestedDecimalPlaces([{role:'user',content:'6 decimal places'},{role:'user',content:'Explain the result'}])).toBeUndefined());
  it('provides correctly rounded numbers while preserving every original cell', () => {
    const input={rows:[{id:'01000',n:36,prediction:500.79608593645315,negative:-0.0000001,missing:null}]};
    const result=withNumericDisplay(input,6) as any;
    expect(result.rows).toBe(input.rows);
    expect(result.rows[0].prediction).toBe(500.79608593645315);
    expect(result.displayRows[0]).toEqual({id:'01000',n:36,prediction:500.796086,negative:0,missing:null});
    expect(withNumericDisplay(input,undefined)).toBe(input);
  });
});


it('does not round a request for full precision even if it mentions a usual display convention',()=>expect(requestedDecimalPlaces([{role:'user',content:'Usually use 6 decimal places, but give full precision here.'}])).toBeUndefined());
