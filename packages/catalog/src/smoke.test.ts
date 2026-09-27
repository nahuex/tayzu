import { describe, expect, it } from 'vitest';

describe('@tayzu/catalog smoke', () => {
  it('loads the package entry point and its workspace dependencies', async () => {
    const [entry, db, observability] = await Promise.all([
      import('./index.js'),
      import('@tayzu/db'),
      import('@tayzu/observability'),
    ]);

    expect(entry).toBeTypeOf('object');
    expect(db).toBeTypeOf('object');
    expect(observability).toBeTypeOf('object');
  });
});
