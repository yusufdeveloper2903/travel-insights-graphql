import { readFileSync } from 'node:fs';
import { useDisableIntrospection } from '@graphql-yoga/plugin-disable-introspection';
import { usePersistedOperations } from '@graphql-yoga/plugin-persisted-operations';
import { getOperationAST, type ExecutionArgs, type ExecutionResult } from 'graphql';
import { isAsyncIterable, type Plugin } from 'graphql-yoga';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../shared/logger.js';
import { costLimitRule, depthLimitRule } from './validation.js';

/** Adds depth + cost limits to the standard GraphQL validation rules. */
export function useQueryLimits(opts: { maxDepth: number; maxCost: number }): Plugin {
  return {
    onValidate({ addValidationRule }) {
      addValidationRule(depthLimitRule(opts.maxDepth));
      addValidationRule(costLimitRule(opts.maxCost));
    },
  };
}

/** One structured log line per executed operation: name, type, duration, error count. */
export function useOperationLogging(logger: Logger): Plugin<{ requestId?: string }> {
  return {
    onExecute({ args }) {
      const started = performance.now();
      const {
        document,
        operationName: requested,
        contextValue,
      } = args as ExecutionArgs & {
        contextValue: { requestId?: string };
      };
      const op = getOperationAST(document, requested);
      const operationName = op?.name?.value ?? requested ?? 'anonymous';
      const operationType = op?.operation ?? 'unknown';
      return {
        onExecuteDone({ result }) {
          if (isAsyncIterable(result)) return;
          const durationMs = Math.round((performance.now() - started) * 10) / 10;
          const errors = (result as ExecutionResult).errors ?? [];
          const level = errors.length > 0 ? 'warn' : 'info';
          logger[level](
            {
              requestId: contextValue.requestId,
              operationName,
              operationType,
              durationMs,
              errorCount: errors.length,
              ...(errors.length > 0
                ? {
                    errorCodes: errors.map(
                      (e) => (e.extensions as { code?: string } | undefined)?.code ?? 'UNKNOWN',
                    ),
                  }
                : {}),
            },
            'graphql operation',
          );
        },
      };
    },
  };
}

const persistedStoreSchema = z.record(z.string(), z.string().min(1));

/**
 * Persisted operations: an allow-list of `{ "<sha256 or id>": "<query>" }`, e.g. generated at
 * client build time. With PERSISTED_OPERATIONS_ONLY=true arbitrary documents are rejected,
 * which removes the whole class of expensive ad-hoc queries in production.
 */
export function loadPersistedOperations(file: string): Map<string, string> {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return new Map(Object.entries(persistedStoreSchema.parse(raw)));
}

export function buildPlugins(
  config: Config,
  logger: Logger,
  store?: Map<string, string>,
): Plugin[] {
  const plugins: Plugin[] = [
    useQueryLimits({ maxDepth: config.graphql.maxDepth, maxCost: config.graphql.maxCost }),
    useOperationLogging(logger),
  ];
  if (!config.graphql.introspection) plugins.push(useDisableIntrospection());

  const ops =
    store ??
    (config.graphql.persistedOperationsFile
      ? loadPersistedOperations(config.graphql.persistedOperationsFile)
      : undefined);
  if (ops) {
    plugins.push(
      usePersistedOperations({
        getPersistedOperation: (key) => ops.get(key) ?? null,
        allowArbitraryOperations: !config.graphql.persistedOperationsOnly,
      }),
    );
    logger.info(
      { count: ops.size, only: config.graphql.persistedOperationsOnly },
      'persisted operations enabled',
    );
  }
  return plugins;
}
