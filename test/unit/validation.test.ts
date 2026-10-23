import { parse, specifiedRules, validate } from 'graphql';
import { describe, expect, it } from 'vitest';
import { buildSchema } from '../../src/graphql/schema.js';
import { costLimitRule, depthLimitRule } from '../../src/graphql/validation.js';

const schema = buildSchema();

function errors(query: string, rules = [depthLimitRule(5), costLimitRule(200)]) {
  return validate(schema, parse(query), [...specifiedRules, ...rules]).map((e) => ({
    message: e.message,
    ...e.extensions,
  }));
}

/** Read the computed cost back out of a rule configured to always fail. */
function costOf(query: string): number {
  const [err] = validate(schema, parse(query), [costLimitRule(-1)]);
  return err!.extensions.cost as number;
}

describe('depthLimitRule', () => {
  it('accepts queries within the limit', () => {
    expect(errors('{ country(code: "UZ") { borders { name } } }')).toEqual([]);
  });

  it('rejects over-deep queries, including through fragments', () => {
    const q = `
      query Deep { country(code: "UZ") { ...B } }
      fragment B on Country { borders { borders { borders { borders { name } } } } }`;
    expect(errors(q, [depthLimitRule(5)])).toEqual([
      expect.objectContaining({ code: 'QUERY_TOO_COMPLEX', depth: 6, maxDepth: 5 }),
    ]);
  });

  it('ignores introspection fields', () => {
    expect(
      errors('{ __schema { types { fields { type { ofType { ofType { name } } } } } } }'),
    ).toEqual([]);
  });
});

describe('costLimitRule', () => {
  it('uses @cost weights and slicing arguments', () => {
    // countries (1) + first(5) * [nodes (1) + weather (5) + 0 for scalars]
    expect(costOf('{ countries(first: 5) { nodes { name weather { timezone } } } }')).toBe(
      1 + 5 * (1 + 5),
    );
  });

  it('uses argument defaults and list-size hints', () => {
    // compareDestinations(10) + 3 codes * DestinationScore.country(1)
    expect(
      costOf(
        '{ compareDestinations(codes: ["UZ","TR","JP"]) { destinations { country { name } } } }',
      ),
    ).toBe(10 + 3 * (1 + 1));
    // countries default first = 10
    expect(costOf('{ countries { nodes { name } } }')).toBe(1 + 10 * 1);
  });

  it('prices variables pessimistically at assumedSize', () => {
    expect(costOf('query($n: Int) { countries(first: $n) { nodes { name } } }')).toBe(1 + 50 * 1);
  });

  it('counts aliases separately (alias amplification)', () => {
    const one = costOf('{ a: weather(latitude: 1, longitude: 1) { timezone } }');
    const two = costOf(
      '{ a: weather(latitude: 1, longitude: 1) { timezone } b: weather(latitude: 2, longitude: 2) { timezone } }',
    );
    expect(two).toBe(2 * one);
  });

  it('rejects queries whose nested list fan-out explodes', () => {
    const q =
      '{ countries(first: 50) { nodes { borders { borders { capitalWeather { timezone } } } } } }';
    expect(errors(q, [costLimitRule(1500)])).toEqual([
      expect.objectContaining({ code: 'QUERY_TOO_COMPLEX', maxCost: 1500 }),
    ]);
  });
});
