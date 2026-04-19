/**
 * ipc-validators unit tests.
 *
 * Tests cover:
 *   - assertString: happy path, non-string throws, exceeds max throws, custom max
 *   - assertOneOf: happy path, non-string throws, not in allowed throws, case sensitivity
 */

import { describe, it, expect } from 'vitest';
import { assertString, assertOneOf } from '../../src/main/ipc-validators';

describe('assertString()', () => {
  it('returns the string when valid', () => {
    expect(assertString('hello', 'name')).toBe('hello');
  });

  it('returns an empty string', () => {
    expect(assertString('', 'field')).toBe('');
  });

  it('throws when value is not a string', () => {
    expect(() => assertString(42, 'field')).toThrow('field must be a string');
  });

  it('throws for null', () => {
    expect(() => assertString(null, 'field')).toThrow('field must be a string');
  });

  it('throws for undefined', () => {
    expect(() => assertString(undefined, 'field')).toThrow('field must be a string');
  });

  it('throws for boolean', () => {
    expect(() => assertString(true, 'flag')).toThrow('flag must be a string');
  });

  it('throws for an object', () => {
    expect(() => assertString({}, 'data')).toThrow('data must be a string');
  });

  it('accepts a string at the default max length (10000)', () => {
    const str = 'a'.repeat(10000);
    expect(assertString(str, 'field')).toBe(str);
  });

  it('throws when string exceeds the default max (10000)', () => {
    const str = 'a'.repeat(10001);
    expect(() => assertString(str, 'field')).toThrow('field exceeds 10000 chars');
  });

  it('accepts a string at a custom max', () => {
    expect(assertString('abc', 'field', 5)).toBe('abc');
  });

  it('throws when string exceeds the custom max', () => {
    expect(() => assertString('abcdef', 'field', 5)).toThrow('field exceeds 5 chars');
  });

  it('includes the field name in the error message', () => {
    expect(() => assertString(123, 'mySpecialField')).toThrow('mySpecialField must be a string');
  });

  it('accepts max=0 — only empty string is valid', () => {
    expect(assertString('', 'f', 0)).toBe('');
    expect(() => assertString('x', 'f', 0)).toThrow('f exceeds 0 chars');
  });
});

describe('assertOneOf()', () => {
  const COLORS = ['red', 'green', 'blue'] as const;

  it('returns the value when it is in the allowed list', () => {
    expect(assertOneOf('red', 'color', COLORS)).toBe('red');
    expect(assertOneOf('blue', 'color', COLORS)).toBe('blue');
  });

  it('throws when value is not in the allowed list', () => {
    expect(() => assertOneOf('yellow', 'color', COLORS)).toThrow(
      'color must be one of: red, green, blue',
    );
  });

  it('throws for an empty string not in the list', () => {
    expect(() => assertOneOf('', 'color', COLORS)).toThrow('color must be one of:');
  });

  it('throws for a number', () => {
    expect(() => assertOneOf(1, 'color', COLORS)).toThrow('color must be one of:');
  });

  it('throws for null', () => {
    expect(() => assertOneOf(null, 'color', COLORS)).toThrow('color must be one of:');
  });

  it('throws for undefined', () => {
    expect(() => assertOneOf(undefined, 'color', COLORS)).toThrow('color must be one of:');
  });

  it('is case-sensitive', () => {
    expect(() => assertOneOf('Red', 'color', COLORS)).toThrow('color must be one of:');
    expect(() => assertOneOf('RED', 'color', COLORS)).toThrow('color must be one of:');
  });

  it('includes the field name in the error message', () => {
    expect(() => assertOneOf('x', 'myField', COLORS)).toThrow('myField must be one of:');
  });

  it('lists all allowed values in the error message', () => {
    expect(() => assertOneOf('x', 'color', COLORS)).toThrow('red, green, blue');
  });

  it('works with a single-item allowed list', () => {
    expect(assertOneOf('only', 'field', ['only'] as const)).toBe('only');
    expect(() => assertOneOf('other', 'field', ['only'] as const)).toThrow('field must be one of: only');
  });
});
