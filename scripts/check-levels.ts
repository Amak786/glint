// Verifies every campaign level and a month of daily puzzles is solvable.
// Run with: npm run check
import { CAMPAIGN, campaignLevel, dailyLevel, dayNumber, solve, trace } from '../src/puzzle.ts';

let bad = 0;
const report = (name: string, level: ReturnType<typeof campaignLevel>, ms: number) => {
  const s = solve(level);
  const ok = isFinite(s.best) && s.best === level.par && s.best > 0 && !trace(level).solved;
  if (!ok) bad++;
  console.log(
    `${ok ? 'ok ' : 'BAD'} ${name.padEnd(10)} size ${level.size} par ${level.par} ` +
      `solutions ${s.solutions}/${s.states} pieces ${level.pieces.length} (${ms.toFixed(0)}ms)`,
  );
};

for (let i = 0; i < CAMPAIGN.length; i++) {
  const t = performance.now();
  const level = campaignLevel(i);
  report(`level ${i + 1}`, level, performance.now() - t);
}
const today = dayNumber();
for (let d = 0; d < 30; d++) {
  const t = performance.now();
  const level = dailyLevel(today + d);
  report(`daily +${d}`, level, performance.now() - t);
}
if (bad) {
  console.error(`${bad} level(s) failed`);
  process.exit(1);
}
console.log('all levels solvable');
