import { describe, expect, it } from 'vitest';
import { checkHost, checkUrl, classifyHost, DEFAULT_URL_POLICY, URL_REJECTION_MESSAGE, type UrlPolicy } from './url-policy';

const allowPrivate: UrlPolicy = { allowPrivateNetwork: true };

describe('classifyHost', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.13.9.1', 'loopback'],
    ['localhost', 'loopback'],
    ['LocalHost', 'loopback'],
    ['app.localhost', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
  ])('%s はループバック', (host, expected) => { expect(classifyHost(host)).toBe(expected); });

  it.each([
    ['169.254.169.254', 'link-local'],
    ['169.254.0.1', 'link-local'],
    ['fe80::1', 'link-local'],
    ['FEBF::abcd', 'link-local'],
    ['::ffff:169.254.169.254', 'link-local'],
  ])('%s はリンクローカル', (host, expected) => { expect(classifyHost(host)).toBe(expected); });

  it.each([
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['0.0.0.0', 'private'],
    ['198.18.0.1', 'private'],
    ['192.0.0.1', 'private'],
    ['239.1.2.3', 'private'],
    ['::', 'private'],
    ['fd00::1', 'private'],
    ['fc00::1', 'private'],
    ['printer.local', 'private'],
    ['db.internal', 'private'],
    ['host.home.arpa', 'private'],
    ['::ffff:10.0.0.5', 'private'],
    ['', 'private'],
  ])('%s は私設扱い', (host, expected) => { expect(classifyHost(host)).toBe(expected); });

  it.each([
    ['example.com', 'public'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['172.15.0.1', 'public'],
    ['2606:4700::1111', 'public'],
    ['example.com.', 'public'],
  ])('%s は公開扱い', (host, expected) => { expect(classifyHost(host)).toBe(expected); });

  it('先頭ゼロのオクテットはIPv4リテラルとして扱わない（8進解釈の回避）', () => {
    // `010.0.0.1` を 10.0.0.1 と解釈する実装があるため、リテラルとしては受け付けず名前扱いにする。
    expect(classifyHost('010.0.0.1')).toBe('public');
  });
});

describe('checkUrl', () => {
  it('ループバックは既定でも許可される（ローカルMCPサーバー・LM Studio）', () => {
    expect(checkUrl('http://127.0.0.1:3000/mcp', DEFAULT_URL_POLICY)).toBeUndefined();
    expect(checkUrl('http://localhost:1234/v1', DEFAULT_URL_POLICY)).toBeUndefined();
  });

  it('公開インターネット宛は許可される', () => {
    expect(checkUrl('https://example.com/mcp', DEFAULT_URL_POLICY)).toBeUndefined();
  });

  it('クラウドメタデータは opt-in しても拒否される', () => {
    expect(checkUrl('http://169.254.169.254/latest/meta-data/', DEFAULT_URL_POLICY)).toBe('link-local');
    expect(checkUrl('http://169.254.169.254/latest/meta-data/', allowPrivate)).toBe('link-local');
  });

  it('私設範囲は既定で拒否され、opt-in で許可される', () => {
    expect(checkUrl('http://10.0.0.5:8080/mcp', DEFAULT_URL_POLICY)).toBe('private-network');
    expect(checkUrl('http://10.0.0.5:8080/mcp', allowPrivate)).toBeUndefined();
    expect(checkUrl('http://192.168.1.20:1234/v1', allowPrivate)).toBeUndefined();
  });

  it.each([
    ['ftp://example.com/x', 'unsupported-scheme'],
    ['file:///etc/passwd', 'unsupported-scheme'],
    ['not a url', 'not-a-url'],
    ['https://user:pass@example.com/mcp', 'embedded-credentials'],
  ])('%s は %s で拒否される', (raw, reason) => {
    expect(checkUrl(raw, DEFAULT_URL_POLICY)).toBe(reason);
  });

  it('拒否理由はすべて説明文を持つ（UIへ出す文言の抜けを防ぐ）', () => {
    for (const reason of ['not-a-url', 'unsupported-scheme', 'embedded-credentials', 'link-local', 'private-network'] as const) {
      expect(URL_REJECTION_MESSAGE[reason]).toBeTruthy();
    }
  });

  it('説明文は宛先やDNS/接続の成否を含まない（内部構造を漏らさない）', () => {
    for (const message of Object.values(URL_REJECTION_MESSAGE)) {
      expect(message).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    }
  });
});

describe('checkHost', () => {
  it('DNS解決後のアドレス再検査に使える', () => {
    expect(checkHost('10.1.2.3', DEFAULT_URL_POLICY)).toBe('private-network');
    expect(checkHost('127.0.0.1', DEFAULT_URL_POLICY)).toBeUndefined();
    expect(checkHost('169.254.169.254', allowPrivate)).toBe('link-local');
  });
});
