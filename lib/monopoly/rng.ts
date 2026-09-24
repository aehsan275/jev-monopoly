export function normalizeSeed(seed: number) {
  const normalized = seed >>> 0;
  return normalized === 0 ? 0x6d2b79f5 : normalized;
}

export function nextRandom(state: number) {
  let value = normalizeSeed(state);
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  const nextState = value >>> 0;
  return { state: nextState, value: nextState / 0x1_0000_0000 };
}

export function shuffle<T>(items: readonly T[], seed: number) {
  const output = [...items];
  let rngState = normalizeSeed(seed);
  let draws = 0;
  for (let index = output.length - 1; index > 0; index -= 1) {
    const next = nextRandom(rngState);
    rngState = next.state;
    draws += 1;
    const swapIndex = Math.floor(next.value * (index + 1));
    [output[index], output[swapIndex]] = [output[swapIndex], output[index]];
  }
  return { items: output, state: rngState, draws };
}
