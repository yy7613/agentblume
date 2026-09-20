import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { csvSourceNode } from './csv-source';

describe('csv-source: metadata', () => {
  it('has the expected type/kind/arity', () => {
    expect(csvSourceNode.type).toBe('csv-source');
    expect(csvSourceNode.kind).toBe('source');
    expect(csvSourceNode.inputArity).toBe(0);
  });
});

describe('csv-source: validateConfig', () => {
  it('accepts text only', () => {
    const cfg = csvSourceNode.validateConfig({ text: 'a,b\n1,2' });
    expect(cfg.text).toBe('a,b\n1,2');
  });

  it('accepts all options', () => {
    const cfg = csvSourceNode.validateConfig({
      text: 'a;b',
      delimiter: ';',
      header: false,
      inferTypes: false,
    });
    expect(cfg.delimiter).toBe(';');
    expect(cfg.header).toBe(false);
    expect(cfg.inferTypes).toBe(false);
  });

  it('throws ConfigError when text is missing', () => {
    expect(() => csvSourceNode.validateConfig({})).toThrowError(ConfigError);
  });

  it('throws ConfigError on empty delimiter', () => {
    expect(() => csvSourceNode.validateConfig({ text: 'a', delimiter: '' })).toThrowError(
      ConfigError,
    );
  });
});

describe('csv-source: basic parsing (header + type inference default on)', () => {
  it('parses a normal CSV with inferred types', () => {
    const text = 'id,name,active\n1,Alice,true\n2,Bob,false';
    const table = csvSourceNode.execute([], { text });
    expect(table.rows).toEqual([
      { id: 1, name: 'Alice', active: true },
      { id: 2, name: 'Bob', active: false },
    ]);
  });

  it('infers number/boolean/date/string per cell', () => {
    const text = 'n,b,d,s\n42,true,2020-01-02,hello';
    const [row] = csvSourceNode.execute([], { text }).rows;
    expect(row?.n).toBe(42);
    expect(row?.b).toBe(true);
    expect(row?.d).toBeInstanceOf(Date);
    expect((row?.d as Date).toISOString()).toBe('2020-01-02T00:00:00.000Z');
    expect(row?.s).toBe('hello');
  });

  it('infers a full ISO datetime with Z', () => {
    const text = 'd\n2020-01-02T03:04:05Z';
    const [row] = csvSourceNode.execute([], { text }).rows;
    expect(row?.d).toBeInstanceOf(Date);
    expect((row?.d as Date).toISOString()).toBe('2020-01-02T03:04:05.000Z');
  });
});

describe('csv-source: quoting (RFC4180 subset)', () => {
  it('respects a delimiter inside quotes', () => {
    const text = 'id,note\n1,"a,b,c"';
    const [row] = csvSourceNode.execute([], { text }).rows;
    expect(row?.note).toBe('a,b,c');
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    const text = 'id,q\n1,"she said ""hi"""';
    const [row] = csvSourceNode.execute([], { text }).rows;
    expect(row?.q).toBe('she said "hi"');
  });

  it('handles a quoted field with a custom delimiter', () => {
    const text = 'id;note\n1;"x;y"';
    const [row] = csvSourceNode.execute([], { text, delimiter: ';' }).rows;
    expect(row?.note).toBe('x;y');
  });

  it('a quoted numeric-looking field is still type-inferred as number', () => {
    // クオートは構文であり型は中身で決まる。
    const text = 'id\n"5"';
    const [row] = csvSourceNode.execute([], { text }).rows;
    expect(row?.id).toBe(5);
  });
});

describe('csv-source: header off', () => {
  it('generates col1,col2,... names when header:false', () => {
    const text = '1,Alice\n2,Bob';
    const table = csvSourceNode.execute([], { text, header: false });
    expect(table.schema.columns.map((c) => c.name)).toEqual(['col1', 'col2']);
    expect(table.rows).toEqual([
      { col1: 1, col2: 'Alice' },
      { col1: 2, col2: 'Bob' },
    ]);
  });

  it('names empty header cells as colN', () => {
    const text = 'id,,c\n1,2,3';
    const table = csvSourceNode.execute([], { text });
    expect(table.schema.columns.map((c) => c.name)).toEqual(['id', 'col2', 'c']);
  });
});

describe('csv-source: type inference off', () => {
  it('keeps every non-empty cell as string when inferTypes:false', () => {
    const text = 'n,b\n1,true';
    const [row] = csvSourceNode.execute([], { text, inferTypes: false }).rows;
    expect(row?.n).toBe('1');
    expect(row?.b).toBe('true');
  });
});

describe('csv-source: empty cells -> null', () => {
  it('maps empty fields to null (inferTypes on)', () => {
    const text = 'a,b,c\n1,,3';
    const [row] = csvSourceNode.execute([], { text }).rows;
    expect(row?.a).toBe(1);
    expect(row?.b).toBeNull();
    expect(row?.c).toBe(3);
  });

  it('maps empty fields to null (inferTypes off)', () => {
    const text = 'a,b\n,x';
    const [row] = csvSourceNode.execute([], { text, inferTypes: false }).rows;
    expect(row?.a).toBeNull();
    expect(row?.b).toBe('x');
  });

  it('short rows fill missing trailing columns with null', () => {
    const text = 'a,b,c\n1,2';
    const [row] = csvSourceNode.execute([], { text }).rows;
    expect(row).toEqual({ a: 1, b: 2, c: null });
  });
});

describe('csv-source: line handling', () => {
  it('handles CRLF line endings', () => {
    const text = 'a,b\r\n1,2\r\n3,4';
    const table = csvSourceNode.execute([], { text });
    expect(table.rows).toEqual([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]);
  });

  it('drops a single trailing newline (no empty final row)', () => {
    const text = 'a\n1\n';
    const table = csvSourceNode.execute([], { text });
    expect(table.rows).toEqual([{ a: 1 }]);
  });

  it('empty text -> no rows, empty schema', () => {
    const table = csvSourceNode.execute([], { text: '' });
    expect(table.rows).toEqual([]);
    expect(table.schema).toEqual({ columns: [] });
  });

  it('header-only text -> no data rows', () => {
    const table = csvSourceNode.execute([], { text: 'a,b,c' });
    expect(table.rows).toEqual([]);
  });
});

describe('csv-source: inferSchema', () => {
  it('produces an inferred schema from the parsed rows', () => {
    const text = 'id,name\n1,Alice\n2,Bob';
    const inf = csvSourceNode.inferSchema([], { text });
    expect(inf.state).toBe('inferred');
    expect(inf.schema.columns).toEqual([
      { name: 'id', type: 'number', nullable: false },
      { name: 'name', type: 'string', nullable: false },
    ]);
    expect(inf.issues).toEqual([]);
  });

  it('nullable column when a cell is empty', () => {
    const text = 'id\n1\n\n3';
    // 中間の空行 -> フィールド1つ空 -> null。
    const inf = csvSourceNode.inferSchema([], { text });
    const col = inf.schema.columns.find((c) => c.name === 'id');
    expect(col?.nullable).toBe(true);
  });
});

describe('csv-source: BOM とコード列（e-Stat / Excel 由来の CSV）', () => {
  const ESTAT = '\uFEFF"時点","地域コード","地域","総人口【人】","注記"\n"2015年","00000","全国","127094745","国勢調査"\n"2015年","13000","東京都","13515271",""\n"2015年","01000","北海道","5381733",""';

  it('正常: 先頭の BOM を落とし、1 列目を見た目どおりの列名で参照できる', () => {
    const table = csvSourceNode.execute([], { text: ESTAT });
    expect(table.schema.columns[0]?.name).toBe('時点');
    expect(Object.keys(table.rows[0] ?? {})[0]).toBe('時点');
    expect(table.rows[0]?.['時点']).toBe('2015年');
  });

  it('正常: 先頭ゼロつきの値を含む列は列ごと文字列のまま保つ（00000 を 0 にしない・13000 も文字列）', () => {
    const table = csvSourceNode.execute([], { text: ESTAT });
    expect(table.rows.map((row) => row['地域コード'])).toEqual(['00000', '13000', '01000']);
    expect(table.schema.columns.find((column) => column.name === '地域コード')?.type).toBe('string');
    // 値の列は従来どおり数値になる。
    expect(table.rows[1]?.['総人口【人】']).toBe(13515271);
  });

  it('境界: 0 単体・小数（0.5）・負数は先頭ゼロのコードとみなさず、数値のまま', () => {
    const table = csvSourceNode.execute([], { text: 'a,b,c\n0,0.5,-05\n10,1.25,7' });
    expect(table.rows[0]).toEqual({ a: 0, b: 0.5, c: -5 });
    expect(table.schema.columns.map((column) => column.type)).toEqual(['number', 'number', 'number']);
  });

  it('境界: BOM はテキスト先頭だけを落とす（途中の U+FEFF や header:false の 1 セル目も対象）', () => {
    const table = csvSourceNode.execute([], { text: '\uFEFFx,y\n1,2', header: false });
    expect(table.rows[0]).toEqual({ col1: 'x', col2: 'y' });
    const kept = csvSourceNode.execute([], { text: 'name\na\uFEFFb' });
    expect(kept.rows[0]?.['name']).toBe('a\uFEFFb');
  });

  it('従来どおり: inferTypes:false なら全列が文字列で、コード列の判定は関与しない', () => {
    const table = csvSourceNode.execute([], { text: 'code,n\n007,5', inferTypes: false });
    expect(table.rows[0]).toEqual({ code: '007', n: '5' });
  });

  it('正常: inferSchema と execute が同じ列名・型を返す（スキーマ点検と実行で食い違わない）', () => {
    const inferred = csvSourceNode.inferSchema([], { text: ESTAT }).schema;
    expect(inferred).toEqual(csvSourceNode.execute([], { text: ESTAT }).schema);
  });
});
