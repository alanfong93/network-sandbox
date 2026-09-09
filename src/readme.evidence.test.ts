import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from './catalogue';
import { format } from './format';
import { PRESETS } from '../ui/presets';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  private?: boolean;
  engines?: { node?: string };
  scripts?: Record<string, string>;
};

const row1 = CATALOGUE.find((row) => row.id === 1);

describe('README evidence (characterisation)', () => {
  it('package.json is private, Node 22+, and carries the newcomer scripts', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.engines?.node).toBe('>=22');
    expect(pkg.scripts?.test).toBe('vitest run');
    expect(pkg.scripts?.typecheck).toContain('tsc');
    expect(pkg.scripts?.build).toContain('tsc');
    expect(pkg.scripts?.['ui:dev']).toContain('vite');
    expect(pkg.scripts?.['ui:build']).toContain('vite');
  });

  it('the palette ids are the shipped editor boxes, not a device-kind list', () => {
    expect(PRESETS.map((preset) => preset.id)).toEqual([
      'host',
      'switch',
      'unmanaged-switch',
      'router',
      'access-point',
      'modem',
      'l3-switch',
      'resolver',
      'internet',
      'dhcp-server',
    ]);
  });

  it('catalogue row 1 format() is the README example, with no credentials', () => {
    expect(row1).toBeDefined();
    if (!row1) return;
    const sentence = format(row1.example);
    expect(sentence).toBe(
      'Dropped at SW2 port 3 (egress): port is not a member of VLAN 20',
    );
    expect(readme).toContain(sentence);
    expect(readme).toContain('catalogue row 1');
    expect(sentence).not.toMatch(/user-|pass-|token|secret/i);
  });

  it('does not repeat the tripwire overclaims', () => {
    expect(readme).not.toMatch(/no install/i);
    expect(readme).not.toContain('If your design works here, the design is sound');
    expect(readme).not.toContain('PC1  -> sends frame, untagged');
    expect(readme).not.toContain('tags it VLAN 10');
    expect(readme).not.toMatch(/npm publish/i);
  });

  it('names Node 22, npm ci, the UI URL, Docker as optional, and #65', () => {
    expect(readme).toContain('Node.js 22');
    expect(readme).toContain('npm ci');
    expect(readme).toContain('npm run typecheck');
    expect(readme).toContain('npm run ui:dev');
    expect(readme).toContain('http://localhost:5173');
    expect(readme).toContain('https://alanfong93.github.io/network-sandbox/');
    expect(readme).toContain('build_container.ps1');
    expect(readme).toContain('#65');
    expect(readme).toMatch(/private/);
  });

  it('README, CONTRIBUTING and ADR clarifications agree on licence mechanics', () => {
    expect(readme).toMatch(/no CLA/i);
    expect(readme).toMatch(/every relevant copyright holder/i);
    expect(contributing).toMatch(/every relevant copyright holder/i);
    expect(readme).not.toMatch(/nobody gets to take it private/i);
    expect(contributing).not.toMatch(/Nobody here can relicense the project or take it closed/i);
  });

  it('relative README links resolve on disk', () => {
    const hrefs = [...readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1] ?? '');
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      if (href.startsWith('http') || href.startsWith('#') || href.includes('issues/')) {
        continue;
      }
      const path = href.split('#')[0] ?? '';
      expect(existsSync(join(root, path)), href).toBe(true);
    }
  });
});
