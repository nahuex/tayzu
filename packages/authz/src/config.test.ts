import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Minimal reader for the flat "key: value" / nested-map subset used by
// config/cerbos.yaml (no yaml dependency is declared for this package).
type Scalar = string | boolean;
interface Tree {
  [key: string]: Scalar | Tree;
}

function parseSimpleYaml(text: string): Tree {
  const root: Tree = {};
  const stack: { indent: number; node: Tree }[] = [{ indent: -1, node: root }];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/(^|\s)#.*$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line.trim());
    if (!match) throw new Error(`Unsupported YAML line: ${line}`);
    const [, key, value = ''] = match;
    while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.node;
    if (!parent || key === undefined) throw new Error('Malformed YAML');
    if (value === '') {
      const child: Tree = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else if (value === 'true' || value === 'false') {
      parent[key] = value === 'true';
    } else {
      parent[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }
  return root;
}

const configPath = fileURLToPath(new URL('../../../config/cerbos.yaml', import.meta.url));

describe('Cerbos deployment config (config/cerbos.yaml)', () => {
  const config = parseSimpleYaml(readFileSync(configPath, 'utf8'));

  it('sets engine.strictEvaluation to true (a CEL error denies the whole action)', () => {
    const engine = config['engine'] as Tree;
    expect(engine['strictEvaluation']).toBe(true);
  });

  it('sets audit.decisionLogsEnabled to true so denies are visible', () => {
    const audit = config['audit'] as Tree;
    expect(audit['decisionLogsEnabled']).toBe(true);
  });

  it('sets audit.accessLogsEnabled to false', () => {
    const audit = config['audit'] as Tree;
    expect(audit['accessLogsEnabled']).toBe(false);
  });

  it('uses the disk storage driver over the reviewed policies tree, without watching', () => {
    const storage = config['storage'] as Tree;
    const disk = storage['disk'] as Tree;
    expect(storage['driver']).toBe('disk');
    expect(disk['watchForChanges']).toBe(false);
  });
});
