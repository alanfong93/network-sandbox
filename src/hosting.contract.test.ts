import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const vite = readFileSync(join(root, 'ui/vite.config.ts'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  private?: boolean;
};

export const HOSTED_UI_URL = 'https://alanfong93.github.io/network-sandbox/';

describe('hosted UI contract (#153)', () => {
  it('README names the GitHub Pages URL and does not say there is no hosted demo', () => {
    expect(readme).toContain(HOSTED_UI_URL);
    expect(readme).not.toMatch(/no hosted demo/i);
    expect(readme).not.toMatch(/there is no hosted build/i);
  });

  it('README keeps the local Node path, Docker as optional, #65, and no npm publish', () => {
    expect(readme).toContain('Node.js 22');
    expect(readme).toContain('npm ci');
    expect(readme).toContain('npm run ui:dev');
    expect(readme).toContain('http://localhost:5173');
    expect(readme).toContain('build_container.ps1');
    expect(readme).toContain('#65');
    expect(readme).not.toMatch(/npm publish/i);
  });

  it('Vite emits a relative-base static bundle', () => {
    expect(vite).toMatch(/base:\s*['"]\.\/['"]/);
    expect(vite).toMatch(/outDir:\s*['"]dist['"]/);
  });

  it('CI builds ui/dist and deploys Pages without publishing npm', () => {
    expect(ci).toContain('npm run ui:build');
    expect(ci).toContain('ui/dist');
    expect(ci).toContain('actions/upload-pages-artifact');
    expect(ci).toContain('actions/deploy-pages');
    expect(ci).not.toMatch(/npm publish/);
  });

  it('the package stays private — hosting is not an npm release', () => {
    expect(pkg.private).toBe(true);
  });
});
