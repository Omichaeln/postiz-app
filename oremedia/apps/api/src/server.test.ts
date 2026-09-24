import { describe, expect, it } from 'vitest';
import { internalErrorFields } from './server';

describe('internalErrorFields (spec 17.3: driver messages carry user data)', () => {
  it('keeps name, code and errno but elides quoted values from the message', () => {
    const err = Object.assign(
      new Error("Duplicate entry 'ten_1-someone@example.test' for key 'memberships.uq_invited'"),
      { code: 'ER_DUP_ENTRY', errno: 1062 },
    );
    expect(internalErrorFields(err)).toEqual({
      errorName: 'Error',
      errorCode: 'ER_DUP_ENTRY',
      errno: 1062,
      errorMessage: 'Duplicate entry … for key …',
    });
  });

  it('elides double-quoted values too and tolerates non-errors', () => {
    expect(internalErrorFields(new Error('column "email" has value "a@b.c"')).errorMessage).toBe(
      'column … has value …',
    );
    expect(internalErrorFields('plain "text"')).toEqual({ errorName: 'NonError', errorMessage: 'plain …' });
  });
});
