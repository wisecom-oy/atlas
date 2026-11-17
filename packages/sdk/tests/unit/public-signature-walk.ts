import { dirname } from 'node:path';

import ts from 'typescript';

/**
 * Finds the types named in public signatures that an entry point does not export (issue #784).
 *
 * The walk starts at each exported interface, function and callable type alias, reads the
 * parameter and return types of every signature, and follows any Atlas interface that declares
 * methods (`atlas.outlook`, `atlas.keys`) and any Atlas callable alias (`OperationProgressCallback`).
 *
 * `Camelize<Internal>` is exempt and not descended into. The internal snake_case type is
 * deliberately not public; the converted shape is what reaches the caller.
 */
const EXEMPT_NAMES = new Set(['Camelize']);

interface SurfaceWalk {
  readonly checker: ts.TypeChecker;
  readonly exported: ReadonlySet<ts.Symbol>;
  readonly visited: Set<ts.Symbol>;
  readonly missing: Set<string>;
}

/**
 * Builds a program rooted at an entry point, with the compiler options of a tsconfig.
 *
 * Workspace imports resolve through their export maps to built `.d.ts` files. The tsconfig's
 * project references redirect those to source, as an editor does, so the walk reads the current
 * signatures even in a focused run after a port changed and before a rebuild.
 */
export function create_entry_program(entry_path: string, config_path: string): ts.Program {
  const { config } = ts.readConfigFile(config_path, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(config_path));
  const options = { ...parsed.options, noEmit: true, composite: false, incremental: false };
  const host = ts.createCompilerHost(options);
  // Public on the host interface's implementation, unexported in its type: what tsserver sets.
  Object.assign(host, { useSourceOfProjectReferenceRedirect: () => true });
  return ts.createProgram({
    rootNames: [entry_path],
    options,
    host,
    ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
  });
}

/** Lists workspace files the program read from a built `dist` rather than from source. */
export function find_workspace_files_read_from_dist(program: ts.Program): string[] {
  return program
    .getSourceFiles()
    .map((file) => file.fileName)
    .filter((name) => /\/packages\/[^/]+\/dist\//.test(name) && !name.includes('/node_modules/'));
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

/** Reports a referenced Atlas type that is not exported, then walks into it when it is callable. */
function check_type_reference(walk: SurfaceWalk, node: ts.TypeReferenceNode): void {
  const name = node.typeName.getText();
  if (EXEMPT_NAMES.has(name)) return;
  const at = ts.isQualifiedName(node.typeName) ? node.typeName.right : node.typeName;
  const raw = walk.checker.getSymbolAtLocation(at);
  const symbol = raw ? resolve_alias(walk.checker, raw) : undefined;
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration) {
    // An unresolved name means the walk cannot see that part of the surface. Fail, not pass.
    walk.missing.add(`unresolved: ${name}`);
    return;
  }
  if (symbol.flags & ts.SymbolFlags.TypeParameter) return;
  if (is_atlas_declaration(declaration)) {
    if (!walk.exported.has(symbol)) walk.missing.add(symbol.getName());
    walk_callable_symbol(walk, symbol);
  }
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

/** The function type a type alias names, when it names one. */
function callable_alias_type(declaration: ts.Declaration): ts.FunctionTypeNode | undefined {
  if (!ts.isTypeAliasDeclaration(declaration)) return undefined;
  return ts.isFunctionTypeNode(declaration.type) ? declaration.type : undefined;
}

/**
 * Walks a symbol whose declaration is callable surface: an interface that declares methods, whose
 * property types are API groups to follow, or a type alias of a function type.
 */
function walk_callable_symbol(walk: SurfaceWalk, symbol: ts.Symbol): void {
  if (walk.visited.has(symbol)) return;
  const declarations = symbol.declarations ?? [];
  const aliases = declarations.map(callable_alias_type).filter((node) => node !== undefined);
  const interfaces = declarations.filter(ts.isInterfaceDeclaration);
  const is_api = interfaces.some((declaration) => declaration.members.some(is_callable_member));
  if (aliases.length === 0 && !is_api) return;
  walk.visited.add(symbol);
  aliases.forEach((node) => visit_signature(walk, node));
  if (!is_api) return;
  for (const member of interfaces.flatMap((declaration) => [...declaration.members])) {
    if (ts.isMethodSignature(member)) visit_signature(walk, member);
    else if (ts.isPropertySignature(member) && member.type) visit_type_node(walk, member.type);
  }
}

/** Walks every exported callable surface of an entry point and returns the unexported types. */
export function find_unexported_signature_types(program: ts.Program, entry_path: string): string[] {
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(entry_path);
  const module_symbol = entry ? checker.getSymbolAtLocation(entry) : undefined;
  if (!module_symbol) throw new Error(`No module at ${entry_path}`);
  const exports = checker.getExportsOfModule(module_symbol).map((s) => resolve_alias(checker, s));
  const walk: SurfaceWalk = {
    checker,
    exported: new Set(exports),
    visited: new Set(),
    missing: new Set(),
  };
  for (const symbol of exports) {
    walk_callable_symbol(walk, symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isFunctionDeclaration(declaration)) visit_signature(walk, declaration);
    }
  }
  return [...walk.missing].sort();
}
