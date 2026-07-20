/**
 * 開発プロキシ網羅性の回帰テスト。
 *
 * Fastifyへ登録された全ルートの先頭パスセグメントが vite.config.ts の
 * server.proxy に含まれることを検証する。プロキシ未登録のパスは、開発モードで
 * ViteがSPAのindex.html（非JSON）を返し、UIは
 * 「API returned a non-JSON response...」エラーになる（/factory-runs 等で実際に発生した）。
 * 新しいAPIルートを追加したら vite.config.ts へもプロキシを追加すること。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiDir = fileURLToPath(new URL('.', import.meta.url));
const viteConfigPath = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));

/** src/api 配下の実装ファイルから `app.<method>('/segment...` の先頭セグメントを抽出する。 */
function registeredRoutePrefixes(): readonly string[] {
  const prefixes = new Set<string>();
  for (const file of readdirSync(apiDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file.endsWith('.d.ts')) continue;
    const source = readFileSync(join(apiDir, file), 'utf8');
    for (const match of source.matchAll(/app\.(?:get|post|put|delete|patch)(?:<[^>]*>)?\(\s*'(\/[a-z0-9-]+)/g)) {
      const segment = match[1];
      if (segment !== undefined) prefixes.add(segment);
    }
  }
  return [...prefixes].sort();
}

/** vite.config.ts の server.proxy キー（`'/path': apiTarget` 形式）を抽出する。 */
function proxyKeys(): readonly string[] {
  const source = readFileSync(viteConfigPath, 'utf8');
  const keys = new Set<string>();
  for (const match of source.matchAll(/'(\/[a-z0-9-]+)':\s*apiTarget/g)) {
    const key = match[1];
    if (key !== undefined) keys.add(key);
  }
  return [...keys].sort();
}

describe('vite dev proxy', () => {
  it('Fastifyへ登録された全ルート先頭パスがviteのdev proxyでAPIへ転送される', () => {
    const prefixes = registeredRoutePrefixes();
    const keys = proxyKeys();
    // 前提の健全性: 抽出が空なら正規表現の破綻（偽陰性）なので失敗させる。
    expect(prefixes.length).toBeGreaterThan(10);
    expect(keys.length).toBeGreaterThan(10);

    // Viteのproxyはキーとの前方一致でマッチする。同じ規則で網羅を検証する。
    const uncovered = prefixes.filter((prefix) => !keys.some((key) => prefix === key || prefix.startsWith(key)));
    expect(uncovered, `vite.config.ts の server.proxy に未登録のAPIルート: ${uncovered.join(', ')}`).toEqual([]);
  });
});
