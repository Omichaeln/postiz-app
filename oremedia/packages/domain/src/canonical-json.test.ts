import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json';

/** RFC 8785 fixtures (subset). */
describe('canonicalJson (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units and removes whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2, é: 3, A: 4 })).toBe('{"A":4,"a":2,"b":1,"é":3}');
  });
  it('serialises numbers per ES ToString', () => {
    expect(canonicalJson([1, 1.0, 1e21, 1e-7, -0, 0.1 + 0.2])).toBe('[1,1,1e+21,1e-7,0,0.30000000000000004]');
  });
  it('escapes control characters with lowercase hex and keeps unicode literal', () => {
    expect(canonicalJson('\u0001\n"\\ é')).toBe('"\\u0001\\n\\"\\\\ é"');
  });
  it('omits undefined object properties and nullifies undefined array members', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });
  it('rejects non-finite numbers and bigint', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
  });
  it('is stable across key insertion order (property test)', () => {
    const a = { z: [3, { y: 1, x: 2 }], k: 'v', m: null };
    const b = { m: null, k: 'v', z: [3, { x: 2, y: 1 }] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
  it('matches the RFC 8785 appendix example', () => {
    // Built from code points so the fixture does not depend on escape handling in this source file.
    const cp = (...codes: number[]) => String.fromCharCode(...codes);
    const input = {
      numbers: [
        333333333.3333333 /* RFC literal 333333333.33333329 parses to this double */, 1e30, 4.5, 2e-3,
        0.000000000000000000000000001,
      ],
      string: cp(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f),
      literals: [null, true, false],
    };
    const expectedString =
      '"' + cp(0x20ac) + '$' + '\\u000f' + '\\n' + "A'B" + '\\"' + '\\\\' + '\\\\' + '\\"' + '/' + '"';
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":' +
        expectedString +
        '}',
    );
  });
});
