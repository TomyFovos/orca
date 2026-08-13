'use strict';

class SchemaValidationError extends Error {
  constructor(pointer) {
    super('SCHEMA_VALIDATION_FAILED');
    this.name = 'SchemaValidationError';
    this.code = 'SCHEMA_VALIDATION_FAILED';
    this.pointer = pointer || '/';
  }
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pointerChild(pointer, key) {
  const escaped = String(key).replace(/~/gu, '~0').replace(/\//gu, '~1');
  return `${pointer}/${escaped}`;
}

function resolveReference(root, reference) {
  if (!reference.startsWith('#/')) throw new SchemaValidationError('/$ref');
  return reference.slice(2).split('/').reduce((value, part) => {
    const key = part.replace(/~1/gu, '/').replace(/~0/gu, '~');
    return value?.[key];
  }, root);
}

function matchesType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function assertAlternatives(value, alternatives, root, pointer, exactOne) {
  let matches = 0;
  for (const alternative of alternatives) {
    try {
      validateNode(value, alternative, root, pointer);
      matches += 1;
    } catch (error) {
      if (!(error instanceof SchemaValidationError)) throw error;
    }
  }
  if (matches === 0 || (exactOne && matches !== 1)) throw new SchemaValidationError(pointer);
}

function validateArray(value, schema, root, pointer) {
  if (schema.minItems !== undefined && value.length < schema.minItems) throw new SchemaValidationError(pointer);
  if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new SchemaValidationError(pointer);
  if (schema.uniqueItems === true) {
    const serialized = value.map((item) => JSON.stringify(item));
    if (new Set(serialized).size !== serialized.length) throw new SchemaValidationError(pointer);
  }
  const prefix = schema.prefixItems || [];
  for (let index = 0; index < prefix.length && index < value.length; index += 1) {
    validateNode(value[index], prefix[index], root, pointerChild(pointer, index));
  }
  if (schema.items && typeof schema.items === 'object') {
    for (let index = prefix.length; index < value.length; index += 1) {
      validateNode(value[index], schema.items, root, pointerChild(pointer, index));
    }
  }
}

function validateObject(value, schema, root, pointer) {
  for (const key of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new SchemaValidationError(pointerChild(pointer, key));
  }
  const properties = schema.properties || {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        throw new SchemaValidationError(pointerChild(pointer, key));
      }
    }
  }
  for (const [key, childSchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      validateNode(value[key], childSchema, root, pointerChild(pointer, key));
    }
  }
}

function validateScalar(value, schema, pointer) {
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) throw new SchemaValidationError(pointer);
    if (schema.maxLength !== undefined && length > schema.maxLength) throw new SchemaValidationError(pointer);
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern, 'u')).test(value)) {
      throw new SchemaValidationError(pointer);
    }
    if (schema.format === 'date-time' &&
        (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) || !Number.isFinite(Date.parse(value)))) {
      throw new SchemaValidationError(pointer);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) throw new SchemaValidationError(pointer);
    if (schema.maximum !== undefined && value > schema.maximum) throw new SchemaValidationError(pointer);
  }
}

function validateNode(value, schema, root, pointer) {
  if (!schema || typeof schema !== 'object') throw new SchemaValidationError(pointer);
  if (schema.$ref) return validateNode(value, resolveReference(root, schema.$ref), root, pointer);
  if (schema.oneOf) assertAlternatives(value, schema.oneOf, root, pointer, true);
  if (schema.anyOf) assertAlternatives(value, schema.anyOf, root, pointer, false);
  for (const child of schema.allOf || []) validateNode(value, child, root, pointer);
  if (schema.const !== undefined && !sameValue(value, schema.const)) throw new SchemaValidationError(pointer);
  if (schema.enum && !schema.enum.some((entry) => sameValue(value, entry))) throw new SchemaValidationError(pointer);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) throw new SchemaValidationError(pointer);
  }
  if (Array.isArray(value)) validateArray(value, schema, root, pointer);
  else if (value !== null && typeof value === 'object') validateObject(value, schema, root, pointer);
  else validateScalar(value, schema, pointer);
  return true;
}

function validateJsonSchema(value, schema) {
  return validateNode(value, schema, schema, '');
}

module.exports = { SchemaValidationError, validateJsonSchema };
