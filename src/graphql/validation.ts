import {
  getNamedType,
  GraphQLError,
  isCompositeType,
  isInterfaceType,
  isObjectType,
  Kind,
  type ArgumentNode,
  type ConstDirectiveNode,
  type FieldNode,
  type GraphQLCompositeType,
  type GraphQLField,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
  type ValueNode,
} from 'graphql';
import { ErrorCode } from '../shared/errors.js';

const isIntrospectionField = (name: string) => name.startsWith('__');

/**
 * Rejects operations nested deeper than `maxDepth` (fragments are expanded). `{ a { b } }` has
 * depth 2. Introspection fields are ignored so GraphiQL keeps working in development.
 */
export function depthLimitRule(maxDepth: number): ValidationRule {
  return (context: ValidationContext) => ({
    OperationDefinition(node) {
      const depth = measureDepth(node.selectionSet, context, 0, new Set());
      if (depth > maxDepth) {
        context.reportError(
          new GraphQLError(
            `Query depth ${depth} exceeds the maximum allowed depth of ${maxDepth}`,
            {
              nodes: [node],
              extensions: { code: ErrorCode.QUERY_TOO_COMPLEX, depth, maxDepth },
            },
          ),
        );
      }
    },
  });
}

function measureDepth(
  set: SelectionSetNode,
  ctx: ValidationContext,
  depth: number,
  seenFragments: ReadonlySet<string>,
): number {
  let max = depth;
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      if (isIntrospectionField(sel.name.value)) continue;
      const d = sel.selectionSet
        ? measureDepth(sel.selectionSet, ctx, depth + 1, seenFragments)
        : depth + 1;
      max = Math.max(max, d);
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      max = Math.max(max, measureDepth(sel.selectionSet, ctx, depth, seenFragments));
    } else {
      const name = sel.name.value;
      const frag = ctx.getFragment(name);
      if (!frag || seenFragments.has(name)) continue; // cycles are reported by NoFragmentCycles
      max = Math.max(
        max,
        measureDepth(frag.selectionSet, ctx, depth, new Set([...seenFragments, name])),
      );
    }
  }
  return max;
}

/**
 * Static cost analysis driven by schema directives (@cost / @listSize, modelled on the IBM
 * GraphQL Cost Directives spec):
 *
 *   cost(field) = weight + multiplier * cost(children)
 *
 * Validation runs before variables are known (and Yoga caches validation per document), so a
 * slicing argument passed as a variable is costed pessimistically at its assumedSize.
 */
export function costLimitRule(maxCost: number): ValidationRule {
  return (context: ValidationContext) => ({
    OperationDefinition(node) {
      const root =
        node.operation === 'query'
          ? context.getSchema().getQueryType()
          : node.operation === 'mutation'
            ? context.getSchema().getMutationType()
            : context.getSchema().getSubscriptionType();
      if (!root) return;
      const cost = measureCost(node.selectionSet, root, context, new Set());
      if (cost > maxCost) {
        context.reportError(
          new GraphQLError(`Query cost ${cost} exceeds the maximum allowed cost of ${maxCost}`, {
            nodes: [node],
            extensions: { code: ErrorCode.QUERY_TOO_COMPLEX, cost, maxCost },
          }),
        );
      }
    },
  });
}

export function measureCost(
  set: SelectionSetNode,
  parent: GraphQLCompositeType,
  ctx: ValidationContext,
  seenFragments: ReadonlySet<string>,
): number {
  let total = 0;
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      total += fieldCost(sel, parent, ctx, seenFragments);
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      const typeName = sel.typeCondition?.name.value;
      const t = typeName ? ctx.getSchema().getType(typeName) : parent;
      if (t && isCompositeType(t)) total += measureCost(sel.selectionSet, t, ctx, seenFragments);
    } else {
      const name = sel.name.value;
      const frag = ctx.getFragment(name);
      if (!frag || seenFragments.has(name)) continue;
      const t = ctx.getSchema().getType(frag.typeCondition.name.value);
      if (t && isCompositeType(t)) {
        total += measureCost(frag.selectionSet, t, ctx, new Set([...seenFragments, name]));
      }
    }
  }
  return total;
}

function fieldCost(
  node: FieldNode,
  parent: GraphQLCompositeType,
  ctx: ValidationContext,
  seenFragments: ReadonlySet<string>,
): number {
  if (isIntrospectionField(node.name.value)) return 0;
  if (!isObjectType(parent) && !isInterfaceType(parent)) return 0;
  const def = parent.getFields()[node.name.value];
  if (!def) return 0; // unknown fields are reported by FieldsOnCorrectType

  const named = getNamedType(def.type);
  const composite = isCompositeType(named);
  const weight = intDirectiveArg(def, 'cost', 'weight') ?? (composite ? 1 : 0);
  const children =
    node.selectionSet && composite ? measureCost(node.selectionSet, named, ctx, seenFragments) : 0;
  return weight + listMultiplier(def, node) * children;
}

function listMultiplier(def: GraphQLField<unknown, unknown>, node: FieldNode): number {
  const directive = findDirective(def, 'listSize');
  const assumed = intDirectiveArg(def, 'listSize', 'assumedSize');
  const slicingArg = directive?.arguments?.find((a) => a.name.value === 'slicingArgument');
  if (slicingArg?.value.kind === Kind.STRING) {
    const argName = slicingArg.value.value;
    const provided = node.arguments?.find((a) => a.name.value === argName);
    const size = provided ? sizeOf(provided) : defaultSize(def, argName);
    if (size !== null) return Math.max(size, 0);
    return assumed ?? 1;
  }
  if (assumed !== null) return assumed;
  return 1;
}

function sizeOfValue(v: ValueNode): number | null {
  if (v.kind === Kind.INT) return Number.parseInt(v.value, 10);
  if (v.kind === Kind.LIST) return v.values.length;
  return null; // variable: unknown at validation time
}

const sizeOf = (arg: ArgumentNode) => sizeOfValue(arg.value);

function defaultSize(def: GraphQLField<unknown, unknown>, argName: string): number | null {
  const d = def.args.find((a) => a.name === argName)?.default;
  if (!d) return null;
  if (d.literal) return sizeOfValue(d.literal);
  if (typeof d.value === 'number') return d.value;
  return Array.isArray(d.value) ? d.value.length : null;
}

function findDirective(
  def: GraphQLField<unknown, unknown>,
  name: string,
): ConstDirectiveNode | undefined {
  return def.astNode?.directives?.find((d) => d.name.value === name);
}

function intDirectiveArg(
  def: GraphQLField<unknown, unknown>,
  directive: string,
  arg: string,
): number | null {
  const a = findDirective(def, directive)?.arguments?.find((x) => x.name.value === arg);
  return a?.value.kind === Kind.INT ? Number.parseInt(a.value.value, 10) : null;
}
