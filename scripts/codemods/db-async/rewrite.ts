/**
 * Turns the DB closure (closure.ts) into text edits, file by file.
 *
 * Every edit is an insertion or a replacement on the original text, so
 * comments and layout carry over. The rules:
 *
 * - `.all()`, `.run()` terminals are dropped and the builder awaited;
 *   `.get()` becomes `await first(builder.limit(1))` (no `.limit` when the
 *   builder has one; `(await first(…))!` when `.get()` was typed without
 *   undefined, as after `.returning()`); raw `db.run/all/get(sql)` become
 *   `execRaw(sql, tx?)`.
 * - `db.transaction((tx) => …)` becomes `await appDb.transaction(async (tx) => …)`.
 * - Calls to functions that became async are awaited (`(await f()).x` where
 *   precedence needs it; `void f()` becomes `await f()`), and the functions
 *   around them become async, with `Promise<…>` return types, signatures and
 *   overloads included.
 * - Inside a risky context (closure.ts) the await is inserted but the
 *   function is left synchronous, so the compiler reports the site.
 * - The default `db` import becomes `appDb`; the synchronous type aliases
 *   become `DbExecutor` / `AppTx` / `AppDb` from @/src/lib/db/types.
 * - `asc`/`desc` come from @/src/lib/db/ops; `like` becomes
 *   `containsText`/`likeText`; `ifnull` becomes `coalesce`; the known SQLite
 *   JSON, LIKE…ESCAPE and lower(x) = ? templates become the ops helpers.
 *
 * Files under src/lib/db/**, the HA cluster and ClickHouse code are never
 * edited.
 */
import ts from "typescript";
import {
  hasAsyncModifier,
  isAwaited,
  isFunctionWithBody,
  outerExpression,
  RISK_DESCRIPTIONS,
  type Closure,
  type Finding,
  type Member,
} from "./closure";
import { areaOf, isExcluded, relPath } from "./project";

export interface Edit {
  start: number;
  end: number;
  text: string;
  /** Among insertions at one position: lower first. */
  order: number;
}

export class EditConflictError extends Error {}

/** Applies non-overlapping edits to `text`. */
export function applyEdits(text: string, edits: readonly Edit[], fileName = "<file>"): string {
  const sorted = [...edits].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const aInsert = a.start === a.end;
    const bInsert = b.start === b.end;
    if (aInsert !== bInsert) return aInsert ? -1 : 1;
    return a.order - b.order;
  });
  let output = "";
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) {
      const { line } = lineOf(text, edit.start);
      throw new EditConflictError(`${fileName}:${line}: overlapping edits`);
    }
    output += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return output + text.slice(cursor);
}

function lineOf(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < position && index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      line++;
      lineStart = index + 1;
    }
  }
  return { line, column: position - lineStart + 1 };
}

export interface FileResult {
  file: string;
  before: string;
  after: string;
  edits: Edit[];
  error?: string;
}

/** Where an offset of the original text is after the edits. */
export function mapOffset(edits: readonly Edit[], offset: number): number {
  let delta = 0;
  for (const edit of edits) {
    const insertedBefore = edit.start === edit.end ? edit.start < offset || (edit.start === offset && edit.order < 0) : edit.end <= offset;
    if (insertedBefore) delta += edit.text.length - (edit.end - edit.start);
  }
  return offset + delta;
}

export interface RewriteOptions {
  /** Only these repository-relative files (default: every file the closure touches). */
  include?: (file: string) => boolean;
}

export interface RewriteResult {
  files: FileResult[];
  /** Manual and review findings in the selected files. */
  findings: Finding[];
  /** Await sites the selection leaves out (they are in files not selected). */
  outsideSelection: number;
}

const OPS_MODULE = "@/src/lib/db/ops";
const TYPES_MODULE = "@/src/lib/db/types";
const SQLITE_ONLY_SQL =
  /\b(ifnull|json_each|json_valid|json_extract|json_group_array|json_group_object|json_set|json_insert|json_remove|strftime|julianday|unixepoch|datetime|glob|last_insert_rowid|rowid|changes|group_concat|iif|printf|instr|nocase|pragma|sqlite_\w+|insert\s+or|replace\s+into|like)\b/i;

export function rewrite(closure: Closure, options: RewriteOptions = {}): RewriteResult {
  const { program, root } = closure;
  const rel = (sf: ts.SourceFile) => relPath(sf.fileName, root);
  const include = options.include ?? (() => true);

  // Members and sites by file.
  const membersByFile = new Map<string, Member[]>();
  for (const member of closure.members.values()) {
    if (!member.converts) continue;
    const list = membersByFile.get(member.file) ?? [];
    list.push(member);
    membersByFile.set(member.file, list);
  }

  const candidates = new Set<string>(closure.files);
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || sf.fileName.includes("/node_modules/")) continue;
    const file = rel(sf);
    if (!/^(src|app|ee|tests)\//.test(file) && file !== "proxy.ts") continue;
    if (/\b(drizzle-orm|ifnull|BaseSQLiteDatabase|typeof db\b|ReturnType<)/.test(sf.text) || /from ["'][^"']*\/db["']/.test(sf.text)) candidates.add(file);
  }

  const results: FileResult[] = [];
  let outsideSelection = 0;
  for (const site of closure.awaitSites.values()) {
    const file = rel(site.node.getSourceFile());
    if (!include(file) && !isExcluded(file) && !site.skip) outsideSelection++;
  }

  for (const file of [...candidates].sort()) {
    if (isExcluded(file) || !include(file)) continue;
    const sf = program.getSourceFile(`${root}/${file}`);
    if (!sf) continue;
    const fileRewriter = new FileRewriter(closure, sf, membersByFile.get(file) ?? []);
    try {
      const edits = fileRewriter.collect();
      if (edits.length === 0) continue;
      const after = applyEdits(sf.text, edits, file);
      if (after !== sf.text) results.push({ file, before: sf.text, after, edits });
    } catch (error) {
      results.push({ file, before: sf.text, after: sf.text, edits: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  const findings = closure.findings.filter((finding) => include(finding.file) || isExcluded(finding.file));
  return { files: results, findings, outsideSelection };
}

// ── One file ──

type HelperName =
  | "first" | "execRaw" | "asc" | "desc" | "likeText" | "containsText" | "lowerEquals" | "jsonTextAt" | "jsonArrayIncludesAny" | "sqlFalse";
type TypeName = "AppDb" | "AppTx" | "DbExecutor";

class FileRewriter {
  private readonly edits: Edit[] = [];
  private readonly checker: ts.TypeChecker;
  private readonly text: string;
  private readonly helpers = new Set<HelperName>();
  private readonly types = new Set<TypeName>();
  /** drizzle-orm import specifiers moved to ops (local names). */
  private readonly movedToOps = new Map<string, string>();
  /** Ranges whose original identifiers disappear (for unused-import cleanup). */
  private readonly removedRanges: Array<[number, number]> = [];
  private readonly localNames: Set<string>;
  private renameDb = false;
  private dbLocalName: string | undefined;

  constructor(private readonly closure: Closure, private readonly sf: ts.SourceFile, private readonly members: Member[]) {
    this.checker = closure.checker;
    this.text = sf.text;
    this.localNames = collectDeclaredNames(sf);
  }

  collect(): Edit[] {
    // Types first: the db references inside replaced types are not renamed.
    this.syncTypes();
    this.facadeImport();
    this.dbSites();
    this.awaitSites();
    this.asyncMembers();
    this.returnTypeQueries();
    this.queryHelpers();
    this.sqlTemplates();
    if (this.edits.length === 0) return [];
    this.imports();
    return this.edits;
  }

  // ── Edit helpers ──

  private insert(position: number, text: string, order = 0): void {
    this.edits.push({ start: position, end: position, text, order });
  }

  private replace(start: number, end: number, text: string): void {
    this.edits.push({ start, end, text, order: 0 });
    this.removedRanges.push([start, end]);
  }

  private start(node: ts.Node): number {
    return node.getStart(this.sf);
  }

  private helper(name: HelperName): string {
    this.helpers.add(name);
    return this.helperLocal(name);
  }

  private helperLocal(name: HelperName): string {
    const moved = this.movedToOps.get(name);
    if (moved) return moved;
    return this.localNames.has(name) && !this.importedFromOps(name) ? `db${name[0].toUpperCase()}${name.slice(1)}` : name;
  }

  private importedFromOps(name: string): boolean {
    return this.sf.statements.some((statement) =>
      ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) &&
      /\/db\/ops$/.test(statement.moduleSpecifier.text) &&
      !!statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some((e) => e.name.text === name)
    );
  }

  private appDbName(): string {
    return "appDb";
  }

  /** `(` + `await ` before `node` and `)` after it when precedence needs it. */
  private awaitNode(node: ts.Expression, opening: string, closing: string, forceParens = false): void {
    const parens = forceParens || needsParens(node);
    const width = node.end - this.start(node);
    let prefix = parens ? `(${opening}` : opening;
    if (parens && startsStatement(node, this.sf) && !previousTokenEndsStatement(this.text, this.start(node))) prefix = `;${prefix}`;
    this.insert(this.start(node), prefix, -width);
    const suffix = `${closing}${parens ? ")" : ""}`;
    if (suffix) this.insert(node.end, suffix, width);
  }

  // ── The default db import ──

  private facadeImport(): void {
    for (const statement of this.sf.statements) {
      if (!ts.isImportDeclaration(statement) || !this.isFacadeImport(statement)) continue;
      const clause = statement.importClause;
      if (!clause) continue;
      const defaultName = clause.name?.text;
      const namedDb = clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.find((e) => (e.propertyName ?? e.name).text === "db") : undefined;
      if (!defaultName && !namedDb) continue;
      this.dbLocalName = defaultName ?? namedDb!.name.text;
      this.renameDb = true;
    }
    if (!this.renameDb || !this.dbLocalName) return;
    const dbSymbol = this.closure.syncDbSymbol;
    // Rename the references.
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node) && node.text === this.dbLocalName) {
        const parent = node.parent;
        if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
        if (ts.isPropertyAssignment(parent) && parent.name === node) return;
        let symbol = ts.isShorthandPropertyAssignment(parent)
          ? this.checker.getShorthandAssignmentValueSymbol(parent)
          : this.checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
        if (!symbol || symbol !== dbSymbol) return;
        const start = this.start(node);
        if (this.removedRanges.some(([s, e]) => s <= start && node.end <= e)) return;
        if (ts.isShorthandPropertyAssignment(parent)) {
          this.replace(this.start(node), node.end, `${node.text}: ${this.appDbName()}`);
        } else {
          this.replace(this.start(node), node.end, this.appDbName());
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
  }

  private importsDb(statement: ts.ImportDeclaration): boolean {
    const clause = statement.importClause;
    if (!clause) return false;
    if (clause.name) return true;
    return !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.some((e) => (e.propertyName ?? e.name).text === "db");
  }

  private isFacadeImport(statement: ts.ImportDeclaration): boolean {
    const symbol = this.checker.getSymbolAtLocation(statement.moduleSpecifier);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return !!declaration && ts.isSourceFile(declaration) && relPath(declaration.fileName, this.closure.root) === "src/lib/db.ts";
  }

  // ── Drizzle terminals, raw SQL, transactions ──

  private dbSites(): void {
    for (const site of this.closure.dbSites.values()) {
      if (site.node.getSourceFile() !== this.sf) continue;
      const call = site.node;
      const access = call.expression as ts.PropertyAccessExpression;
      const receiver = access.expression;
      if (site.kind === "transaction") {
        if (!site.sync || site.awaited) continue;
        this.awaitNode(call, "await ", "");
        continue;
      }
      if (site.kind.startsWith("raw-")) {
        this.rawSql(site.kind, call, receiver, site.awaited);
        continue;
      }
      if (site.kind === "values") {
        if (!site.awaited) this.awaitNode(call, "await ", "");
        continue;
      }
      if (call.arguments.length > 0) continue; // prepared statement with placeholders: manual
      const removeFrom = terminalStart(this.text, receiver, access, this.sf);
      if (site.kind === "get") {
        const firstName = this.helper("first");
        const limit = site.addLimit ? ".limit(1)" : "";
        const nonNull = site.nonUndefined;
        if (site.awaited) {
          // `await x.get()` (rare): first() is awaited already by the outer await.
          this.insert(this.start(call), `${firstName}(`, -(call.end - this.start(call)));
          this.replace(removeFrom.withLimit(limit), call.end, `${limit})`);
          continue;
        }
        const parens = nonNull || needsParens(call);
        const width = call.end - this.start(call);
        let prefix = `${parens ? "(" : ""}await ${firstName}(`;
        if (parens && startsStatement(call, this.sf) && !previousTokenEndsStatement(this.text, this.start(call))) prefix = `;${prefix}`;
        this.insert(this.start(call), prefix, -width);
        this.replace(removeFrom.withLimit(limit), call.end, `${limit})${parens ? ")" : ""}${nonNull ? "!" : ""}`);
        continue;
      }
      // all / run: drop the terminal, await the builder.
      if (site.awaited) {
        this.replace(removeFrom.plain, call.end, "");
        continue;
      }
      const parens = needsParens(call);
      const width = call.end - this.start(call);
      let prefix = parens ? "(await " : "await ";
      if (parens && startsStatement(call, this.sf) && !previousTokenEndsStatement(this.text, this.start(call))) prefix = `;${prefix}`;
      this.insert(this.start(call), prefix, -width);
      this.replace(removeFrom.plain, call.end, parens ? ")" : "");
    }
  }

  private rawSql(kind: string, call: ts.CallExpression, receiver: ts.Expression, awaited: boolean): void {
    const query = call.arguments[0];
    if (!query) return;
    const execRaw = this.helper("execRaw");
    const typeArguments = call.typeArguments ? `<${call.typeArguments.map((t) => t.getText(this.sf)).join(", ")}>` : "";
    const receiverIsDefaultDb = ts.isIdentifier(receiver) && this.isSyncDb(receiver);
    const target = receiverIsDefaultDb ? "" : `, ${receiver.getText(this.sf)}`;
    const head = kind === "raw-get" ? `${this.helper("first")}(${execRaw}${typeArguments}(` : `${execRaw}${typeArguments}(`;
    const tail = kind === "raw-get" ? `${target}))` : `${target})`;
    // Replace `db.get<T>(` with the head, keep the query text, replace `)` with the tail.
    this.replace(this.start(call), this.start(query), awaited ? head : `await ${head}`);
    this.replace(query.end, call.end, tail);
    if (!awaited && needsParens(call)) {
      this.insert(this.start(call), "(", -1e9);
      this.insert(call.end, ")", 1e9);
    }
  }

  private isSyncDb(identifier: ts.Identifier): boolean {
    let symbol = this.checker.getSymbolAtLocation(identifier);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    return !!symbol && symbol === this.closure.syncDbSymbol;
  }

  // ── Calls that now return a Promise ──

  private awaitSites(): void {
    for (const site of this.closure.awaitSites.values()) {
      if (site.node.getSourceFile() !== this.sf || site.skip || isAwaited(site.node)) continue;
      if (site.replaceVoid) {
        const voidExpression = outerExpression(site.node).parent as ts.VoidExpression;
        this.replace(this.start(voidExpression), this.start(voidExpression.expression), "await ");
        continue;
      }
      this.awaitNode(site.node as ts.Expression, "await ", "");
    }
  }

  // ── async and Promise<…> ──

  private asyncMembers(): void {
    for (const member of this.members) {
      const node = member.node;
      if (isFunctionWithBody(node)) {
        if (!hasAsyncModifier(node)) this.insert(asyncPosition(node, this.sf), "async ", 1);
        if (node.type) this.wrapReturnType(node.type);
        // Overload signatures of the same function.
        if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
          const symbol = this.checker.getSymbolAtLocation(node.name);
          for (const declaration of symbol?.declarations ?? []) {
            if (declaration === node || declaration.getSourceFile() !== this.sf) continue;
            if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && !declaration.body && declaration.type) {
              this.wrapReturnType(declaration.type);
            }
          }
        }
      } else {
        const type = (node as ts.SignatureDeclarationBase).type;
        if (type) this.wrapReturnType(type);
      }
    }
  }

  private wrapReturnType(type: ts.TypeNode): void {
    if (ts.isTypePredicateNode(type)) return;
    const resolved = this.checker.getTypeFromTypeNode(type);
    if (isPromiseTypeNode(type) || this.checker.getPropertyOfType(resolved, "then")) return;
    const width = type.end - this.start(type);
    this.insert(this.start(type), "Promise<", -width);
    this.insert(type.end, ">", width);
  }

  // ── ReturnType<typeof f> of a function that became async ──

  private returnTypeQueries(): void {
    const visit = (node: ts.Node): void => {
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "ReturnType" && node.typeArguments?.length === 1) {
        const parent = node.parent;
        const alreadyAwaited = ts.isTypeReferenceNode(parent) && ts.isIdentifier(parent.typeName) && parent.typeName.text === "Awaited";
        if (!alreadyAwaited && this.namesConvertingFunction(node.typeArguments[0])) {
          const width = node.end - this.start(node);
          this.insert(this.start(node), "Awaited<", -width);
          this.insert(node.end, ">", width);
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
  }

  /** The function type `type` names (typeof f, T["f"], …) is one that becomes async. */
  private namesConvertingFunction(type: ts.TypeNode): boolean {
    const signatures = this.checker.getTypeFromTypeNode(type).getCallSignatures();
    return signatures.some((signature) => {
      let declaration: ts.Node | undefined = signature.getDeclaration();
      if (declaration && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && !declaration.body && declaration.name) {
        const symbol = this.checker.getSymbolAtLocation(declaration.name);
        declaration = symbol?.declarations?.find((d) => (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.body) ?? declaration;
      }
      return !!declaration && !!this.closure.members.get(declaration)?.converts;
    });
  }

  // ── Synchronous database types ──

  private syncTypes(): void {
    const aliasReplacements = new Map<ts.Symbol, TypeName>();
    const handled = new Set<ts.Node>();
    // Type aliases whose whole type is a synchronous database type.
    for (const statement of this.sf.statements) {
      if (!ts.isTypeAliasDeclaration(statement)) continue;
      const replacement = this.syncTypeReplacement(statement.type);
      if (!replacement) continue;
      handled.add(statement.type);
      this.types.add(replacement);
      const exported = (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported) {
        this.replace(this.start(statement.type), statement.type.end, replacement);
        continue;
      }
      const symbol = this.checker.getSymbolAtLocation(statement.name);
      if (symbol) aliasReplacements.set(symbol, replacement);
      this.removeStatement(statement);
    }
    const visit = (node: ts.Node): void => {
      if (handled.has(node)) return;
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const symbol = this.checker.getSymbolAtLocation(node.typeName);
        const replacement = symbol ? aliasReplacements.get(symbol) : undefined;
        if (replacement && !node.typeArguments) {
          this.replace(this.start(node), node.end, replacement);
          return;
        }
      }
      if (ts.isTypeNode(node)) {
        const replacement = this.syncTypeReplacement(node);
        if (replacement) {
          this.types.add(replacement);
          this.replace(this.start(node), node.end, replacement);
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
  }

  /** The async type for a synchronous database type node, if it is one. */
  private syncTypeReplacement(node: ts.TypeNode): TypeName | undefined {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "BaseSQLiteDatabase") {
      const first = node.typeArguments?.[0];
      if (first && ts.isLiteralTypeNode(first) && ts.isStringLiteral(first.literal) && first.literal.text === "sync") return "DbExecutor";
    }
    if (ts.isIndexedAccessTypeNode(node)) {
      const text = node.getText(this.sf).replace(/\s+/g, "");
      const match = /^Parameters<Parameters<typeof(\w+)\.transaction>\[0\]>\[0\]$/.exec(text);
      if (match && this.typeQueryTargetsSyncDb(node)) return "AppTx";
    }
    if (ts.isTypeQueryNode(node) && ts.isIdentifier(node.exprName) && this.isSyncDb(node.exprName)) return "AppDb";
    return undefined;
  }

  private typeQueryTargetsSyncDb(node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node) => {
      if (found) return;
      if (ts.isTypeQueryNode(child)) {
        const name = ts.isQualifiedName(child.exprName) ? leftmostIdentifier(child.exprName) : child.exprName;
        if (ts.isIdentifier(name) && this.isSyncDb(name)) found = true;
        return;
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }

  private removeStatement(statement: ts.Statement): void {
    let start = this.start(statement);
    // Its doc comment goes with it.
    const comments = ts.getLeadingCommentRanges(this.text, statement.getFullStart()) ?? [];
    const last = comments[comments.length - 1];
    if (last && /^\s*$/.test(this.text.slice(last.end, start))) start = last.pos;
    let end = statement.end;
    if (this.text[end] === "\n") end++;
    else if (this.text.slice(end, end + 2) === "\r\n") end += 2;
    // Its indentation goes too, and one of two blank lines around it.
    const lineStart = this.text.lastIndexOf("\n", start - 1) + 1;
    if (/^[ \t]*$/.test(this.text.slice(lineStart, start))) start = lineStart;
    const blankBefore = /\n[ \t]*\n$/.test(this.text.slice(Math.max(0, start - 64), start)) || start === 0;
    const blankAfter = /^[ \t]*\r?\n/.exec(this.text.slice(end));
    if (blankBefore && blankAfter) end += blankAfter[0].length;
    this.replace(start, end, "");
  }

  // ── asc/desc/like ──

  private queryHelpers(): void {
    for (const statement of this.sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "drizzle-orm") continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings) || statement.importClause?.isTypeOnly) continue;
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if ((imported === "asc" || imported === "desc") && !element.isTypeOnly) {
          this.movedToOps.set(imported, element.name.text);
          this.helpers.add(imported);
        }
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && this.importedFromDrizzle(node.expression, "like")) {
        const [column, pattern] = node.arguments;
        if (column && pattern) {
          const contained = containedPattern(pattern);
          if (contained) {
            this.replace(this.start(node.expression), node.expression.end, this.helper("containsText"));
            this.replace(this.start(pattern), this.start(contained), "");
            this.replace(contained.end, pattern.end, "");
            this.addFinding("like-semantics", node);
          } else {
            this.replace(this.start(node.expression), node.expression.end, this.helper("likeText"));
            const literal = ts.isStringLiteral(pattern) || ts.isNoSubstitutionTemplateLiteral(pattern);
            if (!literal || pattern.text.includes("\\")) this.addFinding("like-semantics", node);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
  }

  private importedFromDrizzle(identifier: ts.Identifier, name: string): boolean {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    if (!symbol || !(symbol.flags & ts.SymbolFlags.Alias)) return false;
    const declaration = symbol.declarations?.[0];
    if (!declaration || !ts.isImportSpecifier(declaration)) return false;
    const importDeclaration = declaration.parent.parent.parent;
    return ts.isStringLiteral(importDeclaration.moduleSpecifier) && importDeclaration.moduleSpecifier.text === "drizzle-orm" &&
      (declaration.propertyName ?? declaration.name).text === name;
  }

  private addFinding(kind: "like-semantics" | "sqlite-sql" | "json-text", node: ts.Node, message?: string): void {
    const { line, character } = this.sf.getLineAndCharacterOfPosition(this.start(node));
    const file = relPath(this.sf.fileName, this.closure.root);
    if (this.closure.findings.some((f) => f.kind === kind && f.file === file && f.line === line + 1 && f.column === character + 1)) return;
    this.closure.findings.push({
      kind,
      manual: kind === "sqlite-sql",
      file,
      line: line + 1,
      column: character + 1,
      scope: file.startsWith("tests/") ? "tests" : "production",
      area: areaOf(file),
      message: message ?? RISK_DESCRIPTIONS[kind],
      code: node.getText(this.sf).replace(/\s+/g, " ").slice(0, 160),
      node,
    });
  }

  // ── sql`` templates ──

  private sqlTemplates(): void {
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && this.importedFromDrizzle(node.tag, "sql")) {
        if (this.sqlTemplate(node)) return;
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
  }

  /** Rewrites one template; true when it replaced the whole template. */
  private sqlTemplate(node: ts.TaggedTemplateExpression): boolean {
    const template = node.template;
    if (ts.isNoSubstitutionTemplateLiteral(template)) {
      if (/^\s*0\s*$/.test(template.text)) {
        this.replace(this.start(node), node.end, `${this.helper("sqlFalse")}()`);
        return true;
      }
      this.ifnullToCoalesce(template);
      this.reportSqliteOnly(node, [template.text]);
      return false;
    }
    const parts = [template.head.text, ...template.templateSpans.map((span) => span.literal.text)];
    const spans = template.templateSpans.map((span) => span.expression);
    const normalized = parts.map((part) => part.replace(/\s+/g, " ").trim().toLowerCase());

    // lower(${a}) = ${b}
    if (spans.length === 2 && normalized[0] === "lower(" && normalized[1] === ") =" && normalized[2] === "") {
      this.helperCall(node, "lowerEquals", spans[0], spans[1]);
      return true;
    }
    // ${a} LIKE ${b} ESCAPE '\'
    if (spans.length === 2 && normalized[0] === "" && normalized[1] === "like" && /^escape '\\\\?'$/.test(normalized[2])) {
      this.helperCall(node, "likeText", spans[0], spans[1]);
      return true;
    }
    // case when json_valid(${a}) then [cast(]json_extract(${a}, '$.x.y')[ as text)] end
    if (spans.length === 2 && normalized[0] === "case when json_valid(" &&
      (normalized[1] === ") then cast(json_extract(" || normalized[1] === ") then json_extract(") && sameText(spans[0], spans[1], this.sf)) {
      const cast = normalized[1].includes("cast(");
      const tail = parts[2].replace(/\s+/g, " ").trim();
      const match = (cast ? /^, '\$((?:\.[a-z_][a-z0-9_]*|\[\d+\])+)'\) as text\) end$/i : /^, '\$((?:\.[a-z_][a-z0-9_]*|\[\d+\])+)'\) end$/i).exec(tail);
      if (match) {
        const path = [...match[1].matchAll(/\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g)].map((m) => (m[1] !== undefined ? JSON.stringify(m[1]) : m[2]));
        this.replace(this.start(node), this.start(spans[0]), `${this.typePrefix(node)}${this.helper("jsonTextAt")}(`);
        this.replace(spans[0].end, node.end, `, [${path.join(", ")}])${this.typeSuffix(node)}`);
        // Without the cast, SQLite returned numbers and booleans as such; jsonTextAt returns text.
        if (!cast) this.addFinding("json-text", node);
        return true;
      }
    }
    // exists (select 1 from json_each(case when json_valid(${a}) then ${a} else '[]' end)
    //   where json_each.value in (${sql.join(values.map((v) => sql`${v}`), sql`, `)}))
    if (spans.length === 3 && normalized[0] === "exists (select 1 from json_each(case when json_valid(" &&
      normalized[1] === ") then" && normalized[2] === "else '[]' end) where json_each.value in (" && normalized[3] === "))" &&
      sameText(spans[0], spans[1], this.sf)) {
      const values = joinedValues(spans[2]);
      if (values) {
        this.replace(this.start(node), this.start(spans[0]), `${this.typePrefix(node)}${this.helper("jsonArrayIncludesAny")}(`);
        this.replace(spans[0].end, this.start(values), ", ");
        this.replace(values.end, node.end, `)${this.typeSuffix(node)}`);
        return true;
      }
    }
    this.ifnullToCoalesce(template.head);
    for (const span of template.templateSpans) this.ifnullToCoalesce(span.literal);
    this.reportSqliteOnly(node, parts);
    return false;
  }

  private helperCall(node: ts.TaggedTemplateExpression, name: HelperName, first: ts.Expression, second: ts.Expression): void {
    this.replace(this.start(node), this.start(first), `${this.typePrefix(node)}${this.helper(name)}(`);
    this.replace(first.end, this.start(second), ", ");
    this.replace(second.end, node.end, `)${this.typeSuffix(node)}`);
  }

  /** sql<T>`…` keeps its type: sql<T>`${helper(…)}`. */
  private typePrefix(node: ts.TaggedTemplateExpression): string {
    const typeArguments = node.typeArguments;
    return typeArguments && typeArguments.length === 1 ? `${node.tag.getText(this.sf)}<${typeArguments[0].getText(this.sf)}>\`\${` : "";
  }

  private typeSuffix(node: ts.TaggedTemplateExpression): string {
    return node.typeArguments && node.typeArguments.length === 1 ? "}`" : "";
  }

  private ifnullToCoalesce(literal: ts.TemplateLiteralLikeNode | ts.NoSubstitutionTemplateLiteral): void {
    const start = this.start(literal);
    const source = this.text.slice(start, literal.end);
    for (const match of source.matchAll(/\bifnull(?=\s*\()/gi)) {
      this.replace(start + match.index!, start + match.index! + match[0].length, "coalesce");
    }
  }

  private reportSqliteOnly(node: ts.TaggedTemplateExpression, parts: string[]): void {
    const remaining = parts.map((part) => part.replace(/\bifnull(?=\s*\()/gi, "coalesce"));
    if (remaining.some((part) => SQLITE_ONLY_SQL.test(part))) this.addFinding("sqlite-sql", node);
  }

  // ── Imports ──

  private imports(): void {
    const quote = this.text.includes("from '") && !this.text.includes('from "') ? "'" : '"';
    const semicolon = /from ["'][^"']+["'];/.test(this.text) || !/from ["'][^"']+["']\s*\n/.test(this.text);
    const end = semicolon ? ";" : "";
    const newImports: string[] = [];

    // The facade import: db → appDb (the one that imports db; others stay).
    let appDbImported = false;
    for (const statement of this.sf.statements) {
      if (!ts.isImportDeclaration(statement) || !this.renameDb || !this.isFacadeImport(statement) || !this.importsDb(statement)) continue;
      const clause = statement.importClause!;
      const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.filter((e) => (e.propertyName ?? e.name).text !== "db").map((e) => e.getText(this.sf)) : [];
      const usesAppDb = this.edits.some((edit) => edit.text.includes(this.appDbName()));
      if (usesAppDb && !appDbImported && !named.includes(this.appDbName())) named.unshift(this.appDbName());
      appDbImported = true;
      if (named.length === 0) {
        this.removeStatement(statement);
      } else {
        const typeOnly = clause.isTypeOnly ? "type " : "";
        this.replace(this.start(statement), statement.end,
          `import ${typeOnly}{ ${named.join(", ")} } from ${statement.moduleSpecifier.getText(this.sf)}${end}`);
      }
    }

    // drizzle-orm: drop what moved to ops and what is no longer used.
    for (const statement of this.sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      if (!clause || !bindings || !ts.isNamedImports(bindings)) continue;
      if (this.isFacadeImport(statement) && this.renameDb && this.importsDb(statement)) continue;
      const keep: string[] = [];
      let changed = false;
      for (const element of bindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (statement.moduleSpecifier.text === "drizzle-orm" && this.movedToOps.has(imported) && !element.isTypeOnly && !clause.isTypeOnly) {
          changed = true;
          continue;
        }
        if (this.becameUnused(element.name)) {
          changed = true;
          continue;
        }
        keep.push(element.getText(this.sf));
      }
      const defaultKept = clause.name && !this.becameUnused(clause.name) ? clause.name.text : undefined;
      if (clause.name && !defaultKept) changed = true;
      if (!changed) continue;
      if (keep.length === 0 && !defaultKept) {
        this.removeStatement(statement);
        continue;
      }
      const typeOnly = clause.isTypeOnly ? "type " : "";
      const parts = [defaultKept, keep.length > 0 ? `{ ${keep.join(", ")} }` : undefined].filter(Boolean).join(", ");
      this.replace(this.start(statement), statement.end, `import ${typeOnly}${parts} from ${statement.moduleSpecifier.getText(this.sf)}${end}`);
    }
    // Namespace and default imports that only the removed code used (import * as schema).
    for (const statement of this.sf.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) && !clause.name && this.becameUnused(clause.namedBindings.name)) {
        this.removeStatement(statement);
      } else if (clause.name && !clause.namedBindings && !(this.renameDb && this.isFacadeImport(statement) && this.importsDb(statement)) && this.becameUnused(clause.name)) {
        this.removeStatement(statement);
      }
    }

    // ops helpers.
    const helpers = [...this.helpers].sort();
    if (helpers.length > 0) {
      const specifiers = helpers.map((name) => {
        const local = this.helperLocal(name);
        return local === name ? name : `${name} as ${local}`;
      });
      this.mergeImport(OPS_MODULE, specifiers, false, newImports, quote, end);
    }
    const types = [...this.types].sort();
    if (types.length > 0) this.mergeImport(TYPES_MODULE, types, true, newImports, quote, end);

    if (newImports.length > 0) {
      const lastImport = [...this.sf.statements].reverse().find((s) => ts.isImportDeclaration(s));
      if (lastImport) {
        // After the last import, or where it was when the rewrite removed it.
        const removal = this.edits.find((edit) => edit.end > edit.start && edit.start < lastImport.end && lastImport.end <= edit.end);
        if (removal) this.insert(removal.start, `${newImports.join("\n")}\n`, 1e9);
        else this.insert(lastImport.end, `\n${newImports.join("\n")}`, 1e9);
      } else {
        const directive = this.sf.statements.find((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression));
        const position = directive ? directive.end : 0;
        this.insert(position, directive ? `\n${newImports.join("\n")}` : `${newImports.join("\n")}\n`, 1e9);
      }
    }
  }

  private mergeImport(moduleName: string, names: string[], typeOnly: boolean, newImports: string[], quote: string, end: string): void {
    const existing = this.sf.statements.find((s): s is ts.ImportDeclaration =>
      ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) &&
      (s.moduleSpecifier.text === moduleName || s.moduleSpecifier.text.endsWith(moduleName.replace("@/src/lib", ""))) &&
      !!s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) && !s.importClause.name &&
      !!s.importClause.isTypeOnly === typeOnly
    );
    if (existing) {
      const bindings = existing.importClause!.namedBindings as ts.NamedImports;
      const present = new Set(bindings.elements.map((e) => e.getText(this.sf)));
      const missing = names.filter((name) => !present.has(name));
      if (missing.length === 0) return;
      const all = [...bindings.elements.map((e) => e.getText(this.sf)), ...missing];
      this.replace(this.start(bindings), bindings.end, `{ ${all.join(", ")} }`);
      return;
    }
    newImports.push(`import ${typeOnly ? "type " : ""}{ ${names.join(", ")} } from ${quote}${moduleName}${quote}${end}`);
  }

  /** The import binding had references and every one of them is in removed code. */
  private becameUnused(name: ts.Identifier): boolean {
    const symbol = this.checker.getSymbolAtLocation(name);
    if (!symbol) return false;
    // Replacement text that names it again (sql<T>`${…}`) keeps it.
    const word = new RegExp(`(^|[^\\w$])${name.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`);
    if (this.edits.some((edit) => edit.end > edit.start && word.test(edit.text))) return false;
    let total = 0;
    let removed = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node) && node.text === name.text) {
        const parent = node.parent;
        const isPropertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) || (ts.isQualifiedName(parent) && parent.right === node);
        if (!isPropertyName && this.checker.getSymbolAtLocation(node) === symbol) {
          total++;
          const start = this.start(node);
          if (this.removedRanges.some(([s, e]) => s <= start && node.end <= e)) removed++;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
    return total > 0 && total === removed;
  }
}

// ── Syntax helpers ──

function collectDeclaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) names.add(node.name.text);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) names.add(node.name.text);
    if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      const name = (node as ts.ImportSpecifier).name;
      if (name) names.add(name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function needsParens(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return parent.expression === node;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression === node;
  if (ts.isTaggedTemplateExpression(parent)) return parent.tag === node;
  if (ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent)) return true;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken) return parent.left === node;
  return false;
}

function startsStatement(node: ts.Node, sf: ts.SourceFile): boolean {
  let current: ts.Node = node;
  while (current.parent && !ts.isExpressionStatement(current.parent)) {
    const parent: ts.Node = current.parent;
    if (parent.getStart(sf) !== current.getStart(sf)) return false;
    current = parent;
  }
  return !!current.parent && current.parent.getStart(sf) === node.getStart(sf);
}

function previousTokenEndsStatement(text: string, position: number): boolean {
  let index = position - 1;
  while (index >= 0 && /\s/.test(text[index])) index--;
  return index < 0 || /[;{}]/.test(text[index]);
}

function leftmostIdentifier(name: ts.EntityName): ts.Identifier {
  let current: ts.EntityName = name;
  while (ts.isQualifiedName(current)) current = current.left;
  return current;
}

function isPromiseTypeNode(type: ts.TypeNode): boolean {
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && /^(Promise|PromiseLike)$/.test(type.typeName.text);
}

/** Where `async` goes: before `function`, before a method's name, before an arrow's parameters. */
function asyncPosition(node: ts.FunctionLikeDeclaration, sf: ts.SourceFile): number {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    const keyword = node.getChildren(sf).find((child) => child.kind === ts.SyntaxKind.FunctionKeyword);
    return keyword ? keyword.getStart(sf) : node.getStart(sf);
  }
  if (ts.isMethodDeclaration(node)) return (node.asteriskToken ?? node.name).getStart(sf);
  if (ts.isArrowFunction(node)) {
    const modifiers = ts.getModifiers(node);
    return modifiers && modifiers.length > 0 ? modifiers[modifiers.length - 1].end + 1 : node.getStart(sf);
  }
  return node.getStart(sf);
}

/** Where a terminal (`.get()`) starts: at the dot, or right after the builder when only whitespace separates them. */
function terminalStart(text: string, receiver: ts.Expression, access: ts.PropertyAccessExpression, sf: ts.SourceFile) {
  const nameStart = access.name.getStart(sf);
  let dot = nameStart - 1;
  while (dot > receiver.end && text[dot] !== ".") dot--;
  if (access.questionDotToken) dot = access.questionDotToken.getStart(sf);
  const between = text.slice(receiver.end, dot);
  const plain = /^\s*$/.test(between) ? receiver.end : dot;
  return {
    plain,
    /** With `.limit(1)` the line break before the dot stays, so the chain keeps its layout. */
    withLimit: (limit: string) => (limit && /\n/.test(between) && /^\s*$/.test(between) ? dot : plain),
  };
}

/** `%${x}%` → x. */
function containedPattern(pattern: ts.Expression): ts.Expression | undefined {
  if (!ts.isTemplateExpression(pattern) || pattern.templateSpans.length !== 1) return undefined;
  if (pattern.head.text !== "%" || pattern.templateSpans[0].literal.text !== "%") return undefined;
  return pattern.templateSpans[0].expression;
}

function sameText(a: ts.Node, b: ts.Node, sf: ts.SourceFile): boolean {
  return a.getText(sf).replace(/\s+/g, "") === b.getText(sf).replace(/\s+/g, "");
}

/** `sql.join(values.map((v) => sql`${v}`), sql`, `)` → values. */
function joinedValues(expression: ts.Expression): ts.Expression | undefined {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
  if (expression.expression.name.text !== "join" || expression.arguments.length !== 2) return undefined;
  const [mapped, separator] = expression.arguments;
  if (!ts.isTaggedTemplateExpression(separator) || !ts.isNoSubstitutionTemplateLiteral(separator.template) || separator.template.text.trim() !== ",") return undefined;
  if (!ts.isCallExpression(mapped) || !ts.isPropertyAccessExpression(mapped.expression) || mapped.expression.name.text !== "map") return undefined;
  const callback = mapped.arguments[0];
  if (!callback || !ts.isArrowFunction(callback) || callback.parameters.length !== 1) return undefined;
  const body = callback.body;
  if (!ts.isTaggedTemplateExpression(body) || !ts.isTemplateExpression(body.template)) return undefined;
  const template = body.template;
  if (template.head.text !== "" || template.templateSpans.length !== 1 || template.templateSpans[0].literal.text !== "") return undefined;
  const parameter = callback.parameters[0].name;
  const spanExpression = template.templateSpans[0].expression;
  if (!ts.isIdentifier(parameter) || !ts.isIdentifier(spanExpression) || spanExpression.text !== parameter.text) return undefined;
  return mapped.expression.expression;
}
