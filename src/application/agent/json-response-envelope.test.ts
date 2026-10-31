import { describe, expect, it } from 'vitest';
import { requestsJsonOnly, unwrapJsonEnvelope } from './json-response-envelope';

describe('explicit JSON response delivery', () => {
  it.each(['回答はJSONオブジェクトだけで返してください。', 'JSON のみで回答', 'Return only valid JSON.', 'Respond with a JSON object only, no markdown.'])('recognizes %s', content => expect(requestsJsonOnly([{ role: 'user', content }])).toBe(true));
  it.each(['JSONのコードブロックで示してください', 'Return only a JSON code block.', 'Explain this JSON.', 'JSONだけで返さないでください', 'Do not return only JSON.'])('preserves other delivery requests: %s', content => expect(requestsJsonOnly([{ role: 'user', content }])).toBe(false));
  it('uses the latest user request, not history or tool payloads', () => {
    expect(requestsJsonOnly([{ role: 'user', content: 'JSONのみ' }, { role: 'assistant', content: '{}' }, { role: 'user', content: '文章で説明して' }])).toBe(false);
    expect(requestsJsonOnly([{ role: 'user', content: [{ type: 'text', text: 'JSONのみ' }] }])).toBe(true);
  });
  it('removes only the envelope, preserving numeric text and duplicate keys rather than rewriting data', () => {
    const json = '{"x":1.234567890123456789,"x":2,"note":"```"}';
    expect(unwrapJsonEnvelope('```json\n' + json + '\n```', true)).toBe(json);
    expect(unwrapJsonEnvelope('```json\n[1,2]\n```', true)).toBe('[1,2]');
  });
  it.each(['prose\n```json\n{}\n```', '```json\n{bad}\n```', '```json\n{}\n```\n```json\n{}\n```'])('does not extract or repair arbitrary content: %s', text => expect(unwrapJsonEnvelope(text, true)).toBe(text));
  it('keeps fences unless delivery is explicitly JSON-only', () => expect(unwrapJsonEnvelope('```json\n{}\n```', false)).toBe('```json\n{}\n```'));
});


describe('single leading JSON under an exclusive delivery contract',()=>{
 it('removes trailing prose without rewriting values or escaped strings',()=>{const json='{"x":1.230000,"note":"brace } and \\"quoted\\""}';expect(unwrapJsonEnvelope(json+'\n補足: 計算済みの値です。',true)).toBe(json);});
 it.each(['{"x":1}\n{"x":2}','{"x":1}\n42','{"x":1}\n説明 [1,2]','{"x":1}\n```json\n{}\n```','{"x":1,}\n説明','prefix {"x":1}\n説明'])('keeps ambiguous, multiple or malformed output: %s',text=>expect(unwrapJsonEnvelope(text,true)).toBe(text));
 it('does not drop prose without a JSON-only contract',()=>{const text='{"x":1}\n説明';expect(unwrapJsonEnvelope(text,false)).toBe(text);});
});


it.each(['JSONだけでなく説明もください','JSONのみならず文章も必要です','Return not only JSON but an explanation'])('does not infer exclusivity from a negated request: %s',content=>expect(requestsJsonOnly([{role:'user',content}])).toBe(false));
