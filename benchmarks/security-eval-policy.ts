import * as ts from "typescript";

// A deliberately small subset of the actual Native tool schemas. In particular,
// edit's published schema is { path, edits: [{ oldText, newText }] }.
const keys: Readonly<Record<string, readonly string[]>> = {
  bash: ["command", "timeout"], read: ["path", "offset", "limit"], grep: ["pattern", "path", "glob", "limit"],
  find: ["pattern", "path", "limit"], ls: ["path", "limit"], write: ["path", "content"], edit: ["path", "edits"],
};
export type ToolOnlyEval = { readonly name: string; readonly args: Readonly<Record<string, unknown>> };
const invalid = Symbol("non-literal eval argument");

function staticData(node: ts.Expression, depth = 0): unknown | typeof invalid {
  if (depth > 8) return invalid;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) {
    const number = Number(node.text);
    return Number.isFinite(number) && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(node.text) ? number : invalid;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map(element => staticData(element, depth + 1));
    return values.includes(invalid) ? invalid : values;
  }
  if (!ts.isObjectLiteralExpression(node)) return invalid;
  const result: Record<string, unknown> = Object.create(null);
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return invalid;
    const name = property.name.text;
    if (["__proto__", "prototype", "constructor"].includes(name) || Object.hasOwn(result, name)) return invalid;
    const value = staticData(property.initializer, depth + 1);
    if (value === invalid) return invalid;
    result[name] = value;
  }
  return result;
}

/** Exactly one awaited Native tool call, displayed via print/display. No eval of JS source. */
export function decodeToolOnlyEval(payload: unknown): ToolOnlyEval | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const frame = payload as Record<string, unknown>;
  if (Object.keys(frame).some(key => !["action", "language", "code", "summary"].includes(key)) ||
      (frame.action !== undefined && frame.action !== "run") ||
      frame.language !== "js" || typeof frame.code !== "string" || frame.code.length > 32768 ||
      (frame.summary !== undefined && typeof frame.summary !== "string")) return null;
  const code = frame.code;
  const file = ts.createSourceFile("cell.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.statements.length !== 1) return null;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return null;
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
      statement.expression.questionDotToken || statement.expression.typeArguments ||
      !ts.isIdentifier(statement.expression.expression) ||
      !["print", "display"].includes(statement.expression.expression.text) ||
      statement.expression.arguments.length !== 1) return null;
  const awaited = statement.expression.arguments[0];
  if (!awaited || !ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression)) return null;
  const call = awaited.expression;
  if (call.questionDotToken || call.typeArguments || !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.questionDotToken || !ts.isIdentifier(call.expression.expression) ||
      call.expression.expression.text !== "tool" || call.arguments.length !== 1) return null;
  const name = call.expression.name.text;
  const permitted = keys[name];
  const literal = call.arguments[0];
  if (!permitted || !literal || !ts.isObjectLiteralExpression(literal)) return null;
  const args = staticData(literal);
  if (args === invalid || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const data = args as Record<string, unknown>;
  if (Object.keys(data).some(key => !permitted.includes(key)) ||
      (name === "bash" ? typeof data["command"] !== "string" :
        ["grep", "find", "ls"].includes(name) ? data["path"] !== undefined && typeof data["path"] !== "string" :
        typeof data["path"] !== "string") ||
      (name === "grep" && typeof data["pattern"] !== "string") ||
      (name === "find" && typeof data["pattern"] !== "string") ||
      (name === "write" && typeof data["content"] !== "string") ||
      (name === "edit" && (!Array.isArray(data["edits"]) || !data["edits"].length || data["edits"].some(edit =>
        !edit || typeof edit !== "object" || Array.isArray(edit) ||
        Object.keys(edit).sort().join(",") !== "newText,oldText" ||
        typeof edit.oldText !== "string" || typeof edit.newText !== "string"))) ||
      (name === "bash" && data["timeout"] !== undefined &&
        (!Number.isFinite(data["timeout"]) || Number(data["timeout"]) < 1 || Number(data["timeout"]) > 30)) ||
      ["offset", "limit"].some(key => data[key] !== undefined && (!Number.isSafeInteger(data[key]) || Number(data[key]) < 0)) ||
      (name === "grep" && data["glob"] !== undefined && typeof data["glob"] !== "string")) return null;
  // No prefix/suffix expressions: whitespace and one optional trailing semicolon only.
  if (code.slice(0, statement.getStart(file)).trim() ||
      code.slice(statement.end).trim() ||
      !/^\s*(?:print|display)\s*\(\s*await\s+tool\.[A-Za-z_]+\s*\(/.test(code)) return null;
  return { name, args: data };
}

/** Only a displayed lookup of one published Native tool schema; never a general JS cell. */
const schemaNames = new Set([
  "read", "grep", "find", "ls", "write", "edit", "bash", "tool_search",
  "lsp_diagnostics", "lsp_goto_definition", "lsp_find_references", "lsp_symbols",
]);
export function decodeMetadataEval(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const frame = payload as Record<string, unknown>;
  if (Object.keys(frame).some(key => !["action", "language", "code", "summary"].includes(key)) ||
      (frame.action !== undefined && frame.action !== "run") ||
      frame.language !== "js" || typeof frame.code !== "string" || frame.code.length > 512 ||
      typeof frame.summary !== "string" || !frame.summary.trim() || frame.summary.length > 256) return null;
  const code = frame.code;
  const file = ts.createSourceFile("schema-cell.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.statements.length !== 1) return null;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return null;
  const statement = file.statements[0];
  if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) ||
      statement.expression.questionDotToken || statement.expression.typeArguments ||
      !ts.isIdentifier(statement.expression.expression) ||
      !["print", "display"].includes(statement.expression.expression.text) ||
      statement.expression.arguments.length !== 1) return null;
  const awaited = statement.expression.arguments[0];
  if (!awaited || !ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression)) return null;
  const call = awaited.expression;
  if (call.questionDotToken || call.typeArguments || !ts.isIdentifier(call.expression) ||
      call.expression.text !== "tool_schema" || call.arguments.length !== 1 ||
      !ts.isStringLiteral(call.arguments[0]!)) return null;
  const name = call.arguments[0].text;
  if (!schemaNames.has(name) || code.slice(0, statement.getStart(file)).trim() ||
      code.slice(statement.end).trim()) return null;
  return name;
}
