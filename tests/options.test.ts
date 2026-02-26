import { describe, expect, it } from 'bun:test';
import { parseIntOption } from '../src/options';

describe('parseIntOption', () => {
  it('returns fallback when value is missing', () => {
    expect(parseIntOption(undefined, 5, 1)).toBe(5);
  });

  it('returns fallback when value is invalid', () => {
    expect(parseIntOption('abc', 5, 1)).toBe(5);
  });

  it('returns fallback when value is below min', () => {
    expect(parseIntOption('0', 5, 1)).toBe(5);
    expect(parseIntOption('-3', 5, 1)).toBe(5);
  });

  it('returns parsed integer when value is valid', () => {
    expect(parseIntOption('7', 5, 1)).toBe(7);
  });
});
