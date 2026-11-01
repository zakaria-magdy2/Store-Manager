import { InvalidCatalogError } from '../common/errors.js';

export type AttributeValue = string | number | boolean;

/**
 * Industry-agnostic product attributes (size, colour, expiry, batch, serial...).
 * Stored as a JSON object on the variant so new verticals never require a schema
 * migration. Keys are normalized and values are limited to JSON-safe primitives.
 */
export type ProductAttributes = Readonly<Record<string, AttributeValue>>;

const ATTRIBUTE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function normalizeAttributes(
  input: Record<string, AttributeValue> | undefined,
): ProductAttributes {
  if (input === undefined) {
    return Object.freeze({});
  }

  const normalized: Record<string, AttributeValue> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!ATTRIBUTE_KEY_PATTERN.test(key)) {
      throw new InvalidCatalogError(
        `Invalid attribute key '${rawKey}'. Keys must start with a letter and contain only letters, numbers, '_' or '-'.`,
      );
    }

    if (typeof rawValue === 'number' && !Number.isFinite(rawValue)) {
      throw new InvalidCatalogError(`Attribute '${key}' must be a finite number`);
    }

    normalized[key] =
      typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  }

  return Object.freeze(normalized);
}

export function serializeAttributes(attributes: ProductAttributes): string {
  return JSON.stringify(attributes);
}

export function parseAttributes(json: string): ProductAttributes {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new InvalidCatalogError('Stored product attributes are not valid JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidCatalogError('Stored product attributes must be a JSON object');
  }

  const values: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new InvalidCatalogError(`Stored attribute '${key}' has an unsupported value type`);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new InvalidCatalogError(`Stored attribute '${key}' must be a finite number`);
    }
    values[key] = value;
  }

  return normalizeAttributes(values);
}
