'use strict';

// Item search matched the raw query as one substring, so "finolex pipe" found
// nothing — none of the 1049 catalogue names contain that literal phrase, while
// 16 contain both words. A reasonable search looked like an empty catalogue.

jest.mock('../../utils/firebaseAdmin', () => ({
  firestore: jest.fn(), auth: jest.fn(), database: jest.fn(),
}));
jest.mock('../../cache/redis', () => ({ get: jest.fn(), set: jest.fn(), del: jest.fn() }));

const { rankCatalogue } = require('../purchaseController');

// Real names from the catalogue.
const CATALOGUE = [
  { name: 'Finolex Agri Pvc Pipe 4kg - 6mtr-2.1/2 inch' },
  { name: 'Finolex Agri Pvc Pipe 6kg - 6mtr - 2 Inch' },
  { name: 'Finolex Upvc Solvent Solution Cement' },
  { name: 'Finolex Agri Pvc Fta-1 1/2 inch' },
  { name: 'Ashirvad Cpvc Pipe 1 inch' },
  { name: 'Pipe Wrench 12 inch' },
  { name: 'Asian Paints Apcolite Premium Interior Emulsion' },
];
const names = rows => rows.map(r => r.name);

describe('rankCatalogue', () => {
  test('a multi-word query matches on tokens, in any order', () => {
    const hits = names(rankCatalogue(CATALOGUE, 'finolex pipe', 25));
    expect(hits).toHaveLength(2);
    expect(hits.every(n => /finolex/i.test(n) && /pipe/i.test(n))).toBe(true);
    // Word order must not matter — the vendor's name and the product word can
    // be typed either way round.
    expect(names(rankCatalogue(CATALOGUE, 'pipe finolex', 25))).toEqual(hits);
  });

  test('EVERY token must appear — it is an AND, not an OR', () => {
    // "cement" alone matches the Finolex solvent; with "pipe" it must not.
    expect(names(rankCatalogue(CATALOGUE, 'cement', 25)))
      .toEqual(['Finolex Upvc Solvent Solution Cement']);
    expect(rankCatalogue(CATALOGUE, 'finolex pipe cement', 25)).toEqual([]);
  });

  test('a name starting with the whole query ranks first', () => {
    expect(names(rankCatalogue(CATALOGUE, 'pipe', 25))[0]).toBe('Pipe Wrench 12 inch');
  });

  test('the shorter name wins a tie — it is the more precise match', () => {
    const hits = names(rankCatalogue(CATALOGUE, 'finolex pvc', 25));
    expect(hits[0]).toBe('Finolex Agri Pvc Fta-1 1/2 inch');
  });

  test('case and extra whitespace are ignored', () => {
    expect(names(rankCatalogue(CATALOGUE, '  FINOLEX   Pipe ', 25)))
      .toEqual(names(rankCatalogue(CATALOGUE, 'finolex pipe', 25)));
  });

  test('honours the limit', () => {
    expect(rankCatalogue(CATALOGUE, 'finolex', 2)).toHaveLength(2);
  });

  test('an empty or whitespace-only query matches nothing', () => {
    expect(rankCatalogue(CATALOGUE, '', 25)).toEqual([]);
    expect(rankCatalogue(CATALOGUE, '   ', 25)).toEqual([]);
  });

  test('scans the whole catalogue — a later match is not cut off by an early one', () => {
    // The old loop broke out once it had enough prefix matches, so items
    // further down could never be reached.
    const many = [
      ...Array.from({ length: 40 }, (_, n) => ({ name: `Pipe Clamp ${n}` })),
      { name: 'Finolex Pipe Special' },
    ];
    expect(names(rankCatalogue(many, 'finolex pipe', 25))).toEqual(['Finolex Pipe Special']);
  });
});
