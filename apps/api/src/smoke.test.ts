import { describe, expect, it } from 'vitest';

describe('@tayzu/api smoke', () => {
  it('loads the package entry point', async () => {
    const entry = await import('./index.js');

    expect(entry).toBeTypeOf('object');
  });
});
