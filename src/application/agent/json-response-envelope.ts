import type { ModelRequestMessage } from '../model/model-provider';

/** Detect explicit JSON-only delivery requests, without treating a request for a JSON code block as raw JSON. */
export function requestsJsonOnly(messages: readonly ModelRequestMessage[]): boolean {
  const user = messages.filter(message => message.role === 'user').at(-1);
  const content = user?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.find(part => part.type === 'text')?.text ?? '' : '';
  if (/JSON\s*(?:オブジェクト|配列|形式|データ)?\s*(?:だけで(?:はなく|なく)|のみ(?:ならず|で(?:はなく|なく)))|\bnot\s+(?:only|just)\s+JSON\b/i.test(text)) return false;
  if (/(?:JSON\s*(?:オブジェクト|配列|形式|データ)?\s*(?:だけ|のみ)[^。\n]{0,12}(?:返さない|出さない|にしない)|(?:do not|don't)\s+(?:return|output|respond with)\s+(?:only|just)\s+(?:a\s+)?(?:valid\s+)?JSON)/i.test(text)) return false;
  if (/\bJSON\s+(?:code\s*)?block\b|\bJSON\s+in\s+(?:a\s+)?(?:markdown\s+)?code\s*block\b/i.test(text)) return false;
  return /JSON\s*(?:オブジェクト|配列|形式|データ)?\s*(?:だけ|のみ)|\b(?:only|just)\s+(?:a\s+)?(?:valid\s+)?JSON\b|\bJSON(?:\s+(?:object|array))?\s+only\b/i.test(text);
}

/** Preserve JSON characters exactly; remove a valid fence or plain-prose suffix only under a JSON-only contract. */
export function unwrapJsonEnvelope(content: string, jsonOnly: boolean): string {
  if (!jsonOnly) return content;
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(content.trim());
  if (match) {
    const candidate = match[1]!.trim();
    try { JSON.parse(candidate); return candidate; } catch { return content; }
  }
  // Only a single leading object/array in an explicitly JSON-only response. Never search prose for an answer.
  const text = content.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return content;
  const stack: string[] = [];
  let quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return content;
      if (!stack.length) {
        const candidate = text.slice(0, i + 1), suffix = text.slice(i + 1).trim();
        if (!suffix || /[{}\[\]`]/u.test(suffix) || /^(?:-?\d|true\b|false\b|null\b|"|,)/u.test(suffix)) return content;
        try { JSON.parse(candidate); return candidate; } catch { return content; }
      }
    }
  }
  return content;
}
