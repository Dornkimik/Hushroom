import { randomInt } from 'node:crypto';

// Guest aliases are one pronounceable word, e.g. "Mistfinch", so @mentions need no spaces.
export const starts = [
  'Hush', 'Still', 'Soft', 'Mute', 'Calm', 'Lull', 'Quiet', 'Whisper',
  'Dusk', 'Moon', 'Star', 'Night', 'Gloam', 'Luna', 'Midnight', 'Noctur',
  'Mist', 'Fog', 'Rain', 'Drizzle', 'Cloud', 'Frost', 'Breeze', 'Haze',
  'Ember', 'Amber', 'Glow', 'Cinder', 'Honey', 'Copper', 'Lantern', 'Candle',
  'Tide', 'Drift', 'Ripple', 'Brook', 'Shoal', 'Cove', 'Reed', 'Pebble',
  'Pine', 'Moss', 'Fern', 'Willow', 'Birch', 'Thistle', 'Cedar', 'Acorn',
  'Silver', 'Slate', 'Velvet', 'Quartz', 'Iron', 'Opal', 'Ash', 'Flint'
];
export const ends = [
  'wren', 'moth', 'heron', 'finch', 'otter', 'owl', 'lark', 'fox', 'lynx', 'crane',
  'hollow', 'vale', 'brook', 'glen', 'spark', 'bell'
];
// Skip joins that read badly, like "Fernnest" or "Brookbrook".
export const aliases = starts.flatMap(start => ends
  .filter(end => start.at(-1).toLowerCase() !== end[0] && start.toLowerCase() !== end)
  .map(end => start + end));

export function randomAlias(taken = () => false) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const alias = aliases[randomInt(aliases.length)];
    if (!taken(alias)) return alias;
  }
  const base = aliases[randomInt(aliases.length)];
  for (let n = 2; ; n++) if (!taken(base + n)) return base + n;
}
