import { describe, expect, it } from 'vitest';
import { ROLE_RANK } from '../src/constants.js';
import { compileTerm } from '../src/services/contentFilter.js';
import { decideEnforcement, isExempt } from '../src/services/enforcement.js';
import { decodeCursor, directKey, emailHash, encodeCursor } from '../src/util/helpers.js';

describe('decideEnforcement (Tier 1 at 10, Tier 2 at 20)', () => {
  const user = { status: 'ACTIVE' as const, exempt: false };

  it('does nothing below 10', () => {
    for (let n = 1; n <= 9; n++) expect(decideEnforcement({ ...user, reportCount: n })).toBe('NONE');
  });

  it('suspends at exactly 10', () => {
    expect(decideEnforcement({ ...user, reportCount: 10 })).toBe('SUSPEND');
  });

  it('does nothing for reports 11 to 19', () => {
    for (let n = 11; n <= 19; n++) {
      expect(decideEnforcement({ status: 'SUSPENDED', exempt: false, reportCount: n })).toBe('NONE');
      expect(decideEnforcement({ ...user, reportCount: n })).toBe('NONE');
    }
  });

  it('deactivates at 20, including a suspended account', () => {
    expect(decideEnforcement({ status: 'SUSPENDED', exempt: false, reportCount: 20 })).toBe('DEACTIVATE');
    expect(decideEnforcement({ ...user, reportCount: 20 })).toBe('DEACTIVATE');
  });

  it('keeps deactivating-eligible accounts deactivating only once', () => {
    expect(decideEnforcement({ status: 'DEACTIVATED', exempt: false, reportCount: 21 })).toBe('NONE');
  });

  it('does not suspend again if the count reaches 10 while not active', () => {
    expect(decideEnforcement({ status: 'SUSPENDED', exempt: false, reportCount: 10 })).toBe('NONE');
  });

  it('sends exempt accounts to the admin queue at both thresholds', () => {
    expect(decideEnforcement({ status: 'ACTIVE', exempt: true, reportCount: 10 })).toBe('QUEUE');
    expect(decideEnforcement({ status: 'ACTIVE', exempt: true, reportCount: 20 })).toBe('QUEUE');
    expect(decideEnforcement({ status: 'ACTIVE', exempt: true, reportCount: 15 })).toBe('NONE');
  });
});

describe('isExempt', () => {
  it('exempts staff and Gold badges only', () => {
    expect(isExempt({ role: 'USER', badge: { type: 'NONE' } })).toBe(false);
    expect(isExempt({ role: 'USER', badge: { type: 'BLUE' } })).toBe(false);
    expect(isExempt({ role: 'USER', badge: { type: 'GOLD' } })).toBe(true);
    expect(isExempt({ role: 'MODERATOR', badge: null })).toBe(true);
    expect(isExempt({ role: 'SUPER_ADMIN' })).toBe(true);
  });
});

describe('roles', () => {
  it('ranks roles from USER up to SUPER_ADMIN', () => {
    expect(ROLE_RANK.USER).toBeLessThan(ROLE_RANK.MODERATOR);
    expect(ROLE_RANK.MODERATOR).toBeLessThan(ROLE_RANK.TENANT_ADMIN);
    expect(ROLE_RANK.TENANT_ADMIN).toBeLessThan(ROLE_RANK.SUPER_ADMIN);
  });
});

describe('helpers', () => {
  it('directKey is the same whichever user comes first', () => {
    const a = '65f000000000000000000001';
    const b = '65f000000000000000000002';
    expect(directKey(a, b)).toBe(directKey(b, a));
    expect(directKey(a, b)).toBe(`${a}:${b}`);
  });

  it('emailHash ignores case and surrounding spaces, and hides the email', () => {
    const h = emailHash('Ada@Student.UNILAG.edu.ng');
    expect(h).toBe(emailHash('  ada@student.unilag.edu.ng '));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('ada');
  });

  it('cursor round-trips and rejects junk', () => {
    const date = new Date('2026-10-14T10:00:00Z');
    const id = '65f000000000000000000003';
    const out = decodeCursor(encodeCursor(date, id));
    expect(out.date.getTime()).toBe(date.getTime());
    expect(String(out.id)).toBe(id);
    expect(() => decodeCursor('not-a-cursor')).toThrow();
  });
});

describe('compileTerm', () => {
  it('WORD matches whole words only, ignoring case', () => {
    const re = compileTerm('ass', 'WORD')!;
    expect(re.test('what an ASS')).toBe(true);
    expect(re.test('my class starts at 8')).toBe(false);
    expect(re.test('assignment due')).toBe(false);
  });

  it('WORD escapes regex characters in the term', () => {
    const re = compileTerm('a.b', 'WORD')!;
    expect(re.test('say a.b now')).toBe(true);
    expect(re.test('say axb now')).toBe(false);
  });

  it('REGEX compiles, and an invalid pattern returns null', () => {
    expect(compileTerm('fo+bar', 'REGEX')!.test('FOOOBAR')).toBe(true);
    expect(compileTerm('(unclosed', 'REGEX')).toBeNull();
  });
});
