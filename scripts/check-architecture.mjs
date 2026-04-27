import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const allowedTopLevel = new Set([
    '.cursor',
    '.git',
    '.venv-sprites',
    'deploy-work',
    'dist',
    'docker',
    'node_modules',
    'public',
    'scripts',
    'server',
    'sgnl-work',
    'sprites',
    'src',
]);
const allowedTopLevelFiles = new Set([
    '.env.example',
    '.gitignore',
    'AGENTS.md',
    'ARCHITECTURE.md',
    'Dockerfile',
    'LICENSE.txt',
    'README.md',
    'docker-compose.yml',
    'index.css',
    'index.html',
    'index.js',
    'package-lock.json',
    'package.json',
    'vite.config.js',
    'wrangler.toml',
]);

const importPatterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const errors = [];

await checkTopLevel();
await checkSourceImports();
await checkRemovedPaths();

if (errors.length) {
    for (const error of errors) console.error(`architecture: ${error}`);
    process.exit(1);
}

console.log('architecture: ok');

async function checkTopLevel() {
    for (const ent of await readdir(root, { withFileTypes: true })) {
        if (ent.name.startsWith('.') && !allowedTopLevel.has(ent.name) && !allowedTopLevelFiles.has(ent.name)) {
            continue;
        }
        if (ent.isDirectory() && !allowedTopLevel.has(ent.name)) {
            errors.push(`unexpected top-level directory ${ent.name}`);
        }
        if (ent.isFile() && !allowedTopLevelFiles.has(ent.name)) {
            errors.push(`unexpected top-level file ${ent.name}`);
        }
    }
}

async function checkSourceImports() {
    const files = await listFiles(root);
    for (const file of files) {
        if (!/\.(js|mjs)$/.test(file)) continue;
        const text = await readFile(path.join(root, file), 'utf8');
        for (const spec of importSpecifiers(text)) {
            if (!spec.startsWith('./') && !spec.startsWith('../')) continue;
            const target = normalize(path.join(path.dirname(file), spec));
            checkBoundary(file, target);
        }
    }
}

async function checkRemovedPaths() {
    const removed = [
        'src/game',
        'src/data',
        'src/mcp',
        'src/renderer',
        'src/ui',
        'src/input',
        'src/net',
        'src/audio',
        'src/app',
        'src/engine/actor',
        'src/engine/entity',
        'src/client/renderer/scene/mechanics',
    ];
    for (const name of removed) {
        try {
            await readdir(path.join(root, name));
            errors.push(`removed path still exists: ${name}`);
        } catch {
            // Path is absent, as expected.
        }
    }
}

function checkBoundary(file, target) {
    if (file.startsWith('src/engine/') && target.startsWith('src/client/')) {
        errors.push(`${file} imports client code via ${target}`);
    }
    if (file.startsWith('src/engine/') && target.startsWith('server/')) {
        errors.push(`${file} imports server code via ${target}`);
    }
    if (file.startsWith('src/shared/') && target.startsWith('src/engine/')) {
        errors.push(`${file} imports engine code via ${target}`);
    }
    if (file.startsWith('src/shared/') && target.startsWith('src/client/')) {
        errors.push(`${file} imports client code via ${target}`);
    }
    if (file.startsWith('src/shared/') && target.startsWith('server/')) {
        errors.push(`${file} imports server code via ${target}`);
    }
    if (file.startsWith('src/client/') && target.startsWith('server/')) {
        errors.push(`${file} imports server code via ${target}`);
    }
    if (file.startsWith('server/') && target.startsWith('src/client/')) {
        errors.push(`${file} imports browser client code via ${target}`);
    }
}

function* importSpecifiers(text) {
    for (const pattern of importPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
            yield match[1];
        }
    }
}

async function listFiles(dir) {
    const out = [];
    for (const ent of await readdir(dir, { withFileTypes: true })) {
        if (shouldSkip(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            out.push(...await listFiles(full));
        } else {
            out.push(normalize(path.relative(root, full)));
        }
    }
    return out;
}

function shouldSkip(name) {
    return name === '.git'
        || name === 'node_modules'
        || name === 'dist'
        || name === 'deploy-work'
        || name === 'sgnl-work'
        || name === '.venv-sprites';
}

function normalize(value) {
    return value.split(path.sep).join('/');
}
