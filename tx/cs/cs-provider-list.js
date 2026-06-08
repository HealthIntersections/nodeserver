const { AbstractCodeSystemProvider } = require('./cs-provider-api');

/**
 * Package-based ValueSet provider using shared database layer
 */
class ListCodeSystemProvider extends AbstractCodeSystemProvider {
  /**
   * {CodeSystem[]} The preloaded FHIR code systems in this list. This is an
   * array — append with .push(), not Map-style .set().
   */
  codeSystems = [];

  /**
   * ensure that the ids on the code systems are unique, if they are
   * in the global namespace
   *
   * @param {Set<String>} ids
   */
  // eslint-disable-next-line no-unused-vars
  assignIds(ids) {
    for (const cs of this.codeSystems) {
      if (!cs.id || ids.has("CodeSystem/"+cs.id)) {
        cs.id = ""+ids.size;
      }
      ids.add("CodeSystem/"+cs.id);
    }
  }


  // eslint-disable-next-line no-unused-vars
  async listCodeSystems(fhirVersion, context) {
    return this.codeSystems;
  }
}

module.exports = {
  ListCodeSystemProvider
};
