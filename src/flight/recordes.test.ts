import { describe, expect, it } from 'vitest';
import {
  clearRecords,
  formatRecordClock,
  getBestRecord,
  isRecordStorageAvailable,
  loadRecords,
  MAX_RECORDS,
  sanitizeInitials,
  saveRecord,
  type StorageLike,
  wouldMakeTopRecords,
} from './recordes';

function createMemoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem(key: string) {
      return data.has(key) ? (data.get(key) ?? null) : null;
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
    removeItem(key: string) {
      data.delete(key);
    },
  };
}

function createFailingStorage(): StorageLike {
  return {
    getItem() {
      throw new Error('SecurityError: storage blocked');
    },
    setItem() {
      throw new Error('QuotaExceededError: storage blocked');
    },
    removeItem() {
      throw new Error('SecurityError: storage blocked');
    },
  };
}

describe('recordes (Melhores entregadores)', () => {
  it('ordena pelo horário de término mais cedo e desempata pela maior pontuação', () => {
    const storage = createMemoryStorage();

    saveRecord(
      { initials: 'jvc', finishMinutes: 1120, score: 2600, delivered: 20, total: 20, dateIso: '2026-11-20T18:00:00Z' },
      storage,
    );
    saveRecord(
      { initials: 'GMR', finishMinutes: 980, score: 2200, delivered: 20, total: 20, dateIso: '2026-11-20T18:10:00Z' },
      storage,
    );
    saveRecord(
      { initials: 'rlh', finishMinutes: 980, score: 2950, delivered: 20, total: 20, dateIso: '2026-11-20T18:20:00Z' },
      storage,
    );
    saveRecord(
      { initials: 'lt', finishMinutes: 845, score: 1900, delivered: 20, total: 20, dateIso: '2026-11-20T18:30:00Z' },
      storage,
    );

    const list = loadRecords(storage);
    expect(list.map((r) => [r.initials, r.finishMinutes, r.score])).toEqual([
      ['LT', 845, 1900],
      ['RLH', 980, 2950],
      ['GMR', 980, 2200],
      ['JVC', 1120, 2600],
    ]);
    expect(getBestRecord(storage)?.initials).toBe('LT');
    expect(formatRecordClock(845)).toBe('14:05');
  });

  it('mantém no máximo 5 registros e descarta os piores resultados', () => {
    const storage = createMemoryStorage();
    const runs = [
      { initials: 'AAA', finishMinutes: 1300, score: 2000 },
      { initials: 'BBB', finishMinutes: 1200, score: 2100 },
      { initials: 'CCC', finishMinutes: 1100, score: 2200 },
      { initials: 'DDD', finishMinutes: 1000, score: 2300 },
      { initials: 'EEE', finishMinutes: 900, score: 2400 },
      { initials: 'FFF', finishMinutes: 950, score: 2500 },
      { initials: 'ZZZ', finishMinutes: 1390, score: 9999 },
    ];

    let lastRes = null;
    for (const run of runs) {
      lastRes = saveRecord({ ...run, delivered: 20, total: 20 }, storage);
    }

    const list = loadRecords(storage);
    expect(list).toHaveLength(MAX_RECORDS);
    expect(list.map((r) => r.initials)).toEqual(['EEE', 'FFF', 'DDD', 'CCC', 'BBB']);
    expect(lastRes?.rank).toBeNull();
    expect(wouldMakeTopRecords({ finishMinutes: 1199, score: 1000, delivered: 20 }, list)).toBe(true);
    expect(wouldMakeTopRecords({ finishMinutes: 1200, score: 2500, delivered: 20 }, list)).toBe(true);
    expect(wouldMakeTopRecords({ finishMinutes: 1200, score: 1800, delivered: 20 }, list)).toBe(false);
    expect(wouldMakeTopRecords({ finishMinutes: 1250, score: 9999, delivered: 20 }, list)).toBe(false);

    expect(clearRecords(storage)).toBe(true);
    expect(loadRecords(storage)).toEqual([]);
  });

  it('tolera armazenamento indisponível ou com erro sem lançar exceções', () => {
    const broken = createFailingStorage();

    expect(isRecordStorageAvailable(broken)).toBe(false);
    expect(isRecordStorageAvailable(null)).toBe(false);
    expect(loadRecords(broken)).toEqual([]);
    expect(getBestRecord(broken)).toBeNull();

    const saveBroken = saveRecord({ initials: 'abc', finishMinutes: 800, score: 3000, delivered: 20, total: 20 }, broken);
    expect(saveBroken.saved).toBe(false);
    expect(saveBroken.storageAvailable).toBe(false);
    expect(saveBroken.entry).toBeNull();
    expect(saveBroken.rank).toBeNull();

    const saveNull = saveRecord({ initials: 'abc', finishMinutes: 800, score: 3000, delivered: 20, total: 20 }, null);
    expect(saveNull.saved).toBe(false);
    expect(saveNull.storageAvailable).toBe(false);

    expect(clearRecords(broken)).toBe(false);
    expect(clearRecords(null)).toBe(false);
    expect(sanitizeInitials('  ãb!c9 ')).toBe('ABC');
    expect(sanitizeInitials('   ')).toBe('GOP');
  });
});
