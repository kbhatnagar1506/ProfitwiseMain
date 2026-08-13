/**
 * Declares Vitest's global `describe` / `it` / `expect` to TypeScript.
 *
 * A triple-slash reference is used rather than adding "vitest/globals" to
 * `compilerOptions.types`, because setting that array would switch off the
 * automatic inclusion of every other @types package (node, react, ...).
 */
/// <reference types="vitest/globals" />
