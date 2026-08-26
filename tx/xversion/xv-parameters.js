const {VersionUtilities} = require("../../library/version-utilities");

/**
 * Converts input Parameters to R5 format (modifies input object for performance)
 * @param {Object} jsonObj - The input Parameters object
 * @param {string} version - Source FHIR version
 * @returns {Object} The same object, potentially modified to R5 format
 * @private
 */

function parametersToR5(jsonObj, sourceVersion) {
  if (VersionUtilities.isR5Ver(sourceVersion)) {
    if (jsonObj.parameter && jsonObj.parameter.find(p => p.name == 'match')) {
      return convertResourceWithinR5(JSON.parse(JSON.stringify(jsonObj)));
    } else {
      return jsonObj; // No conversion needed
    }
  }

  const {convertResourceToR5} = require("./xv-resource");
  for (let p of jsonObj.parameter || []) {
    if (p.resource) {
      p.resource = convertResourceToR5(p.resource, sourceVersion);
    }
  }
  return jsonObj;
}

/**
 * Converts R5 Parameters to target version format (clones object first)
 * @param {Object} r5Obj - The R5 format Parameters object
 * @param {string} targetVersion - Target FHIR version
 * @returns {Object} New object in target version format
 * @private
 */
function parametersFromR5(r5Obj, targetVersion) {
  if (VersionUtilities.isR5Ver(targetVersion)) {
    return r5Obj; // No conversion needed
  }

  // Clone the object to avoid modifying the original
  const cloned = JSON.parse(JSON.stringify(r5Obj));

  if (VersionUtilities.isR4Ver(targetVersion)) {
    return parametersR5ToR4(cloned);
  } else if (VersionUtilities.isR3Ver(targetVersion)) {
    return parametersR5ToR3(cloned);
  }

  throw new Error(`Unsupported target FHIR version: ${targetVersion}`);
}

/**
 * Converts R5 Parameters to R4 format
 * @param {Object} r5Obj - Cloned R5 Parameters object
 * @returns {Object} R4 format Parameters
 * @private
 */
function parametersR5ToR4(r5Obj) {
  const {convertResourceFromR5} = require("./xv-resource");

  for (let p of r5Obj.parameter || []) {
    if (p.resource) {
      p.resource = convertResourceFromR5(p.resource, "R4");
    }
    if (p.name == 'match') {
      fixMatchParameterfor4(p);
    }
  }
  return r5Obj;
}

function convertResourceWithinR5(r5Obj) {
  for (let p of r5Obj.parameter || []) {
    if (p.name == 'match') {
      fixMatchParameterfor5(p);
    }
  }
  return r5Obj;

}

function fixMatchParameterfor5(p) {
  if (p.part) {
    p.part = p.part.filter(pp => pp.name !== 'equivalence');
  }
}

function fixMatchParameterfor4(p) {
  if (p.part) {
    // R4 calls originMap 'source'. originMap is reported in every version; source is added
    // here for R4 only, and is prohibited everywhere else
    if (!p.part.find(pp => pp.name === 'source')) {
      let om = p.part.find(pp => pp.name === 'originMap');
      if (om && om.valueCanonical) {
        p.part.push({name: "source", valueCanonical: om.valueCanonical});
      }
    }
    if (!p.part.find(pp => pp.name === 'equivalence')) {
      let rel = p.part.find(pp => pp.name === 'relationship');
      if (rel && rel.valueCode) {
        let pp = {name: "equivalence"};
        switch (rel.valueCode) {
          case 'related-to':
            pp.valueCode = 'relatedto';
            break;
          case 'equivalent':
            pp.valueCode = 'equivalent';
            break;
          case 'source-is-narrower-than-target':
            pp.valueCode = 'wider';
            break;
          case 'source-is-broader-than-target':
            pp.valueCode = 'narrower';
            break;
          case 'not-related-to':
            pp.valueCode = 'unmatched';
            break;
        }
        p.part.push(pp);
      }
    }
    p.part = p.part.filter(pp => pp.name !== 'relationship');
  }
}

function convertParameterR5ToR3(p) {
  if (p.valueCanonical) {
    p.valueUri = p.valueCanonical;
    delete p.valueCanonical;
  }
  for (const pp of p.part || []) {
    convertParameterR5ToR3(pp)
  }
}

/**
 * Converts R5 Parameters to R3 format
 * @param {Object} r5Obj - Cloned R5 Parameters object
 * @returns {Object} R3 format Parameters
 * @private
 */
function parametersR5ToR3(r5Obj) {
  const {convertResourceFromR5} = require("./xv-resource");

  for (let p of r5Obj.parameter || []) {
    if (p.resource) {
      p.resource = convertResourceFromR5(p.resource, "R3");
    }
    convertParameterR5ToR3(p);
  }
  return r5Obj;
}

module.exports = { parametersToR5, parametersFromR5 };