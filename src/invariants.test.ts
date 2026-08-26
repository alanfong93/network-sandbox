import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(path));
    else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('invariants', () => {
  it('does not resolve names, hold zone data, or call anything dns', () => {
    for (const file of walk(srcDir)) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/\bdns\b/i);
    }
  });

  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(join(srcDir, '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
