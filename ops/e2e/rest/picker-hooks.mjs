// Module hooks that let Node load the term picker's TypeScript sources as its bundler does: a
// relative import names no extension, a package subpath names no file, and an import of a type is
// not marked as one. Each .ts file is transpiled with the TypeScript the picker itself installs.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let ts;

export function initialize({ picker }) {
  ts = createRequire(`${picker}/package.json`)('typescript');
}

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (/\.[cm]?[jt]s$/.test(specifier) || specifier.startsWith('node:')) throw error;
    if (specifier.startsWith('./') || specifier.startsWith('../')) return next(`${specifier}.ts`, context);
    // A package subpath, which the model library ships as an ES module beside its bundle.
    try {
      return await next(`${specifier}.esm.js`, context);
    } catch {
      return next(`${specifier}.js`, context);
    }
  }
}

export async function load(url, context, next) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context);
  const source = await readFile(fileURLToPath(url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return { format: 'module', source: outputText, shortCircuit: true };
}
