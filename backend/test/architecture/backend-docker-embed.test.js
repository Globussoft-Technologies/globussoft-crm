import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(process.cwd(), '..');

describe('backend Docker landing-form asset', () => {
  test('builds from the repository root and packages the web-form document', () => {
    const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');
    const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'backend', 'Dockerfile'), 'utf8');
    const dockerignore = fs.readFileSync(path.join(repositoryRoot, '.dockerignore'), 'utf8');

    expect(compose).toMatch(/backend:\s+[\s\S]*?build:\s+[\s\S]*?context:\s*\.\s+[\s\S]*?dockerfile:\s*backend\/Dockerfile/);
    expect(dockerfile).toContain('COPY backend/package.json backend/package-lock.json ./');
    expect(dockerfile).toContain('COPY backend/ .');
    expect(dockerignore).toMatch(/^\*\*\/node_modules$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.env$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.env\.\*$/m);
    expect(dockerfile).toContain(
      'COPY frontend/public/embed/web-form.html /frontend/public/embed/web-form.html',
    );
  });
});
