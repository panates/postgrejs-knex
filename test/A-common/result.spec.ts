import { expect } from 'expect';
import type { CommandResult } from 'postgrejs';
import { toQueryResult } from '../../src/index.js';

describe('result', () => {
  it('keeps the first word of the command tag, as pg does', () => {
    const result = toQueryResult({ command: 'CREATE INDEX' } as CommandResult);
    expect(result.command).toBe('CREATE');
  });

  it('keeps the whole command tag as well, which pg throws away', () => {
    const result = toQueryResult({ command: 'CREATE INDEX' } as CommandResult);
    expect(result.commandTag).toBe('CREATE INDEX');
  });

  it('counts rows affected for a statement that reports them', () => {
    const result = toQueryResult({
      command: 'UPDATE',
      rowsAffected: 3,
    } as CommandResult);
    expect(result.rowCount).toBe(3);
  });

  it('counts rows returned for a select, which reports none', () => {
    const result = toQueryResult({
      command: 'SELECT',
      rows: [{ a: 1 }, { a: 2 }],
    } as CommandResult);
    expect(result.rowCount).toBe(2);
  });

  it('answers a null count where there is no count at all', () => {
    const result = toQueryResult({ command: 'BEGIN' } as CommandResult);
    expect(result.rowCount).toBeNull();
  });

  it('answers a null count for a command that returns rows but no count', () => {
    // `show` and `explain` both return a row and both carry no count in
    // their tag, which is what `pg` reports.
    for (const command of ['SHOW', 'EXPLAIN']) {
      const result = toQueryResult({
        command,
        rows: [{ a: 1 }],
      } as CommandResult);
      expect(result.rowCount).toBeNull();
    }
  });

  it('counts the rows a fetch returned', () => {
    const result = toQueryResult({
      command: 'FETCH',
      rows: [{ a: 1 }, { a: 2 }],
    } as CommandResult);
    expect(result.rowCount).toBe(2);
  });

  it('answers an empty row array where PostgreJS leaves it unset', () => {
    const result = toQueryResult({ command: 'INSERT' } as CommandResult);
    expect(result.rows).toEqual([]);
  });

  it('answers an empty field list where PostgreJS leaves it unset', () => {
    const result = toQueryResult({ command: 'INSERT' } as CommandResult);
    expect(result.fields).toEqual([]);
  });

  it('answers an empty command for a result that carries no tag', () => {
    const result = toQueryResult({} as CommandResult);
    expect(result.command).toBe('');
    expect(result.commandTag).toBe('');
  });

  it("names each column the way pg names it, and keeps PostgreJS's own", () => {
    const result = toQueryResult({
      command: 'SELECT',
      rows: [],
      fields: [
        {
          fieldName: 'id',
          tableId: 42,
          columnId: 1,
          dataTypeId: 23,
          dataTypeName: 'int4',
          jsType: 'number',
          isArray: false,
          fixedSize: 4,
        },
      ],
    } as CommandResult);
    expect(result.fields[0]).toEqual({
      name: 'id',
      tableID: 42,
      columnID: 1,
      dataTypeID: 23,
      dataTypeSize: 4,
      dataTypeModifier: -1,
      format: 'binary',
      dataTypeName: 'int4',
      jsType: 'number',
      isArray: false,
      elementDataTypeID: undefined,
    });
  });

  it('reports a variable-width column the way pg does, as -1', () => {
    const result = toQueryResult({
      command: 'SELECT',
      rows: [],
      fields: [
        {
          fieldName: 'name',
          dataTypeId: 25,
          dataTypeName: 'text',
          jsType: 'string',
        },
      ],
    } as CommandResult);
    expect(result.fields[0].dataTypeSize).toBe(-1);
    expect(result.fields[0].dataTypeModifier).toBe(-1);
    expect(result.fields[0].tableID).toBe(0);
    expect(result.fields[0].columnID).toBe(0);
  });
});
