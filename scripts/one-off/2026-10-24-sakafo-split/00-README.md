# One-off: sort ANDAVAN'ANDRO food entries into Laoka, Goûter, Dining Out and Samihafa

Run 2026-10-24 against `DB` (sompitra-db) on production. Scope is the
ANDAVAN'ANDRO group only; other groups are not touched, and every target is
resolved by name inside the group. Envelope funding transfers never move, so
no envelope balance is reinterpreted.

## Pass 1 — inside Sakafo (`sakafo-split.sql`)

**To Laoka** — 26 purchases, 240,300: Tsena ×6, Trondro ×2, Akoho ×3,
Atody ×3, Sosisi, Kabaka, Anana ×4, Courgette, Ovy, Tongolo, Tongolo maitso,
Legume, Kotomila.

**To Goûter** — 7 purchases, 30,000: Ronono ×3, Fromage, Mais doux,
Moratdelle, and Vovodronono (matched only because it contains "ronono").

## Pass 2 — same terms, every category in the group (`group-sweep.sql`)

25 purchases, 99,500, so the same item is filed the same way wherever it was
entered:

| from → to | rows | amount |
| --- | --- | --- |
| Sakafo → Laoka (Loaka) | 1 | 13,000 |
| Sakafo → Dining Out (vary, Vary ×2, Sakafo, Sakafo maraina) | 5 | 22,100 |
| Sakafo → Samihafa (Vinaigre ×4, Tofu ×2, samihafa, Voanjo, Vianjo, Siramamy) | 10 | 32,600 |
| Fitaovana an-trano → Laoka (Tsena sabosty) | 1 | 9,000 |
| Fitaovana an-trano → Goûter (Vovodronono) | 1 | 1,000 |
| Fitaovana an-trano → Samihafa (Siramamy ×2) | 2 | 2,600 |
| Goûter → Laoka (Akoho am-bato) | 1 | 5,000 |
| Goûter → Dining Out (Vary) | 1 | 2,500 |
| Samihafa → Dining Out (Nitoto vary) | 1 | 1,800 |
| Voankazo → Laoka (Tsena ×2) | 2 | 9,900 |

Side effects worth knowing about, all caused by matching a term rather than
reading the item:

- **Tsena sabosty** (house supplies) matches *tsena* and is now in Laoka.
- **Nitoto vary** (pounded rice) matches *vary* and is now in Dining Out.
- The two Voankazo **Tsena** rows (market fruit) are now in Laoka, and the
  Goûter **Akoho am-bato** is now in Laoka.

## Pass 3 — empty Sakafo and remove the category (`sakafo-close.sql`)

The last five rows, 16,300:

- Sardine (3,400), Rano (5,000), Citron (500) and Gasy (3,000) → Samihafa
  (11,900)
- Yaourt (4,400) → Goûter

Once the category was empty it was deleted. It was not an envelope, held no
funding transfer, and no debt/credit account pointed at it. The Sakafo
categories of the other groups (NIRI, AKOHO, VINANINONY) are untouched.

## Final state of the group

| category | transactions | amount |
| --- | --- | --- |
| Laoka | 51 | 661,000 |
| Fitaovana an-trano | 11 | 100,600 |
| Goûter | 69 | 186,000 |
| Samihafa | 23 | 71,900 |
| Voankazo | 7 | 23,900 |
| Fianankaviana | 4 | 88,000 |
| Dining Out | 10 | 75,900 |

Sakafo no longer exists in this group. Total is unchanged at 1,207,300 — the
passes only move rows between categories.

## How to run

```bash
cd D:\Freebuff\Home
npx wrangler d1 execute DB --remote --file=scripts/one-off/2026-10-24-sakafo-split/sakafo-split.sql
npx wrangler d1 execute DB --remote --file=scripts/one-off/2026-10-24-sakafo-split/group-sweep.sql
npx wrangler d1 execute DB --remote --file=scripts/one-off/2026-10-24-sakafo-split/sakafo-close.sql
```

Rows already in their target are skipped, so a re-run leaves the distribution
above unchanged.
