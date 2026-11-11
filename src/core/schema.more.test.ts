import { describe, expect, it } from 'vitest';
import { infer, inferScalar, shapeSummary, simplify } from './schema';

describe('simplify', () => {
  it('returns nothing for what is not a schema', () => {
    expect(simplify(null)).toEqual({});
    expect(simplify('string')).toEqual({});
    expect(simplify([{ type: 'string' }])).toEqual({});
  });

  it('keeps what agents use, drops the rest, and trims descriptions', () => {
    expect(simplify({ type: 'string', example: 'x', 'x-vendor': 1, xml: {}, format: 'date', description: `  ${'d'.repeat(600)}  ` })).toEqual({ type: 'string', format: 'date', description: 'd'.repeat(500) });
  });

  it('simplifies combinators, items and additionalProperties', () => {
    expect(
      simplify({
        oneOf: [{ type: 'string', example: 'a' }, { type: 'integer' }],
        anyOf: 'not a list',
        items: { type: 'number', 'x-unit': 'kg' },
        additionalProperties: { type: 'boolean', example: true },
      }),
    ).toEqual({ oneOf: [{ type: 'string' }, { type: 'integer' }], anyOf: 'not a list', items: { type: 'number' }, additionalProperties: { type: 'boolean' } });
    expect(simplify({ type: 'object', additionalProperties: false })).toEqual({ type: 'object', additionalProperties: false });
  });

  it('turns nullable into a type union, and ignores it without a type', () => {
    expect(simplify({ type: 'string', nullable: true })).toEqual({ type: ['string', 'null'] });
    expect(simplify({ nullable: true, description: 'x' })).toEqual({ description: 'x' });
    expect(simplify({ type: 'string', nullable: false })).toEqual({ type: 'string' });
  });

  it('drops readOnly properties and required names that no longer exist', () => {
    expect(simplify({ type: 'object', properties: { id: { type: 'string', readOnly: true }, name: { type: 'string' } }, required: ['id', 'name'] })).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
  });

  it('stops nesting at the depth limit', () => {
    let s: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 8; i++) s = { type: 'array', items: s };
    let out = simplify(s) as Record<string, unknown>;
    for (let i = 0; i < 6; i++) out = out.items as Record<string, unknown>;
    expect(out).toEqual({ type: 'array', description: 'Nested too deep to describe here; pass what the API expects.' });
    let untyped: Record<string, unknown> = {};
    for (let i = 0; i < 7; i++) untyped = { items: untyped };
    let o = simplify(untyped) as Record<string, unknown>;
    for (let i = 0; i < 6; i++) o = o.items as Record<string, unknown>;
    expect(o.type).toBe('object');
  });
});

describe('infer', () => {
  it('is empty with no samples', () => {
    expect(infer([])).toEqual({});
    expect(infer([undefined])).toEqual({});
  });

  it('widens integers and numbers to number, nullable when a null was seen', () => {
    expect(infer([1, 2.5])).toEqual({ type: 'number' });
    expect(infer([1, 2.5, null])).toEqual({ type: ['number', 'null'] });
  });

  it('gives up on mixed types', () => {
    expect(infer(['a', 1])).toEqual({});
    expect(infer(['a', 1, true])).toEqual({});
  });

  it('marks nullable scalars, objects and arrays', () => {
    expect(infer(['a', null])).toEqual({ type: ['string', 'null'] });
    expect(infer([{ a: 1 }, null])).toEqual({ type: ['object', 'null'], properties: { a: { type: 'integer' } }, required: ['a'] });
    expect(infer([[], null])).toEqual({ type: ['array', 'null'] });
  });

  it('only requires keys every sample has', () => {
    expect(infer([{ a: 1 }, { b: 'x' }])).toEqual({ type: 'object', properties: { a: { type: 'integer' }, b: { type: 'string' } } });
  });

  it('is empty for only nulls', () => {
    expect(infer([null])).toEqual({});
  });
});

describe('inferScalar', () => {
  it('tells integers, numbers, booleans and strings apart', () => {
    expect(inferScalar(['1', '-2'])).toEqual({ type: 'integer' });
    expect(inferScalar(['1', '2.5'])).toEqual({ type: 'number' });
    expect(inferScalar(['true', 'false'])).toEqual({ type: 'boolean' });
    expect(inferScalar(['true', '1'])).toEqual({ type: 'string' });
    expect(inferScalar([])).toEqual({ type: 'string' });
  });
});

describe('shapeSummary', () => {
  it('summarises objects and lists of objects, and nothing else', () => {
    expect(shapeSummary({ id: 1, items: [] })).toBe('Returns id, items[].');
    expect(shapeSummary([{ id: 1 }])).toBe('Returns a list of objects with id.');
    expect(shapeSummary({})).toBeUndefined();
    expect(shapeSummary([])).toBeUndefined();
    expect(shapeSummary([[1]])).toBeUndefined();
    expect(shapeSummary('x')).toBeUndefined();
    expect(shapeSummary(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])))).toBe(`Returns ${Array.from({ length: 12 }, (_, i) => `k${i}`).join(', ')}.`);
  });
});
