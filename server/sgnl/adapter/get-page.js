import { mapToSgnlAttributes } from './utils.js';
import { listMapJsonFiles, loadMapJson, resolveMapsDir } from './map-sources.js';
import { INTERACTABLE_BUILDERS } from './interactables.js';

/** Root Map entity `external_id` — must match `public/sgnl/map-sor.yaml`. */
export const MAP_ENTITY_EXTERNAL_ID = 'map';

/**
 * Child entity `external_id`s the adapter understands. Anything else
 * is rejected with `ERROR_CODE_INVALID_ENTITY_CONFIG` so SGNL surfaces
 * the misconfiguration loudly instead of silently returning empty
 * rows.
 */
const SUPPORTED_CHILD_ENTITIES = new Set(Object.keys(INTERACTABLE_BUILDERS));

function parseCursor(cursor) {
  const n = parseInt(String(cursor || ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function pageSizeOrDefault(pageSize) {
  const n = Number(pageSize);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.min(Math.floor(n), 500);
}

/**
 * @param {object} req GetPageRequest (plain object from gRPC)
 * @returns {Promise<{ success?: object, error?: object }>}
 */
export async function handleGetPage(req) {
  const sorType = process.env.SGNL_ADAPTER_SOR_TYPE;
  if (sorType && req.datasource?.type && req.datasource.type !== sorType) {
    return {
      error: {
        message: `Unsupported datasource type "${req.datasource.type}"`,
        code: 2,
      },
    };
  }

  const entityExt = req.entity?.external_id;
  if (entityExt !== MAP_ENTITY_EXTERNAL_ID) {
    return {
      error: {
        message: `Entity external_id "${entityExt}" is not supported; only "${MAP_ENTITY_EXTERNAL_ID}" is implemented`,
        code: 4,
      },
    };
  }

  const childEntities = req.entity.child_entities || [];
  for (const child of childEntities) {
    if (!SUPPORTED_CHILD_ENTITIES.has(child.external_id)) {
      return {
        error: {
          message: `Child entity "${child.external_id}" is not supported; expected one of: ${[...SUPPORTED_CHILD_ENTITIES].join(', ')}`,
          code: 4,
        },
      };
    }
  }

  const mapsDir = resolveMapsDir();
  let files;
  try {
    files = await listMapJsonFiles(mapsDir);
  } catch (e) {
    return {
      error: {
        message: `Cannot read maps directory: ${e.message}`,
        code: 10,
      },
    };
  }

  const start = parseCursor(req.cursor);
  const pageSize = pageSizeOrDefault(req.page_size);
  const slice = files.slice(start, start + pageSize);

  const mapAttrMap = new Map(
    (req.entity.attributes || []).map((a) => [a.external_id, a]),
  );

  const objects = [];
  for (const basename of slice) {
    let mapJson;
    try {
      mapJson = await loadMapJson(mapsDir, basename);
    } catch (e) {
      return {
        error: {
          message: `Failed to load ${basename}: ${e.message}`,
          code: 10,
        },
      };
    }

    const childObjects = buildChildObjects(childEntities, mapJson);

    objects.push({
      attributes: mapToSgnlAttributes(mapJson, mapAttrMap),
      child_objects: childObjects,
    });
  }

  const nextStart = start + slice.length;
  const next_cursor = nextStart < files.length ? String(nextStart) : '';

  return {
    success: {
      objects,
      next_cursor,
    },
  };
}

/**
 * @param {object[]} childEntities from EntityConfig
 * @param {object} mapJson
 * @returns {object[]} EntityObjects[] in proto shape (snake_case keys)
 */
function buildChildObjects(childEntities, mapJson) {
  return childEntities.map((child) => {
    const builder = INTERACTABLE_BUILDERS[child.external_id];
    const rows = builder ? builder(mapJson) : [];

    const attrMap = new Map(
      (child.attributes || []).map((a) => [a.external_id, a]),
    );

    const objects = rows.map((row) => ({
      attributes: mapToSgnlAttributes(row, attrMap),
      child_objects: [],
    }));

    return { entity_id: child.id, objects };
  });
}
