import { JSONPath } from "jsonpath-plus";

export function mapToSgnlAttributes(entity, attrMap) {
  const attributes = [];

  for (const [extId, config] of attrMap.entries()) {
    let results;

    try {
      // Evaluate JSONPath, e.g., "$.account.status"
      results = JSONPath({
        path: extId.startsWith("$") ? extId : `$.${extId}`,
        json: entity,
        wrap: true,
      });
    } catch (err) {
      console.warn(`Failed to evaluate JSONPath "${extId}": ${err.message}`);
      continue;
    }

    let values = results
      .map((v) => toAttributeValue(v, config.type, extId))
      .filter(Boolean);

    if (config.list === false && values.length > 1) {
      values = [values[0]];
    }

    if (values.length > 0) {
      attributes.push({
        id: config.id,
        values,
      });
    }
  }

  return attributes;
}

function toAttributeValue(value, expectedType, key) {
  if (value === null || value === undefined) return null;

  try {
    switch (expectedType) {
      case "ATTRIBUTE_TYPE_STRING": {
        if (typeof value === "object" && value !== null) {
          return { string_value: JSON.stringify(value) };
        }
        return { string_value: String(value) };
      }

      case "ATTRIBUTE_TYPE_BOOL": {
        if (typeof value === "boolean") return { bool_value: value };
        if (value === "true" || value === "false")
          return { bool_value: value === "true" };
        throw new Error(`Cannot coerce to boolean: ${value}`);
      }

      case "ATTRIBUTE_TYPE_INT64": {
        if (!Number.isInteger(Number(value))) {
          throw new Error(`Not an integer: ${value}`);
        }
        return { int64_value: parseInt(value, 10) };
      }

      case "ATTRIBUTE_TYPE_DOUBLE": {
        const num = parseFloat(value);
        if (isNaN(num)) throw new Error(`Not a number: ${value}`);
        return { double_value: num };
      }

      case "ATTRIBUTE_TYPE_DATE_TIME": {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          throw new Error(`Invalid date: ${value}`);
        }
        const seconds = Math.floor(date.getTime() / 1000);
        const nanos = (date.getTime() % 1000) * 1e6;
        return { datetime_value: { timestamp: { seconds, nanos } } };
      }

      default:
        console.warn(
          `Unknown SGNL attribute type "${expectedType}" for key "${key}" — defaulting to string`,
        );
        return { string_value: String(value) };
    }
  } catch (err) {
    console.warn(
      `Attribute "${key}" could not be converted to ${expectedType}:`,
      err.message,
    );
    return null;
  }
}
