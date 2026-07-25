import * as ts from 'typescript';

export type ProviderNeutralityViolation = {
  region: string;
  kind: 'provider-literal' | 'provider-branch' | 'missing-region';
  line: number;
  text: string;
};

const PROVIDER_LITERALS = new Set(['github', 'bitbucket']);
const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function functionName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    const initializer = node.initializer;
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return node.name.text;
  }
  return null;
}

function isProviderLiteral(node: ts.Node): node is ts.StringLiteral {
  return ts.isStringLiteral(node) && PROVIDER_LITERALS.has(node.text);
}

function isProviderProperty(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.name)
    && (node.name.text === 'name' || node.name.text === 'vcsProvider' || node.name.text === 'provider');
}

export function scanProviderNeutralRegions(
  source: string,
  regions: readonly string[],
): ProviderNeutralityViolation[] {
  const sourceFile = ts.createSourceFile('phase19-region.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: ProviderNeutralityViolation[] = [];
  const regionSet = new Set(regions);
  const found = new Set<string>();

  function visitRegion(node: ts.Node, name: string) {
    if (!regionSet.has(name)) return;
    found.add(name);
    function visit(nodeInRegion: ts.Node) {
      if (isProviderLiteral(nodeInRegion)) {
        const position = sourceFile.getLineAndCharacterOfPosition(nodeInRegion.getStart(sourceFile));
        violations.push({
          region: name,
          kind: 'provider-literal',
          line: position.line + 1,
          text: nodeInRegion.getText(sourceFile),
        });
      }
      if (ts.isBinaryExpression(nodeInRegion) && EQUALITY_OPERATORS.has(nodeInRegion.operatorToken.kind)) {
        const leftProvider = isProviderProperty(nodeInRegion.left);
        const rightProvider = isProviderProperty(nodeInRegion.right);
        const leftLiteral = isProviderLiteral(nodeInRegion.left);
        const rightLiteral = isProviderLiteral(nodeInRegion.right);
        if ((leftProvider && rightLiteral) || (rightProvider && leftLiteral)) {
          const position = sourceFile.getLineAndCharacterOfPosition(nodeInRegion.getStart(sourceFile));
          violations.push({
            region: name,
            kind: 'provider-branch',
            line: position.line + 1,
            text: nodeInRegion.getText(sourceFile),
          });
        }
      }
      ts.forEachChild(nodeInRegion, visit);
    }
    ts.forEachChild(node, visit);
  }

  function visit(node: ts.Node) {
    const name = functionName(node);
    if (name) visitRegion(node, name);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  for (const region of regions) {
    if (!found.has(region)) {
      violations.push({ region, kind: 'missing-region', line: 1, text: region });
    }
  }
  return violations;
}

export function normalizeProviderLifecycle<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => normalizeProviderLifecycle(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const normalized = {} as Record<string, unknown>;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'provider' || key === 'model' || key === 'timestamp' || key === 'ref') continue;
    normalized[key] = normalizeProviderLifecycle(child);
  }
  return normalized as T;
}
