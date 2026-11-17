import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every type named in a public SDK signature must be importable from the entry point.
 *
 * The walk starts at each exported interface or function, reads the parameter and return types
 * of every method, and follows any Atlas interface that declares methods (`atlas.outlook`,
 * `atlas.keys`). A type declared in an Atlas package that the entry point does not export is a
 * gap: a consumer can only reach it through `ReturnType` (issue #784).
 *
 * `Camelize<Internal>` is exempt and not descended into. The internal snake_case type is
 * deliberately not public; the converted shape is what reaches the caller.
 */
const SDK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EXEMPT_NAMES = new Set(['Camelize']);

interface SurfaceWalk {
  readonly checker: ts.TypeChecker;
  readonly exported: ReadonlySet<ts.Symbol>;
  readonly visited: Set<ts.Symbol>;
  readonly missing: Set<string>;
}

/** Builds a program rooted at the SDK entry point with the package's own compiler options. */
function create_sdk_program(): { program: ts.Program; entry: ts.SourceFile } {
  const config_path = join(SDK_DIR, 'tsconfig.json');
  const { config } = ts.readConfigFile(config_path, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, SDK_DIR);
  const entry_path = join(SDK_DIR, 'src/index.ts');
  const program = ts.createProgram({
    rootNames: [entry_path],
    options: { ...parsed.options, noEmit: true, composite: false, incremental: false },
  });
  const entry = program.getSourceFile(entry_path);
  if (!entry) throw new Error(`SDK entry point not found at ${entry_path}`);
  return { program, entry };
}

/** Follows re-export aliases to the symbol that carries the declaration. */
function resolve_alias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** True when the declaration lives in an Atlas workspace package, not in a library. */
function is_atlas_declaration(declaration: ts.Declaration): boolean {
  const file = declaration.getSourceFile().fileName;
  return file.includes('/packages/') && !file.includes('/node_modules/');
}

/** Reports a referenced Atlas type that is not exported, then walks into it when it is an API. */
function check_type_reference(walk: SurfaceWalk, node: ts.TypeReferenceNode): void {
  const name = node.typeName.getText();
  if (EXEMPT_NAMES.has(name)) return;
  const at = ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName;
  const raw = walk.checker.getSymbolAtLocation(at);
  if (!raw) return;
  const symbol = resolve_alias(walk.checker, raw);
  if (symbol.flags & ts.SymbolFlags.TypeParameter) return;
  const declaration = symbol.declarations?.[0];
  if (!declaration || !is_atlas_declaration(declaration)) {
    node.typeArguments?.forEach((argument) => visit_type_node(walk, argument));
    return;
  }
  if (!walk.exported.has(symbol)) walk.missing.add(symbol.getName());
  walk_api_symbol(walk, symbol);
  node.typeArguments?.forEach((argument) => visit_type_node(walk, argument));
}

/** Visits every type reference inside a type annotation. */
function visit_type_node(walk: SurfaceWalk, node: ts.Node): void {
  if (ts.isTypeReferenceNode(node)) {
    check_type_reference(walk, node);
    return;
  }
  ts.forEachChild(node, (child) => visit_type_node(walk, child));
}

/** Visits the parameter and return types of one callable declaration. */
function visit_signature(walk: SurfaceWalk, node: ts.SignatureDeclarationBase): void {
  for (const parameter of node.parameters) {
    if (parameter.type) visit_type_node(walk, parameter.type);
  }
  if (node.type) visit_type_node(walk, node.type);
}

/** True when an interface member is callable, so its signature is public surface. */
function is_callable_member(member: ts.TypeElement): boolean {
  if (ts.isMethodSignature(member)) return true;
  return ts.isPropertySignature(member) && !!member.type && ts.isFunctionTypeNode(member.type);
}

/** Walks an interface that declares methods; its property types are API groups to follow. */
function walk_api_symbol(walk: SurfaceWalk, symbol: ts.Symbol): void {
  if (walk.visited.has(symbol)) return;
  const interfaces = (symbol.declarations ?? []).filter(ts.isInterfaceDeclaration);
  if (!interfaces.some((declaration) => declaration.members.some(is_callable_member))) return;
  walk.visited.add(symbol);
  for (const member of interfaces.flatMap((declaration) => [...declaration.members])) {
    if (ts.isMethodSignature(member)) visit_signature(walk, member);
    else if (ts.isPropertySignature(member) && member.type) visit_type_node(walk, member.type);
  }
}

/** Walks every exported interface and function and returns the unexported types it met. */
function find_unexported_signature_types(): string[] {
  const { program, entry } = create_sdk_program();
  const checker = program.getTypeChecker();
  const module_symbol = checker.getSymbolAtLocation(entry);
  if (!module_symbol) throw new Error('SDK entry point has no module symbol');
  const exports = checker.getExportsOfModule(module_symbol).map((s) => resolve_alias(checker, s));
  const walk: SurfaceWalk = {
    checker,
    exported: new Set(exports),
    visited: new Set(),
    missing: new Set(),
  };
  for (const symbol of exports) {
    walk_api_symbol(walk, symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration)) visit_signature(walk, declaration);
    }
  }
  return [...walk.missing].sort();
}

describe('public SDK type exports', () => {
  it('exports every Atlas type named in a public method signature', () => {
    expect(find_unexported_signature_types()).toEqual([]);
  }, 60_000);
});
