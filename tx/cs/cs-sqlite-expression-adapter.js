'use strict';

/**
 * Thin adapter that implements the binary SNOMED structures interface
 * backed by a v0 SQLite database, enabling SnomedExpressionParser and
 * SnomedExpressionServices to work without loading the .cache file.
 *
 * Uses concept_id (integer PK) as the "reference" in place of the
 * byte-offset indexes used by the binary format.
 */

const {
  SnomedExpressionParser,
  SnomedExpressionServices,
  SnomedExpressionContext,
  SnomedExpression,
  SnomedConcept,
  NO_REFERENCE,
  SnomedServicesRenderOption
} = require('../sct/expressions');

// ── Concepts adapter ────────────────────────────────────────────────
class SqliteConceptsAdapter {
  constructor(syncDb, csId) {
    this.db = syncDb;
    this.csId = csId;
    this._stmts = {};
  }

  _stmt(key, sql) {
    if (!this._stmts[key]) this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  /** Find concept by SCTID (string or BigInt). Returns { found, index: concept_id } */
  findConcept(identity) {
    const code = typeof identity === 'bigint' ? identity.toString() : String(identity);
    const row = this._stmt('find', `SELECT concept_id FROM concept WHERE cs_id = ? AND code = ?`).get(this.csId, code);
    return row ? { found: true, index: row.concept_id } : { found: false, index: 0 };
  }

  /** Get concept object by concept_id (our "reference"). */
  getConcept(conceptId) {
    const row = this._stmt('get', `SELECT concept_id, code, display, active FROM concept WHERE concept_id = ?`).get(conceptId);
    if (!row) throw new Error(`Concept reference ${conceptId} not found`);
    return {
      identity: BigInt(row.code),
      // flags bit 0 = primitive (assume primitive for all — expression services only
      // use this for normalisation which we don't need for basic validation/rendering)
      flags: 1,
      outbounds: conceptId, // pass-through; refs adapter intercepts
      inbounds: conceptId,
      parents: conceptId,
      descriptions: conceptId
    };
  }

  /** Get closure descendants ref — returns conceptId as the key for RefsAdapter. */
  getAllDesc(conceptId) {
    return -conceptId; // negative sentinel so RefsAdapter knows to query closure
  }

  /** Normal form not available from SQLite — expression services can skip. */
  getNormalForm(_conceptId) {
    return 0;
  }

  count() {
    const row = this._stmt('count', `SELECT COUNT(*) as cnt FROM concept WHERE cs_id = ?`).get(this.csId);
    return row ? row.cnt : 0;
  }
}

// ── Relationships adapter ───────────────────────────────────────────
class SqliteRelationshipsAdapter {
  constructor(syncDb, csId) {
    this.db = syncDb;
    this.csId = csId;
    this._stmts = {};
  }

  _stmt(key, sql) {
    if (!this._stmts[key]) this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  /** Get relationship by edge_id. */
  getRelationship(edgeId) {
    const row = this._stmt('get', `
      SELECT cl.source_concept_id, cl.target_concept_id, cl.group_id, cl.active,
             pd.property_code,
             (SELECT concept_id FROM concept WHERE cs_id = ? AND code = pd.property_code) as rel_type_concept_id
      FROM concept_link cl
      JOIN property_def pd ON cl.property_id = pd.property_id
      WHERE cl.edge_id = ?
    `).get(this.csId, edgeId);
    if (!row) throw new Error(`Relationship ${edgeId} not found`);
    return {
      source: row.source_concept_id,
      target: row.target_concept_id,
      relType: row.rel_type_concept_id,
      group: row.group_id,
      active: row.active === 1,
      defining: true // v0 schema only stores defining relationships
    };
  }
}

// ── References adapter ──────────────────────────────────────────────
class SqliteRefsAdapter {
  constructor(syncDb, csId, isAConceptId) {
    this.db = syncDb;
    this.csId = csId;
    this.isAConceptId = isAConceptId;
    this._stmts = {};
  }

  _stmt(key, sql) {
    if (!this._stmts[key]) this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  /**
   * getReferences is called with different "index" values:
   * - concept.outbounds (conceptId) → return edge_ids for outbound relationships
   * - concept.inbounds (conceptId) → return edge_ids for inbound relationships
   * - concept.parents (conceptId) → return parent concept_ids
   * - concept.descriptions (conceptId) → return designation pseudo-indexes
   * - getAllDesc result (negative conceptId) → return descendant concept_ids from closure
   *
   * Since we use the same conceptId for all, we need the calling context.
   * The expression services call patterns are predictable enough that we
   * handle this via a context stack.
   */
  getReferences(index) {
    // Negative sentinel = closure descendants query
    if (index < 0) {
      const ancestorId = -index;
      const rows = this._stmt('closure', `SELECT descendant_id FROM closure WHERE ancestor_id = ?`).all(ancestorId);
      return rows.map(r => r.descendant_id);
    }

    // For positive indexes, we need to figure out what's being asked.
    // The expression services code always calls in this pattern:
    //   concept.outbounds → getReferences → iterate → getRelationship
    //   concept.parents → getReferences → iterate (concept_ids)
    //   concept.descriptions → getReferences → getDescription
    //   concept.inbounds → getReferences → iterate → getRelationship
    // Since we set all to conceptId, we use the _contextHint set by callers.
    const conceptId = index;
    switch (this._contextHint) {
      case 'outbounds':
        return this._getOutboundEdgeIds(conceptId);
      case 'inbounds':
        return this._getInboundEdgeIds(conceptId);
      case 'parents':
        return this._getParentConceptIds(conceptId);
      case 'descriptions':
        return this._getDescriptionIndexes(conceptId);
      default:
        // Default: try outbounds (most common usage in expression services)
        return this._getOutboundEdgeIds(conceptId);
    }
  }

  _getOutboundEdgeIds(conceptId) {
    const rows = this._stmt('outEdges', `
      SELECT edge_id FROM concept_link WHERE source_concept_id = ? AND active = 1
    `).all(conceptId);
    return rows.map(r => r.edge_id);
  }

  _getInboundEdgeIds(conceptId) {
    const rows = this._stmt('inEdges', `
      SELECT edge_id FROM concept_link WHERE target_concept_id = ? AND active = 1
    `).all(conceptId);
    return rows.map(r => r.edge_id);
  }

  _getParentConceptIds(conceptId) {
    const isAPropId = this._getIsAPropId();
    if (!isAPropId) return [];
    const rows = this._stmt('parents', `
      SELECT target_concept_id FROM concept_link
      WHERE source_concept_id = ? AND property_id = ? AND active = 1
    `).all(conceptId, isAPropId);
    return rows.map(r => r.target_concept_id);
  }

  _getDescriptionIndexes(conceptId) {
    const rows = this._stmt('desigIds', `
      SELECT designation_id FROM designation WHERE concept_id = ? AND active = 1
      ORDER BY preferred DESC
    `).all(conceptId);
    return rows.map(r => r.designation_id);
  }

  _getIsAPropId() {
    if (this._isAPropId !== undefined) return this._isAPropId;
    const row = this._stmt('isAProp', `
      SELECT property_id FROM property_def WHERE cs_id = ? AND is_hierarchy = 1
    `).get(this.csId);
    this._isAPropId = row ? row.property_id : null;
    return this._isAPropId;
  }
}

// ── Descriptions adapter ────────────────────────────────────────────
class SqliteDescriptionsAdapter {
  constructor(syncDb) {
    this.db = syncDb;
    this._stmts = {};
  }

  _stmt(key, sql) {
    if (!this._stmts[key]) this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  /** Get designation by designation_id. */
  getDescription(designationId) {
    const row = this._stmt('get', `
      SELECT designation_id, active, language_code, term, preferred FROM designation WHERE designation_id = ?
    `).get(designationId);
    if (!row) return { active: false, lang: 0, iDesc: 0 };
    return {
      active: row.active === 1,
      lang: row.language_code === 'en' ? 1 : 0,
      iDesc: designationId, // pass-through for strings adapter
      _term: row.term, // direct access shortcut
      _preferred: row.preferred
    };
  }

  count() {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM designation`).get();
    return row ? row.cnt : 0;
  }
}

// ── Strings adapter ─────────────────────────────────────────────────
class SqliteStringsAdapter {
  constructor(syncDb) {
    this.db = syncDb;
    this._stmts = {};
  }

  _stmt(key, sql) {
    if (!this._stmts[key]) this._stmts[key] = this.db.prepare(sql);
    return this._stmts[key];
  }

  /** Get term text by designation_id (since iDesc = designation_id). */
  getEntry(designationId) {
    if (!designationId) return '';
    const row = this._stmt('get', `SELECT term FROM designation WHERE designation_id = ?`).get(designationId);
    return row ? row.term : '';
  }

  get length() {
    return 1; // Non-zero to pass existence checks
  }
}

// ── Patched ExpressionServices that uses context hints ───────────────

/**
 * Subclass of SnomedExpressionServices that sets _contextHint on the refs
 * adapter before calling methods that read concept.outbounds/parents/etc.
 */
class SqliteExpressionServices extends SnomedExpressionServices {
  constructor(structures, isAConceptId) {
    super(structures, isAConceptId);
  }

  getDefiningRelationships(conceptIndex) {
    this.refs._contextHint = 'outbounds';
    try { return super.getDefiningRelationships(conceptIndex); }
    finally { this.refs._contextHint = null; }
  }

  getConceptParents(reference) {
    this.refs._contextHint = 'parents';
    try { return super.getConceptParents(reference); }
    finally { this.refs._contextHint = null; }
  }

  getConceptChildren(reference) {
    this.refs._contextHint = 'inbounds';
    try { return super.getConceptChildren(reference); }
    finally { this.refs._contextHint = null; }
  }

  listDisplayNames(conceptIndex, languageFilter = 0) {
    this.refs._contextHint = 'descriptions';
    try { return super.listDisplayNames(conceptIndex, languageFilter); }
    finally { this.refs._contextHint = null; }
  }

  /** Override subsumes to use closure table directly. */
  subsumes(a, b) {
    if (a === b) return true;
    const closureRef = this.concepts.getAllDesc(a);
    const descendants = this.refs.getReferences(closureRef);
    return descendants.includes(b);
  }
}

// ── Factory function ────────────────────────────────────────────────

/**
 * Create expression services backed by a v0 SQLite database.
 * @param {object} syncDb - better-sqlite3 database connection
 * @param {number} csId - code_system cs_id in the v0 database
 * @returns {{ expressionServices, parser, ExpressionContext }}
 */
function createSqliteExpressionServices(syncDb, csId) {
  // Find the is-a property concept_id
  const isAPropRow = syncDb.prepare(
    `SELECT property_code FROM property_def WHERE cs_id = ? AND is_hierarchy = 1`
  ).get(csId);

  let isAConceptId = NO_REFERENCE;
  if (isAPropRow) {
    const conceptRow = syncDb.prepare(
      `SELECT concept_id FROM concept WHERE cs_id = ? AND code = ?`
    ).get(csId, isAPropRow.property_code);
    if (conceptRow) isAConceptId = conceptRow.concept_id;
  }

  const concepts = new SqliteConceptsAdapter(syncDb, csId);
  const relationships = new SqliteRelationshipsAdapter(syncDb, csId);
  const refs = new SqliteRefsAdapter(syncDb, csId, isAConceptId);
  const descriptions = new SqliteDescriptionsAdapter(syncDb);
  const strings = new SqliteStringsAdapter(syncDb);

  const structures = {
    concepts,
    relationships,
    refs,
    descriptions,
    strings,
    // Unused by expression services but required by constructor:
    words: null,
    stems: null,
    descriptionIndex: null,
    refSetMembers: null,
    refSetIndex: null
  };

  const expressionServices = new SqliteExpressionServices(structures, isAConceptId);
  const parser = new SnomedExpressionParser(concepts);

  return { expressionServices, parser };
}

module.exports = {
  createSqliteExpressionServices,
  SqliteExpressionServices,
  SqliteConceptsAdapter,
  SqliteRelationshipsAdapter,
  SqliteRefsAdapter,
  SqliteDescriptionsAdapter,
  SqliteStringsAdapter
};
