// Client for OCL's $resolveReference operation.
//
// Resolves a canonical URL (or a relative OCL path) to the OCL repo that holds it,
// instead of hand-building /orgs/{owner}/sources/{id}/ paths. See
// https://docs.openconceptlab.org/en/latest/oclapi/apireference/resolveReference.html
//
// This is plain .js rather than the .cjs + stub convention used elsewhere in tx/ocl:
// jest's collectCoverageFrom globs **/*.js and not **/*.cjs, so a .cjs module here
// would be invisible to coverage.

const RESOLVE_PATH = '/$resolveReference/';
const GLOBAL_NAMESPACE = '/';
const OWNER_TYPES = new Set(['orgs', 'users']);

// OCL repos are owned by an org OR a user. Matching only /orgs/ silently drops
// every user-owned repo.
const REPO_PATH_PATTERN = /^\/(orgs|users)\/[^/]+\//;

// namespace is deliberately absent: OCL discourages the per-reference namespace field,
// preferring the request-level query parameter, so we group by namespace instead.
const BODY_FIELDS = [
  'url',
  'version',
  'code',
  'display',
  'id',
  'filter',
  'cascade',
  'includeExclude',
  'resourceType'
];

/**
 * True for a relative OCL repo path under either owner type, e.g.
 * `/orgs/CIEL/sources/CIEL/` or `/users/joe/sources/S/`.
 */
function isOclRepoPath(value) {
  return REPO_PATH_PATTERN.test(String(value == null ? '' : value).trim());
}

/**
 * Normalize a namespace to OCL's `/:ownerType/:owner/` form, or `/` for global.
 * A malformed namespace throws rather than degrading to global, which would look
 * fine while silently resolving against the wrong context.
 */
function normalizeNamespace(value) {
  const text = String(value == null ? '' : value).trim();
  if (text === '' || text === GLOBAL_NAMESPACE) {
    return GLOBAL_NAMESPACE;
  }

  // A bare token with no slashes is an org id: `CIEL` -> `/orgs/CIEL/`
  if (!text.includes('/')) {
    return `/orgs/${text}/`;
  }

  const normalized = `/${text.replace(/^\/+/, '').replace(/\/+$/, '')}/`;
  const segments = normalized.slice(1, -1).split('/');
  if (segments.length !== 2 || !OWNER_TYPES.has(segments[0]) || !segments[1]) {
    throw new Error(
      `Invalid OCL namespace '${value}': expected '/' or '/orgs/{id}/' or '/users/{id}/'`
    );
  }

  return normalized;
}

/**
 * Effective namespace for a source. Explicit namespace wins; otherwise derive from
 * `org`, which is the only namespace-bearing config that reaches tx/ocl today. With a
 * global namespace an org's own URL Registry is never consulted, which is not what a
 * source pinned to org=X wants.
 */
function deriveNamespace({ namespace = null, org = null } = {}) {
  if (namespace != null && String(namespace).trim() !== '') {
    return normalizeNamespace(namespace);
  }
  if (org != null && String(org).trim() !== '') {
    return normalizeNamespace(org);
  }
  return GLOBAL_NAMESPACE;
}

/**
 * Accepts either a relative/canonical URL string or an expanded reference object.
 * Returns the request body form plus the namespace hint used for grouping.
 */
function normalizeReference(ref) {
  if (typeof ref === 'string') {
    const url = ref.trim();
    if (!url) {
      throw new Error('OCL reference string cannot be empty');
    }
    return { url, namespace: null, body: url };
  }

  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new Error(`Invalid OCL reference: expected a string or object, got ${typeof ref}`);
  }

  const url = String(ref.url == null ? '' : ref.url).trim();
  if (!url) {
    throw new Error('OCL reference object requires a url');
  }

  const body = {};
  for (const field of BODY_FIELDS) {
    if (ref[field] !== undefined && ref[field] !== null) {
      body[field] = ref[field];
    }
  }

  return { url, namespace: ref.namespace == null ? null : ref.namespace, body };
}

function cacheKey(namespace, body) {
  return `${namespace}|${typeof body === 'string' ? body : JSON.stringify(body)}`;
}

function unresolved(namespace, request) {
  return {
    resolved: false,
    repoUrl: null,
    resolutionUrl: null,
    registryEntry: null,
    referenceType: null,
    namespace,
    request,
    result: null
  };
}

function normalizeResult(entry, namespace, request) {
  if (!entry || typeof entry !== 'object') {
    return unresolved(namespace, request);
  }

  const result = entry.result && typeof entry.result === 'object' ? entry.result : null;
  const repoUrl = result && result.url ? result.url : null;

  return {
    resolved: Boolean(entry.resolved) && Boolean(repoUrl),
    repoUrl,
    resolutionUrl: entry.resolution_url || null,
    // Phase 2's namespace sandbox needs this to tell owner-registry delegation
    // apart from a global-registry fallthrough, so never drop it.
    registryEntry: entry.url_registry_entry || null,
    referenceType: entry.reference_type || null,
    namespace,
    request: entry.request === undefined ? request : entry.request,
    result
  };
}

class OclReferenceResolver {
  #httpClient;
  #namespace;
  #logger;
  #cache = new Map();
  #enabled;
  #disabledReason = null;

  /**
   * @param {object} options
   * @param {object} options.httpClient - axios instance from createOclHttpClient
   * @param {string} [options.namespace] - explicit namespace; wins over org
   * @param {string} [options.org] - org id, used to derive the namespace
   * @param {string} [options.token] - when absent the resolver stays disabled
   * @param {object} [options.logger]
   */
  constructor({ httpClient, namespace = null, org = null, token = null, logger = console } = {}) {
    if (!httpClient) {
      throw new Error('OCL reference resolver requires an http client');
    }

    this.#httpClient = httpClient;
    this.#namespace = deriveNamespace({ namespace, org });
    this.#logger = logger;

    // $resolveReference is auth-gated on every OCL instance we've probed, while the
    // /orgs/ enumeration it replaces is public. Without a token every call is a
    // guaranteed 401, so stay disabled and let the caller use its existing path.
    this.#enabled = Boolean(token);
    if (!this.#enabled) {
      this.#disabledReason = 'no token configured';
    }
  }

  get namespace() {
    return this.#namespace;
  }

  isEnabled() {
    return this.#enabled;
  }

  get disabledReason() {
    return this.#disabledReason;
  }

  #disable(reason) {
    this.#enabled = false;
    this.#disabledReason = reason;
  }

  /**
   * Resolve one reference. Returns null when the resolver is unavailable, so the
   * caller falls back to its existing path.
   */
  async resolve(ref, options = {}) {
    const results = await this.resolveReferences([ref], options);
    return results ? results[0] : null;
  }

  /**
   * Resolve many references in as few round trips as possible.
   *
   * References are grouped by namespace and each group is sent as one POST with a
   * `namespace` query parameter. Results are returned in the caller's original order.
   *
   * @returns {Promise<Array|null>} null when the resolver is unavailable (use fallback)
   */
  async resolveReferences(refs, { namespace = null } = {}) {
    if (!this.#enabled) {
      return null;
    }

    const list = Array.isArray(refs) ? refs : [refs];
    if (list.length === 0) {
      return [];
    }

    const defaultNamespace = namespace == null ? this.#namespace : normalizeNamespace(namespace);

    const normalized = list.map(ref => {
      const entry = normalizeReference(ref);
      return {
        ...entry,
        effectiveNamespace: entry.namespace == null
          ? defaultNamespace
          : normalizeNamespace(entry.namespace)
      };
    });

    const output = new Array(normalized.length).fill(null);
    const groups = new Map();

    normalized.forEach((entry, index) => {
      const key = cacheKey(entry.effectiveNamespace, entry.body);
      if (this.#cache.has(key)) {
        output[index] = this.#cache.get(key);
        return;
      }

      const group = groups.get(entry.effectiveNamespace) || [];
      group.push({ entry, index });
      groups.set(entry.effectiveNamespace, group);
    });

    for (const [groupNamespace, members] of groups) {
      const resolved = await this.#resolveGroup(groupNamespace, members);
      if (resolved === null) {
        // Resolver became unavailable mid-flight; caller falls back wholesale rather
        // than acting on a half-resolved set.
        return null;
      }
      for (const { index, value } of resolved) {
        output[index] = value;
      }
    }

    return output;
  }

  async #resolveGroup(groupNamespace, members) {
    const body = members.map(({ entry }) => entry.body);

    let response;
    try {
      response = await this.#httpClient.post(RESOLVE_PATH, body, {
        params: { namespace: groupNamespace }
      });
    } catch (error) {
      return this.#handleError(error, groupNamespace, members);
    }

    const payload = Array.isArray(response?.data)
      ? response.data
      : response?.data == null
        ? []
        : [response.data];

    // Results are positional. If the count doesn't match we cannot know which result
    // belongs to which reference, so treat the whole group as unresolved rather than
    // silently attributing a resolution to the wrong canonical.
    if (payload.length !== members.length) {
      this.#logger.error(
        `[OCL] $resolveReference returned ${payload.length} result(s) for ${members.length} reference(s) in namespace ${groupNamespace}; discarding group to avoid misaligned results`
      );
      return members.map(({ entry, index }) => ({
        index,
        value: unresolved(groupNamespace, entry.body)
      }));
    }

    return members.map(({ entry, index }, position) => {
      const value = normalizeResult(payload[position], groupNamespace, entry.body);
      this.#cache.set(cacheKey(groupNamespace, entry.body), value);
      return { index, value };
    });
  }

  #handleError(error, groupNamespace, members) {
    const status = error?.response?.status;

    if (status === 404) {
      this.#disable('endpoint not implemented (404)');
      this.#logger.info(
        `[OCL] $resolveReference is not available on this instance (404); using repo paths instead`
      );
      return null;
    }

    if (status === 401 || status === 403) {
      this.#disable(`not authorised (${status})`);
      this.#logger.warn(
        `[OCL] $resolveReference rejected our credentials (${status}); using repo paths instead`
      );
      return null;
    }

    if (status === 400) {
      // Our request body is wrong — a bug on this side. Don't disable: a later,
      // well-formed batch may be fine.
      const detail = error?.response?.data?.detail || error.message;
      this.#logger.error(
        `[OCL] $resolveReference rejected the request body in namespace ${groupNamespace}: ${detail}`
      );
      return members.map(({ entry, index }) => ({
        index,
        value: unresolved(groupNamespace, entry.body)
      }));
    }

    this.#logger.warn(
      `[OCL] $resolveReference failed in namespace ${groupNamespace}: ${error.message}`
    );
    return null;
  }
}

module.exports = {
  OclReferenceResolver,
  normalizeNamespace,
  deriveNamespace,
  normalizeReference,
  isOclRepoPath,
  GLOBAL_NAMESPACE,
  RESOLVE_PATH
};
