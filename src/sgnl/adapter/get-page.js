import { mapToSgnlAttributes } from './utils.js';
import { listMapJsonFiles, loadMapJson, resolveMapsDir } from './map-sources.js';

/** Root Map entity `external_id` — must match `public/sgnl/sor.yaml`. */
export const MAP_ENTITY_EXTERNAL_ID = 'map';

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
  const sorType = process.env.SOR_TYPE;
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

    const childObjects = buildChildObjects(req.entity.child_entities || [], mapJson);

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
    const key = child.external_id;
    const arr = mapJson[key];
    if (!Array.isArray(arr)) {
      console.warn(
        `[sgnl adapter] child entity external_id "${key}" is missing or not an array on map "${mapJson.name}"`,
      );
      return { entity_id: child.id, objects: [] };
    }

    const attrMap = new Map(
      (child.attributes || []).map((a) => [a.external_id, a]),
    );

    const objects = arr.map((el, index) => ({
      attributes: mapToSgnlAttributes(
        el !== null && typeof el === 'object'
          ? { ...el, index }
          : { value: el, index },
        attrMap,
      ),
      child_objects: [],
    }));

    return { entity_id: child.id, objects };
  });
}
