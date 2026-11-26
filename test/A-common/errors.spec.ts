import { expect } from 'expect';
import { normalizeError } from '../../src/index.js';

describe('errors', () => {
  it('puts the undecorated server text back in message', () => {
    const error: any = new Error(
      'relation "t" does not exist\n\n  select *\n         ^',
    );
    error.serverMessage = 'relation "t" does not exist';
    expect((normalizeError(error) as any).message).toBe(
      'relation "t" does not exist',
    );
  });

  it('renders position as a string, which is what pg reads off the wire', () => {
    const error: any = new Error('syntax error');
    error.position = 8;
    expect((normalizeError(error) as any).position).toBe('8');
  });

  it('leaves an error from somewhere else alone', () => {
    const error = new Error('not from a server');
    expect((normalizeError(error) as Error).message).toBe('not from a server');
  });

  it('leaves a value that is not an object alone', () => {
    expect(normalizeError('a string')).toBe('a string');
    expect(normalizeError(null)).toBeNull();
    expect(normalizeError(undefined)).toBeUndefined();
  });

  it('leaves a position that is already a string alone', () => {
    const error: any = new Error('syntax error');
    error.position = '8';
    expect((normalizeError(error) as any).position).toBe('8');
  });
});
