import type { z } from "zod";

/**
 * The tolerant reader (ADR-0022): the same schema with every object, at every
 * depth, reading in strip mode instead of strict. Values a consumer knows are
 * still validated exactly as the strict schema validates them — refinements,
 * enums, literals, formats — and only keys the schema does not declare are
 * dropped, so a producer from the next deployed version can add a field
 * without breaking a consumer built from this one.
 *
 * Producers keep the strict schema: the server validates a response with it
 * before sending, and the outbox write validates a payload with it before it
 * leaves the process, so an undeclared field cannot reach the wire by accident.
 * Readers — the browser reading a response, the worker reading a payload — go
 * through here. `.strip()` alone is not enough because it only applies to the
 * top-level object; `GetScanResponse` nests four levels deep.
 *
 * The original schema is never mutated; results are memoized per schema.
 */
export function tolerant<S extends z.ZodType>(schema: S): S {
  const cached = cache.get(schema);
  if (cached) {
    return cached as S;
  }
  const result = rebuild(schema) as S;
  cache.set(schema, result);
  return result;
}

/** Reads a value the way a client must: known fields validated, unknown dropped. */
export function parseResponse<S extends z.ZodType>(
  schema: S,
  value: unknown,
): z.output<S> {
  return tolerant(schema).parse(value) as z.output<S>;
}

const cache = new WeakMap<z.ZodType, z.ZodType>();

type AnyDef = Record<string, unknown> & { type: string };

function rebuild(schema: z.ZodType): z.ZodType {
  const def = schema._zod.def as AnyDef;
  switch (def.type) {
    case "object": {
      const shape: Record<string, z.ZodType> = {};
      for (const [key, value] of Object.entries(
        def.shape as Record<string, z.ZodType>,
      )) {
        shape[key] = tolerant(value);
      }
      return clone(schema, def, { shape, catchall: undefined });
    }
    case "array":
      return clone(schema, def, {
        element: tolerant(def.element as z.ZodType),
      });
    case "optional":
    case "nullable":
    case "nonoptional":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "promise":
      return clone(schema, def, {
        innerType: tolerant(def.innerType as z.ZodType),
      });
    case "union":
      return clone(schema, def, {
        options: (def.options as z.ZodType[]).map(tolerant),
      });
    case "intersection":
      return clone(schema, def, {
        left: tolerant(def.left as z.ZodType),
        right: tolerant(def.right as z.ZodType),
      });
    case "record":
    case "set":
      return clone(schema, def, {
        valueType: tolerant(def.valueType as z.ZodType),
      });
    case "map":
      return clone(schema, def, {
        keyType: tolerant(def.keyType as z.ZodType),
        valueType: tolerant(def.valueType as z.ZodType),
      });
    case "tuple":
      return clone(schema, def, {
        items: (def.items as z.ZodType[]).map(tolerant),
        rest: def.rest ? tolerant(def.rest as z.ZodType) : def.rest,
      });
    case "pipe":
      return clone(schema, def, {
        in: tolerant(def.in as z.ZodType),
        out: tolerant(def.out as z.ZodType),
      });
    case "lazy": {
      const getter = def.getter as () => z.ZodType;
      // Zod caches the resolved inner schema on the def itself; a clone must
      // not inherit the strict one.
      return clone(schema, def, {
        getter: () => tolerant(getter()),
        _cachedInner: undefined,
      });
    }
    default:
      // A leaf — string, number, literal, enum, and so on — has no objects
      // beneath it and validates identically either way.
      return schema;
  }
}

function clone(
  schema: z.ZodType,
  def: AnyDef,
  overrides: Record<string, unknown>,
): z.ZodType {
  // `clone` constructs a fresh schema of the same class from the merged def,
  // so checks (refinements) carried on the def come along unchanged.
  return schema.clone({ ...def, ...overrides } as typeof schema._zod.def);
}
